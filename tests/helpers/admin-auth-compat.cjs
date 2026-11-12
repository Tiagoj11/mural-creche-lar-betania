'use strict';
// Adaptador SOMENTE para E2E descartável: preserva testes legados enquanto
// permite executar o MESMO cenário em código com autenticação por cookie.
// NÃO é helper de autenticação do produto ou migração de banco real.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const hasAuth = sourceRoot => fs.existsSync(path.join(sourceRoot, 'admin-auth.js'));
async function migrateFixture(sourceRoot, checkout, dbPath) {
    fs.copyFileSync(path.join(sourceRoot, 'admin-auth.js'),
        path.join(checkout, 'admin-auth.js'));
    fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, 'scripts', 'migrate-admin-auth.js'),
        path.join(checkout, 'scripts', 'migrate-admin-auth.js'));
    const db = await new Promise((resolve, reject) => {
        const c = new sqlite3.Database(dbPath, err => err ? reject(err) : resolve(c));
    });
    try {
        for (const sql of [
            'CREATE TABLE Turmas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome_turma TEXT NOT NULL UNIQUE, codigo_acesso TEXT UNIQUE)',
            'CREATE TABLE Publicacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL, descricao TEXT, data TEXT NOT NULL, tipo TEXT NOT NULL, imagem_url TEXT, turma_id INTEGER, FOREIGN KEY(turma_id) REFERENCES Turmas(id) ON DELETE CASCADE)'
        ]) {
            await new Promise((resolve, reject) =>
                db.run(sql, err => err ? reject(err) : resolve()));
        }
    } finally {
        await new Promise((resolve, reject) =>
            db.close(err => err ? reject(err) : resolve()));
    }
    const migrate = spawnSync(process.execPath,
        ['scripts/migrate-admin-auth.js', '--db', dbPath],
        { cwd: checkout, encoding: 'utf8', timeout: 20000 });
    if (migrate.status !== 0)
        throw new Error('Migração de fixture AUTH falhou: ' +
            (migrate.stderr || migrate.stdout || 'sem diagnóstico'));
    return dbPath;
}
async function bootstrap(base, token, password) {
    const response = await fetch(base + '/api/admin/auth/bootstrap', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_inicial: token, nova_senha: password }),
        signal: AbortSignal.timeout(10000)
    });
    if (response.status !== 201) {
        const status = response.status;
        throw new Error('Bootstrap fictício inválido no teste: HTTP ' + status);
    }
}
async function login(base, password) {
    const response = await fetch(base + '/api/admin/auth/login', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha: password }),
        signal: AbortSignal.timeout(10000)
    });
    if (response.status !== 200)
        throw new Error('Login fictício falhou: HTTP ' + response.status);
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    if (!/^mural_admin_sid=[0-9a-f]{64}$/.test(cookie || ''))
        throw new Error('Cookie de sessão da fixture ausente ou inválido');
    const session = await fetch(base + '/api/admin/auth/session', {
        headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000)
    });
    if (session.status !== 200)
        throw new Error('Sessão fictícia falhou: HTTP ' + session.status);
    const result = await session.json();
    if (!/^[0-9a-f]{64}$/.test(result.csrf_token || ''))
        throw new Error('CSRF da fixture inválido');
    return { cookie, csrf: result.csrf_token };
}
module.exports = { hasAuth, migrateFixture, bootstrap, login };
