const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'banco.db');

let db;

function conectarBanco() {
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('Erro ao conectar ao banco SQLite:', err.message);
            setTimeout(conectarBanco, 3000);
        } else {
            console.log('Conectado ao banco SQLite (banco.db).');
        }
    });
}

conectarBanco();

db.serialize(() => {
    db.run(`PRAGMA foreign_keys = ON;`);

    // Tabela Turmas com a coluna codigo_acesso (Hash único)
    db.run(`
        CREATE TABLE IF NOT EXISTS Turmas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome_turma TEXT NOT NULL UNIQUE,
            codigo_acesso TEXT UNIQUE
        )
    `);

    // Tabela Publicacoes
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