const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const caminhoConfigurado = Object.prototype.hasOwnProperty.call(process.env, 'MURAL_DB_PATH');

function dentroDoDiretorio(raiz, alvo) {
    const relativo = path.relative(raiz, alvo);
    return relativo === '' ||
        (relativo !== '..' && !relativo.startsWith('..' + path.sep) && !path.isAbsolute(relativo));
}

function resolverCaminhoBanco() {
    // Preserva a instalação local existente, inclusive a criação do primeiro banco.
    if (!caminhoConfigurado) return path.resolve(__dirname, 'banco.db');

    const informado = process.env.MURAL_DB_PATH;
    if (!informado || !path.isAbsolute(informado)) {
        throw new Error('MURAL_DB_PATH deve informar um arquivo SQLite por caminho absoluto.');
    }

    // Não criar diretórios/bancos automaticamente em um destino configurado errado.
    const diretorio = path.dirname(informado);
    let pastaReal;
    try {
        pastaReal = fs.realpathSync(diretorio);
        if (!fs.statSync(pastaReal).isDirectory()) throw new Error('not a directory');
    } catch {
        throw new Error('MURAL_DB_PATH: diretório de dados inexistente ou inacessível.');
    }

    const projetoReal = fs.realpathSync(__dirname);
    if (dentroDoDiretorio(projetoReal, pastaReal)) {
        throw new Error('MURAL_DB_PATH deve ficar fora do checkout do projeto.');
    }

    let dados;
    try {
        dados = fs.lstatSync(informado);
    } catch {
        throw new Error('MURAL_DB_PATH: banco não encontrado; prepare ou migre o arquivo antes de iniciar.');
    }
    if (dados.isSymbolicLink() || !dados.isFile()) {
        throw new Error('MURAL_DB_PATH deve apontar para um arquivo regular, não um link simbólico.');
    }

    // Valida os caminhos reais e as permissões antes de abrir o banco.
    if (dentroDoDiretorio(projetoReal, fs.realpathSync(informado))) {
        throw new Error('MURAL_DB_PATH não pode resolver para dentro do checkout.');
    }
    try {
        fs.accessSync(pastaReal, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
        fs.accessSync(informado, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
        throw new Error('MURAL_DB_PATH: permissões insuficientes para leitura e gravação.');
    }

    // Um arquivo vazio existe, mas OPEN_READWRITE não impede que o SQLite o
    // inicialize ao executar CREATE TABLE. Recusar antes de abrir a conexão.
    if (dados.size < 100) {
        throw new Error('MURAL_DB_PATH: banco SQLite vazio ou incompleto; inicialização externa deve ser explícita.');
    }
    const cabecalho = Buffer.alloc(16);
    let fd;
    try {
        fd = fs.openSync(informado, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        if (fs.readSync(fd, cabecalho, 0, cabecalho.length, 0) !== cabecalho.length ||
            !cabecalho.equals(Buffer.from('SQLite format 3\0'))) {
            throw new Error('arquivo não SQLite');
        }
    } catch {
        throw new Error('MURAL_DB_PATH: arquivo não é um banco SQLite válido.');
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    return informado;
}

const dbPath = resolverCaminhoBanco();
const modo = caminhoConfigurado
    ? sqlite3.OPEN_READWRITE
    : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;

const db = new sqlite3.Database(dbPath, modo, (err) => {
    if (err) {
        console.error('Erro ao abrir o SQLite:', err.code || 'falha de acesso.');
        process.exit(1);
    }
    if (!caminhoConfigurado) console.log('Conectado ao SQLite local legado (banco.db).');
});

db.serialize(() => {
    db.run(`PRAGMA foreign_keys = ON;`);

    if (caminhoConfigurado) {
        // No modo externo, somente validação: NUNCA criar ou modificar o esquema.
        const recusar = (motivo) => {
            console.error('MURAL_DB_PATH: banco externo inválido (' + motivo + ').');
            process.exit(1);
        };
        db.get('PRAGMA quick_check', (err, row) => {
            if (err || !row || row.quick_check !== 'ok') recusar('integridade');
        });
        const camposObrigatorios = {
            Turmas: ['id', 'nome_turma', 'codigo_acesso'],
            Publicacoes: ['id', 'titulo', 'descricao', 'data', 'tipo', 'imagem_url', 'turma_id']
        };
        for (const [tabela, campos] of Object.entries(camposObrigatorios)) {
            db.all('PRAGMA table_info("' + tabela + '")', (err, rows) => {
                if (err || !rows || !campos.every(campo => rows.some(coluna => coluna.name === campo))) {
                    recusar('esquema ' + tabela);
                }
            });
        }
        db.all('PRAGMA foreign_key_list("Publicacoes")', (err, rows) => {
            if (err || !rows || !rows.some(fk => fk.from === 'turma_id' && fk.table === 'Turmas')) {
                recusar('relacionamento de turma');
            }
        });
        db.get('PRAGMA foreign_key_check', (err, row) => {
            if (err || row) recusar('referências');
        });
        db.get('SELECT COUNT(*) AS total FROM Turmas', (err) => {
            if (err) recusar('consulta de turmas');
            console.log('Conectado ao SQLite externo validado.');
        });
        return;
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS Turmas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome_turma TEXT NOT NULL UNIQUE,
            codigo_acesso TEXT UNIQUE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS Publicacoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            titulo TEXT NOT NULL,
            descricao TEXT,
            data TEXT NOT NULL,
            tipo TEXT NOT NULL,
            imagem_url TEXT,
            turma_id INTEGER,
            FOREIGN KEY (turma_id) REFERENCES Turmas (id) ON DELETE CASCADE
        )
    `);
});

module.exports = db;
