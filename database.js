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
    console.log(caminhoConfigurado
        ? 'Conectado ao SQLite externo configurado.'
        : 'Conectado ao SQLite local legado (banco.db).');
});

db.serialize(() => {
    db.run(`PRAGMA foreign_keys = ON;`);

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
