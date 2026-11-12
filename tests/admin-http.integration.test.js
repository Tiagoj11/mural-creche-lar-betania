'use strict';
// Integração HTTP real: Express + SQLite instalados via npm ci. Banco exclusivamente temporário.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const root = path.resolve(__dirname, '..');
const secret = 'senha-ficticia-de-integracao-' + process.pid;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-cei-http-'));
const appDir = path.join(temp, 'checkout');
let child;
let database;
let base;
let serverLogs = '';
let cookie;
let csrf;
let dbPath;

const run = (sql, values = []) => new Promise((resolve, reject) => {
    database.run(sql, values, function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
    });
});
async function choosePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function http(route, options = {}) {
    const headers = {};
    if (options.sessionMode !== undefined) {
        if (options.sessionMode === secret) {
            headers.Cookie = cookie;
            headers['X-CSRF-Token'] = csrf;
        } else headers.Cookie = 'mural_admin_sid=invalid';
    }
    if (!['GET','HEAD'].includes(options.method || 'GET')) headers.Origin = base;
    let body;
    if (options.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = typeof options.json === 'string' ? options.json : JSON.stringify(options.json);
    }
    if (options.form) {
        body = new FormData();
        for (const [key, value] of Object.entries(options.form)) body.set(key, String(value));
    }
    const response = await fetch(base + route, {
        method: options.method || 'GET', headers, body, signal: AbortSignal.timeout(4000)
    });
    assert.match(response.headers.get('content-type') || '', /^application\/json\b/,
        'Resposta precisa ser JSON: ' + route);
    return { status: response.status, body: await response.json() };
}
function errorJson(response, status) {
    assert.equal(response.status, status);
    assert.equal(typeof response.body.erro, 'string');
    assert.ok(response.body.erro.length);
    assert.doesNotMatch(JSON.stringify(response.body), /codigo_acesso|aaaaaa|bbbbbb/);
}
async function start() {
    fs.mkdirSync(appDir);
    for (const file of ['server.js', 'database.js', 'admin-auth.js']) {
        fs.copyFileSync(path.join(root, file), path.join(appDir, file));
    }
    fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(root, 'scripts', 'migrate-admin-auth.js'),
        path.join(appDir, 'scripts', 'migrate-admin-auth.js'));
    fs.mkdirSync(path.join(appDir, 'public', 'uploads'), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(appDir, 'node_modules'), 'dir');
    assert.notEqual(path.join(root, 'banco.db'), path.join(appDir, 'banco.db'));
    const port = await choosePort();
    base = 'http://127.0.0.1:' + port;
    const dataDir = path.join(temp, 'data');
    fs.mkdirSync(dataDir);
    dbPath = path.join(dataDir, 'mural.db');
    // Provisionamento OFFLINE explícito e descartável antes de iniciar Express.
    const setupDb = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, err => err ? reject(err) : resolve(db));
    });
    await new Promise((resolve, reject) => setupDb.serialize(() => {
        setupDb.run('CREATE TABLE Turmas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome_turma TEXT NOT NULL UNIQUE, codigo_acesso TEXT UNIQUE)', err => { if (err) reject(err); });
        setupDb.run('CREATE TABLE Publicacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL, descricao TEXT, data TEXT NOT NULL, tipo TEXT NOT NULL, imagem_url TEXT, turma_id INTEGER, FOREIGN KEY (turma_id) REFERENCES Turmas(id) ON DELETE CASCADE)', err => err ? reject(err) : resolve());
    }));
    await new Promise((resolve, reject) => setupDb.close(err => err ? reject(err) : resolve()));
    const migration = spawnSync(process.execPath, ['scripts/migrate-admin-auth.js', '--db', dbPath],
        { cwd: appDir, encoding:'utf8', timeout:10000 });
    assert.equal(migration.status, 0, migration.stderr);
    child = spawn(process.execPath, ['server.js'], {
        cwd: appDir, env: { ...process.env, PORT: String(port), MURAL_DB_PATH: dbPath,
            MURAL_UPLOAD_DIR: path.join(temp, 'uploads'),
            ADMIN_PUBLIC_ORIGIN: base, ADMIN_BOOTSTRAP_ENABLED: 'true',
            ADMIN_BOOTSTRAP_UNTIL: String(Date.now() + 600000),
            ADMIN_BOOTSTRAP_TOKEN: 'token-ficticio-' + 'a'.repeat(48) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', data => { serverLogs += data.toString(); });
    child.stderr.on('data', data => { serverLogs += data.toString(); });
    let ready = false;
    for (let n = 0; n < 100; n++) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error('Express encerrou: ' + serverLogs);
        }
        try {
            const r = await http('/api/admin/auth/status');
            if (r.status === 200) { ready = true; break; }
        } catch { /* Inicialização em andamento */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Express + SQLite não iniciaram em 10 s: ' + serverLogs);
    assert.ok(fs.existsSync(dbPath), 'SQLite externo temporário criado');
    assert.ok(!fs.existsSync(path.join(appDir, 'banco.db')));
    const boot = await http('/api/admin/auth/bootstrap', { method:'POST',
        json:{ token_inicial:'token-ficticio-' + 'a'.repeat(48), nova_senha:secret } });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const response = await fetch(base + '/api/admin/auth/login', {
        method:'POST', headers:{ Origin:base, 'Content-Type':'application/json' },
        body:JSON.stringify({ senha:secret })
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrf = (await http('/api/admin/auth/session', { sessionMode: secret })).body.csrf_token;
    database = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, err => err ? reject(err) : resolve(db));
    });
    await run('PRAGMA foreign_keys = ON');
    const alphaId = (await run('INSERT INTO Turmas (nome_turma, codigo_acesso) VALUES (?,?)',
        ['Alfa', 'aaaaaa'])).id;
    const betaId = (await run('INSERT INTO Turmas (nome_turma, codigo_acesso) VALUES (?,?)',
        ['Beta', 'bbbbbb'])).id;
    for (const [titulo, turma] of [['Geral', null], ['Alfa somente', alphaId], ['Beta somente', betaId]]) {
        await run('INSERT INTO Publicacoes (titulo, descricao, data, tipo, imagem_url, turma_id) VALUES (?,?,?,?,?,?)',
            [titulo, 'Teste fictício', '2026-11-11', 'Evento', null, turma]);
    }
    return { alphaId, betaId };
}
async function cleanup() {
    if (database) await new Promise((resolve, reject) =>
        database.close(err => err ? reject(err) : resolve()));
    if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(temp, { recursive: true, force: true });
}

test('Lote 1: rotas HTTP com Express real e SQLite descartável', async t => {
    let ids;
    try {
        ids = await start();

        await t.test('GET turmas: autorização ausente, incorreta e válida', async () => {
            errorJson(await http('/api/turmas'), 401);
            errorJson(await http('/api/turmas', { sessionMode: 'incorreta' }), 401);
            const r = await http('/api/turmas', { sessionMode: secret });
            assert.equal(r.status, 200);
            assert.deepEqual(r.body.map(row => row.nome_turma), ['Alfa', 'Beta']);
            for (const row of r.body) {
                assert.deepEqual(Object.keys(row).sort(), ['codigo_acesso', 'id', 'nome_turma']);
            }
        });

        await t.test('GET admin publicacoes: autorização e publicação NULL/específica', async () => {
            errorJson(await http('/api/admin/publicacoes'), 401);
            errorJson(await http('/api/admin/publicacoes', { sessionMode: 'incorreta' }), 401);
            const r = await http('/api/admin/publicacoes', { sessionMode: secret });
            assert.equal(r.status, 200);
            assert.equal(r.body.length, 3);
            const geral = r.body.find(p => p.titulo === 'Geral');
            const alfa = r.body.find(p => p.titulo === 'Alfa somente');
            const beta = r.body.find(p => p.titulo === 'Beta somente');
            assert.equal(geral.turma_id, null);
            assert.equal(geral.nome_turma, null);
            assert.equal(alfa.turma_id, ids.alphaId);
            assert.equal(alfa.nome_turma, 'Alfa');
            assert.equal(beta.turma_id, ids.betaId);
            assert.equal(beta.nome_turma, 'Beta');
            for (const row of r.body) {
                assert.deepEqual(Object.keys(row).sort(),
                    ['data', 'descricao', 'id', 'imagem_url', 'nome_turma', 'tipo', 'titulo', 'turma_id']);
            }
            assert.doesNotMatch(JSON.stringify(r.body), /codigo_acesso|aaaaaa|bbbbbb/);
        });

        await t.test('POST turma: autorização, código, duplicidade e persistência', async () => {
            const baseOptions = { method: 'POST', json: { nome_turma: 'Nova' } };
            errorJson(await http('/api/turmas', baseOptions), 401);
            errorJson(await http('/api/turmas', { ...baseOptions, sessionMode: 'incorreta' }), 401);
            errorJson(await http('/api/turmas', { method: 'POST', sessionMode: secret, json: {} }), 400);
            const created = await http('/api/turmas', { ...baseOptions, sessionMode: secret });
            assert.equal(created.status, 201);
            assert.equal(created.body.nome_turma, 'Nova');
            assert.match(created.body.codigo_acesso, /^[0-9a-f]{6}$/);
            errorJson(await http('/api/turmas', { ...baseOptions, sessionMode: secret }), 400);
            const list = await http('/api/turmas', { sessionMode: secret });
            assert.equal(list.body.find(row => row.id === created.body.id).codigo_acesso,
                created.body.codigo_acesso);
        });

        await t.test('token válido/ inválido: isolamento e respostas JSON', async () => {
            const alfa = await http('/api/publicacoes/token/aaaaaa');
            const beta = await http('/api/publicacoes/token/bbbbbb');
            assert.equal(alfa.status, 200);
            assert.equal(beta.status, 200);
            assert.equal(alfa.body.nome_turma, 'Alfa');
            assert.equal(beta.body.nome_turma, 'Beta');
            assert.ok(alfa.body.publicacoes.some(p => p.titulo === 'Alfa somente'));
            assert.ok(beta.body.publicacoes.some(p => p.titulo === 'Beta somente'));
            assert.ok(!alfa.body.publicacoes.some(p => p.titulo === 'Beta somente'));
            assert.ok(!beta.body.publicacoes.some(p => p.titulo === 'Alfa somente'));
            assert.doesNotMatch(JSON.stringify(alfa.body), /codigo_acesso|bbbbbb/);
            assert.doesNotMatch(JSON.stringify(beta.body), /codigo_acesso|aaaaaa/);
            // Diagnóstico, NÃO critério desejado: GET público geral é escopo do Lote 2.
            console.log('Lote 2 pendente: geral visível no token Alfa = ' +
                alfa.body.publicacoes.some(p => p.titulo === 'Geral'));
            console.log('Lote 2 pendente: geral visível no token Beta = ' +
                beta.body.publicacoes.some(p => p.titulo === 'Geral'));
            errorJson(await http('/api/publicacoes/token/invalido'), 404);
        });

        await t.test('CRUD de publicações: POST/PUT/DELETE negados sem senha ou com senha errada', async () => {
            for (const [method, url] of [
                ['POST', '/api/publicacoes'],
                ['PUT', '/api/publicacoes/1'],
                ['DELETE', '/api/publicacoes/1']
            ]) {
                const opts = { method };
                if (method !== 'DELETE') opts.form = {
                    titulo: 'Teste', data: '2026-11-11', tipo: 'Evento', turma_id: ids.alphaId
                };
                errorJson(await http(url, opts), 401);
                errorJson(await http(url, { ...opts, sessionMode: 'incorreta' }), 401);
            }
        });

        await t.test('CRUD específico autenticado: POST/PUT/DELETE multipart com SQLite real', async () => {
            const fields = {
                titulo: 'Criado', descricao: 'Teste', data: '2026-11-11',
                tipo: 'Evento', turma_id: ids.alphaId
            };
            const created = await http('/api/publicacoes', {
                method: 'POST', sessionMode: secret, form: fields
            });
            assert.equal(created.status, 201);
            const id = created.body.id;
            assert.equal(typeof id, 'number');
            const edited = await http('/api/publicacoes/' + id, {
                method: 'PUT', sessionMode: secret,
                form: { ...fields, titulo: 'Editado', turma_id: ids.betaId }
            });
            assert.equal(edited.status, 200);
            const list = await http('/api/admin/publicacoes', { sessionMode: secret });
            assert.equal(list.body.find(p => p.id === id).titulo, 'Editado');
            assert.equal(list.body.find(p => p.id === id).turma_id, ids.betaId);
            const deleted = await http('/api/publicacoes/' + id, {
                method: 'DELETE', sessionMode: secret
            });
            assert.equal(deleted.status, 200);
            const after = await http('/api/admin/publicacoes', { sessionMode: secret });
            assert.ok(!after.body.some(p => p.id === id));
            errorJson(await http('/api/publicacoes/' + id, {
                method: 'DELETE', sessionMode: secret
            }), 404);
        });

        await t.test('404 e JSON malformado retornam JSON de erro', async () => {
            errorJson(await http('/api/rota-inexistente'), 404);
            errorJson(await http('/api/turmas', {
                method: 'POST', sessionMode: secret, json: '{invalido'
            }), 400);
        });
    } finally {
        await cleanup();
    }
});
