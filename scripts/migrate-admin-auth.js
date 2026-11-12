#!/usr/bin/env node
'use strict';
// Migrador OFFLINE e explícito de MELHORIA-ADM-AUTH-001.
// Não executar contra dados reais sem autorização operacional separada.
// Exemplo apenas com fixture: node scripts/migrate-admin-auth.js --db /tmp/fixture/mural.db

const path = require('node:path');
const fs = require('node:fs');
const sqlite3 = require('sqlite3').verbose();
const AUTH_VERSION = 101;
const statements = [
    'CREATE TABLE AdminCredencial (id INTEGER PRIMARY KEY CHECK(id=1), senha_hash BLOB NOT NULL CHECK(length(senha_hash)=64), salt BLOB NOT NULL CHECK(length(salt)>=16), kdf TEXT NOT NULL CHECK(kdf="scrypt"), parametros_versao INTEGER NOT NULL CHECK(parametros_versao>=1), criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL, geracao_sessao INTEGER NOT NULL DEFAULT 0)',
    'CREATE TABLE AdminSessoes (sid_digest BLOB PRIMARY KEY CHECK(length(sid_digest)=32), admin_id INTEGER NOT NULL DEFAULT 1 REFERENCES AdminCredencial(id), csrf_digest BLOB NOT NULL CHECK(length(csrf_digest)=32), criado_em INTEGER NOT NULL, ultimo_uso_em INTEGER NOT NULL, expira_absoluto_em INTEGER NOT NULL, geracao_sessao INTEGER NOT NULL, revogado_em INTEGER, CHECK(expira_absoluto_em>criado_em))',
    'CREATE INDEX idx_admin_sessoes_validade ON AdminSessoes (admin_id, revogado_em, expira_absoluto_em)'
];
function openReadWrite(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE,
            err => err ? reject(err) : resolve(db));
    });
}
function get(db, sql, args = []) {
    return new Promise((resolve, reject) => db.get(sql, args, (err, row) =>
        err ? reject(err) : resolve(row)));
}
function all(db, sql, args = []) {
    return new Promise((resolve, reject) => db.all(sql, args, (err, rows) =>
        err ? reject(err) : resolve(rows)));
}
function run(db, sql) {
    return new Promise((resolve, reject) => db.run(sql, err => err ? reject(err) : resolve()));
}
function close(db) {
    return new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
}
function checkFile(filename) {
    if (!filename || !path.isAbsolute(filename))
        throw new Error('Informe --db com caminho absoluto de arquivo SQLite já existente.');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100)
        throw new Error('Banco não é arquivo SQLite regular e não vazio.');
    const f = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const header = Buffer.alloc(16);
    try {
        if (fs.readSync(f, header, 0, 16, 0) !== 16 ||
            !header.equals(Buffer.from('SQLite format 3\0')))
            throw new Error('Cabeçalho SQLite inválido.');
    } finally { fs.closeSync(f); }
    const repo = fs.realpathSync(path.join(__dirname, '..'));
    const real = fs.realpathSync(filename);
    const rel = path.relative(repo, real);
    if (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
        throw new Error('Migração apenas com banco fora do checkout.');
}
async function validateBase(db) {
    const ok = await get(db, 'PRAGMA integrity_check');
    if (!ok || ok.integrity_check !== 'ok') throw new Error('Falha integrity_check.');
    const errors = await all(db, 'PRAGMA foreign_key_check');
    if (errors.length) throw new Error('Falha foreign_key_check.');
    for (const [table, names] of Object.entries({
        Turmas: ['id', 'nome_turma', 'codigo_acesso'],
        Publicacoes: ['id', 'titulo', 'descricao', 'data', 'tipo', 'imagem_url', 'turma_id']
    })) {
        const fields = await all(db, 'PRAGMA table_info("' + table + '")');
        if (!names.every(name => fields.some(f => f.name === name)))
            throw new Error('Esquema de domínio incompatível: ' + table);
    }
}
async function apply(filename) {
    checkFile(filename);
    const db = await openReadWrite(filename);
    try {
        await run(db, 'PRAGMA busy_timeout = 2000');
        await run(db, 'PRAGMA foreign_keys = ON');
        await validateBase(db);
        await run(db, 'BEGIN IMMEDIATE');
        let committed = false;
        try {
            const version = (await get(db, 'PRAGMA user_version')).user_version;
            const tables = await all(db,
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('AdminCredencial','AdminSessoes')");
            if (version === AUTH_VERSION) {
                if (tables.length !== 2) throw new Error('Migração anterior incompleta.');
                const cred = await all(db, 'PRAGMA table_info("AdminCredencial")');
                const sess = await all(db, 'PRAGMA table_info("AdminSessoes")');
                if (!['id','senha_hash','salt','kdf','parametros_versao','geracao_sessao'].every(
                    k => cred.some(x => x.name === k)) ||
                    !['sid_digest','csrf_digest','admin_id','expira_absoluto_em','revogado_em'].every(
                        k => sess.some(x => x.name === k)))
                    throw new Error('Esquema auth existente incompatível.');
            } else if (version === 0 && tables.length === 0) {
                for (const sql of statements) await run(db, sql);
                await run(db, 'PRAGMA user_version = ' + AUTH_VERSION);
            } else throw new Error('Versão/esquema desconhecido: recusa sem alterações.');
            await run(db, 'COMMIT');
            committed = true;
        } finally {
            if (!committed) await run(db, 'ROLLBACK').catch(() => {});
        }
        await validateBase(db);
        process.stdout.write('Migração auth validada: versão ' + AUTH_VERSION + '.\n');
    } finally { await close(db); }
}
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--db') {
        console.error('Uso: node scripts/migrate-admin-auth.js --db /caminho/absoluto/fixture.db');
        process.exitCode = 2;
    } else {
        apply(args[1]).catch(err => {
            console.error('Migração abortada:', err.message);
            process.exitCode = 1;
        });
    }
}
module.exports = { apply };
