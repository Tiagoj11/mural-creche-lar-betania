require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use(express.urlencoded({ extended: true }));

/**
 * Função utilitária para gerar hash aleatório único de 6 caracteres (Ex: f7k9p2)
 */
function gerarHashUnico() {
    return crypto.randomBytes(3).toString('hex');
}

/**
 * Middleware de Autenticação Administrativa
 * Verifica se a senha enviada no header 'Authorization' confere com o .env
 */
const autenticarAdmin = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== process.env.ADMIN_SECRET_KEY) {
        return res.status(401).json({ erro: 'Acesso não autorizado.' });
    }
    next();
};

/**
 * Configuração do Multer para armazenamento local de imagens.
 * Um caminho absoluto evita problemas ao iniciar o Node fora da pasta do projeto.
 */
// O diretório de imagens deve sobreviver a atualizações do checkout.
const destinoConfigurado = process.env.MURAL_UPLOAD_DIR;
if (destinoConfigurado && !path.isAbsolute(destinoConfigurado)) {
    throw new Error('MURAL_UPLOAD_DIR deve ser um caminho absoluto.');
}
const uploadDir = destinoConfigurado || path.join(os.homedir(), 'Downloads', 'Mural Creche');
const caminhoRelativo = path.relative(__dirname, uploadDir);
if (!caminhoRelativo || (!caminhoRelativo.startsWith('..' + path.sep) && caminhoRelativo !== '..' && !path.isAbsolute(caminhoRelativo))) {
    throw new Error('MURAL_UPLOAD_DIR deve ficar fora do diretório do projeto.');
}
fs.mkdirSync(uploadDir, { recursive: true });
const uploadDirLegado = path.join(__dirname, 'public', 'uploads');

const extensoesPermitidas = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif'
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Evita depender do nome original, que pode conter caracteres problemáticos.
        const nomeUnico = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
        cb(null, nomeUnico + extensoesPermitidas[file.mimetype]);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        if (!Object.hasOwn(extensoesPermitidas, file.mimetype)) {
            const err = new Error('Formato de imagem não permitido. Use JPG, PNG, GIF, WebP ou AVIF.');
            err.status = 400;
            return cb(err);
        }
        cb(null, true);
    }
});

// Arquivos só são servidos se estão vinculados a uma publicação no SQLite.
// Preserva URLs já cadastradas e faz fallback de leitura ao diretório legado.
app.get('/uploads/:nome', (req, res) => {
    const nome = req.params.nome;
    if (!/^[A-Za-z0-9_-]{1,180}\.(?:jpe?g|png|gif|webp|avif)$/i.test(nome)) {
        return res.status(404).json({ erro: 'Imagem não encontrada.' });
    }
    db.get('SELECT 1 FROM Publicacoes WHERE imagem_url = ? LIMIT 1', ['/uploads/' + nome], (err, registro) => {
        if (err) return res.status(500).json({ erro: 'Erro ao consultar imagem.' });
        if (!registro) return res.status(404).json({ erro: 'Imagem não encontrada.' });

        const diretorios = [uploadDir, uploadDirLegado];
        const servir = (i) => {
            if (i === diretorios.length) return res.status(404).json({ erro: 'Imagem não encontrada.' });
            fs.stat(path.join(diretorios[i], nome), (statErr, stats) => {
                if (statErr || !stats.isFile()) return servir(i + 1);
                return res.sendFile(nome, { root: diretorios[i], dotfiles: 'deny' }, sendErr => {
                    if (sendErr && !res.headersSent) {
                        return res.status(404).json({ erro: 'Imagem não encontrada.' });
                    }
                });
            });
        };
        servir(0);
    });
});
// Bloqueia URLs de arquivos não cadastrados mesmo se presentes em public/uploads.
app.use('/uploads', (req, res) => res.status(404).json({ erro: 'Imagem não encontrada.' }));
app.use(express.static(path.join(__dirname, 'public')));

// Geral não equivale a tipo ou a uma turma fictícia.
function validarDestino(body, callback) {
    if (body.destino === 'geral') return callback(null, null);
    if (body.destino !== undefined && body.destino !== 'turma') {
        return callback({ status: 400, erro: 'Destino inválido. Use geral ou turma.' });
    }
    const valor = body.turma_id;
    if (!/^[1-9]\d*$/.test(String(valor ?? '')) || !Number.isSafeInteger(Number(valor))) {
        return callback({ status: 400, erro: 'Selecione uma turma válida.' });
    }
    db.get('SELECT id FROM Turmas WHERE id = ?', [Number(valor)], (err, turma) => {
        if (err) return callback({ status: 500, erro: 'Erro ao validar a turma.' });
        if (!turma) return callback({ status: 400, erro: 'Turma não encontrada.' });
        callback(null, turma.id);
    });
}
function descartarImagemNova(req) {
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
}

// ==============================================================================
// ROTAS DA API
// ==============================================================================

/**
 * GET /api/turmas
 * Retorna a lista de todas as turmas cadastradas (para popular o select dinâmico no admin).
 */
app.get('/api/turmas', autenticarAdmin, (req, res) => {
    const sql = `SELECT id, nome_turma, codigo_acesso FROM Turmas ORDER BY nome_turma ASC`;
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Erro ao buscar turmas:', err.message);
            return res.status(500).json({ erro: 'Erro ao buscar turmas no banco de dados.' });
        }
        res.json(rows);
    });
});

/**
 * POST /api/turmas
 * Protegido. Cadastra uma nova turma com código de acesso hash único.
*/
app.post('/api/turmas', autenticarAdmin, (req, res) => {
    const { nome_turma } = req.body;
    if (!nome_turma) {
        return res.status(400).json({ erro: 'O nome da turma é obrigatório.' });
    }
    const codigo_acesso = gerarHashUnico();
    const sql = `INSERT INTO Turmas (nome_turma, codigo_acesso) VALUES (?, ?)`;
    db.run(sql, [nome_turma, codigo_acesso], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE')) {
                return res.status(400).json({ erro: 'Uma turma com esse nome já existe.' });
            }
            return res.status(500).json({ erro: 'Erro ao cadastrar turma no banco de dados.' });
        }
        res.status(201).json({
            mensagem: 'Turma cadastrada com sucesso!',
            id: this.lastID,
            nome_turma,
            codigo_acesso
        });
    });
});
 
/**
 * GET /api/admin/publicacoes
 * Retorna todas as publicações para gerenciamento, sem expor códigos de acesso.
 */
app.get('/api/admin/publicacoes', autenticarAdmin, (req, res) => {
    const sql = `
        SELECT p.id, p.titulo, p.descricao, p.data, p.tipo,
               p.imagem_url, p.turma_id, t.nome_turma
        FROM Publicacoes p
        LEFT JOIN Turmas t ON p.turma_id = t.id
        ORDER BY p.id DESC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Erro ao buscar publicações administrativas:', err.message);
            return res.status(500).json({ erro: 'Erro ao buscar publicações no banco de dados.' });
        }
        res.json(rows);
    });
});

/**
 * GET /api/publicacoes/token/:codigo
 * Valida o token/hash da turma e retorna as publicações daquela turma + avisos "Geral".
 */
app.get('/api/publicacoes/token/:codigo', (req, res) => {
    const { codigo } = req.params;
    const sqlTurma = `SELECT id, nome_turma FROM Turmas WHERE codigo_acesso = ?`;

    db.get(sqlTurma, [codigo], (err, turma) => {
        if (err) return res.status(500).json({ erro: 'Erro ao consultar o banco de dados.' });
        if (!turma) return res.status(404).json({ erro: 'Link inválido ou turma não encontrada.' });

        const sqlPubs = `
            SELECT p.id, p.titulo, p.descricao, p.data, p.tipo, p.imagem_url, p.turma_id, t.nome_turma 
            FROM Publicacoes p
            LEFT JOIN Turmas t ON p.turma_id = t.id
            WHERE p.turma_id = ? OR p.turma_id IS NULL
            ORDER BY p.id DESC
        `;

        db.all(sqlPubs, [turma.id], (err, rows) => {
            if (err) return res.status(500).json({ erro: 'Erro ao buscar publicações.' });
            res.json({
                nome_turma: turma.nome_turma,
                publicacoes: rows
            });
        });
    });
});

/**
 * POST /api/publicacoes
 * Protegido. Cria uma nova publicação vinculada a uma turma existente (via turma_id).
 */
app.post('/api/publicacoes', autenticarAdmin, upload.single('imagem'), (req, res) => {
    const { titulo, descricao, data, tipo } = req.body || {};
    if (![titulo, data, tipo].every(campo => typeof campo === 'string' && campo.trim())) {
        descartarImagemNova(req);
        return res.status(400).json({ erro: 'Campos obrigatórios ausentes: título, data e tipo.' });
    }
    validarDestino(req.body, (falha, turmaId) => {
        if (falha) {
            descartarImagemNova(req);
            return res.status(falha.status).json({ erro: falha.erro });
        }
        const imagemUrl = req.file ? '/uploads/' + req.file.filename : null;
        db.run(
            'INSERT INTO Publicacoes (titulo, descricao, data, tipo, imagem_url, turma_id) VALUES (?, ?, ?, ?, ?, ?)',
            [titulo, descricao, data, tipo, imagemUrl, turmaId],
            function (err) {
                if (err) {
                    descartarImagemNova(req);
                    return res.status(500).json({ erro: 'Erro ao salvar publicação no banco de dados.' });
                }
                res.status(201).json({ mensagem: 'Publicação criada com sucesso!', id: this.lastID, imagem_url: imagemUrl });
            }
        );
    });
});

/**
 * PUT /api/publicacoes/:id
 * Protegido. Edita uma publicação existente (atualizando dados e opcionalmente a imagem).
 */
app.put('/api/publicacoes/:id', autenticarAdmin, upload.single('imagem'), (req, res) => {
    const { titulo, descricao, data, tipo } = req.body || {};
    if (![titulo, data, tipo].every(campo => typeof campo === 'string' && campo.trim())) {
        descartarImagemNova(req);
        return res.status(400).json({ erro: 'Campos obrigatórios ausentes: título, data e tipo.' });
    }
    validarDestino(req.body, (falha, turmaId) => {
        if (falha) {
            descartarImagemNova(req);
            return res.status(falha.status).json({ erro: falha.erro });
        }
        const novaImagemUrl = req.file ? '/uploads/' + req.file.filename : null;
        const comImagem = Boolean(novaImagemUrl);
        const sql = comImagem
            ? 'UPDATE Publicacoes SET titulo=?, descricao=?, data=?, tipo=?, turma_id=?, imagem_url=? WHERE id=?'
            : 'UPDATE Publicacoes SET titulo=?, descricao=?, data=?, tipo=?, turma_id=? WHERE id=?';
        const params = [titulo, descricao, data, tipo, turmaId];
        if (comImagem) params.push(novaImagemUrl);
        params.push(req.params.id);
        db.run(sql, params, function (err) {
            if (err) {
                descartarImagemNova(req);
                return res.status(500).json({ erro: 'Erro ao atualizar publicação.' });
            }
            if (this.changes === 0) {
                descartarImagemNova(req);
                return res.status(404).json({ erro: 'Publicação não encontrada.' });
            }
            res.json(comImagem
                ? { mensagem: 'Publicação atualizada com sucesso!', imagem_url: novaImagemUrl }
                : { mensagem: 'Publicação atualizada com sucesso!' });
        });
    });
});

/**
 * DELETE /api/publicacoes/:id
 * Protegido. Remove permanentemente uma publicação pelo ID.
 */
app.delete('/api/publicacoes/:id', autenticarAdmin, (req, res) => {
    const { id } = req.params;
    const sql = `DELETE FROM Publicacoes WHERE id = ?`;

    db.run(sql, [id], function (err) {
        if (err) {
            console.error('Erro ao deletar publicação:', err.message);
            return res.status(500).json({ erro: 'Erro ao excluir a publicação.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ erro: 'Publicação não encontrada.' });
        }
        res.json({ mensagem: 'Publicação excluída com sucesso!' });
    });
});

// Rotas inexistentes da API também retornam JSON (e não HTML).
app.use('/api', (req, res) => {
    return res.status(404).json({ erro: 'Rota da API não encontrada.' });
});

// Este middleware precisa ficar DEPOIS das rotas para capturar falhas do Multer.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    console.error('Erro na requisição:', err);

    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ erro: 'A imagem ultrapassa o limite de 10 MB.' });
        }
        return res.status(400).json({ erro: `Erro no upload: ${err.message}` });
    }

    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ erro: 'Payload JSON malformado ou inválido.' });
    }

    if (err.status === 400) {
        return res.status(400).json({ erro: err.message });
    }

    return res.status(500).json({ erro: 'Erro interno do servidor. Consulte o terminal.' });
});

// Inicialização do Servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log(`Pasta de imagens: ${uploadDir}`);
});