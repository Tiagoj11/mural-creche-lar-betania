'use strict';
// Testes reais de persistência com SQLite descartável; não lê banco.db do checkout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const root = path.resolve(__dirname, '..');
const secret = 'credencial-ficticia-lote3';

function fixture(temp, name) {
    const dir = path.join(temp, name);
    const appDir = path.join(dir, 'checkout');
    const dataDir = path.join(dir, 'dados-externos');
    const uploadDir = path.join(dir, 'imagens-externas');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(uploadDir, { recursive: true });
    for (const filename of ['database.js', 'server.js']) {
        fs.copyFileSync(path.join(root, filename), path.join(appDir, filename));
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(appDir, 'node_modules'), 'dir');
    return { dir, appDir, dataDir, uploadDir, dbPath: path.join(dataDir, 'mural.db') };
}
function envWith(dbPath, extra = {}) {
    const env = { ...process.env, ...extra };
    delete env.MURAL_DB_PATH;
    if (dbPath !== undefined) env.MURAL_DB_PATH = dbPath;
    return env;
}
const START_AND_CLOSE = [
    "const db = require('./database');",
    "db.close(err => { if (err) { console.error(err.code); process.exitCode = 1; } });"
].join('\n');
function startAndClose(appDir, env, script = START_AND_CLOSE) {
    return spawnSync(process.execPath, ['-e', script], {
        cwd: appDir, env, encoding: 'utf8', timeout: 10000
    });
}
function sqlite(dbPath, sql, params = [], method = 'run') {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, err => {
            if (err) return reject(err);
            db[method](sql, params, function (queryError, result) {
                const value = method === 'run'
                    ? { lastID: this.lastID, changes: this.changes }
                    : result;
                db.close(closeError => {
                    if (queryError || closeError) return reject(queryError || closeError);
                    resolve(value);
                });
            });
        });
    });
}
// Inicialização explícita de um banco fictício pelos testes: o aplicativo NÃO
// pode fazer isso quando MURAL_DB_PATH aponta a um arquivo externo.
async function provisionarBancoDeTeste(dbPath) {
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, err => {
            if (err) return reject(err);
            let falha;
            db.serialize(() => {
                db.run('PRAGMA foreign_keys = ON', e => { if (e) falha = e; });
                db.run('CREATE TABLE Turmas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome_turma TEXT NOT NULL UNIQUE, codigo_acesso TEXT UNIQUE)', e => { if (e) falha = e; });
                db.run('CREATE TABLE Publicacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL, descricao TEXT, data TEXT NOT NULL, tipo TEXT NOT NULL, imagem_url TEXT, turma_id INTEGER, FOREIGN KEY (turma_id) REFERENCES Turmas(id) ON DELETE CASCADE)', e => { if (e) falha = e; });
                db.close(e => {
                    if (falha || e) reject(falha || e);
                    else resolve();
                });
            });
        });
    });
}

async function freePort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    return port;
}
async function launchServer({ appDir, dbPath, uploadDir }) {
    const port = await freePort();
    const base = 'http://127.0.0.1:' + port;
    const child = spawn(process.execPath, ['server.js'], {
        cwd: appDir,
        env: envWith(dbPath, {
            MURAL_UPLOAD_DIR: uploadDir,
            ADMIN_SECRET_KEY: secret,
            PORT: String(port)
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    try {
        let started = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            if (child.exitCode !== null) throw new Error('Servidor encerrou: ' + output);
            try {
                const r = await fetch(base + '/api/turmas', {
                    headers: { Authorization: secret }, signal: AbortSignal.timeout(1500)
                });
                if (r.status === 200) { started = true; break; }
            } catch { /* Ainda iniciando */ }
            await new Promise(resolve => setTimeout(resolve, 75));
        }
        assert.ok(started, 'Express/SQLite não iniciaram: ' + output);
    } catch (err) {
        child.kill('SIGTERM');
        throw err;
    }
    return { child, base };
}
async function shutdown(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2500))
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
async function json(base, url, options = {}) {
    const r = await fetch(base + url, {
        ...options, signal: AbortSignal.timeout(4000)
    });
    assert.match(r.headers.get('content-type') || '', /^application\/json/);
    return { status: r.status, body: await r.json() };
}

test('Lote 3 Backend: caminho do SQLite e persistência sem migração automática', async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-lote3-db-'));
    try {
        await t.test('sem variável, mantém criação e reinício do banco.db legado', async () => {
            const f = fixture(temp, 'legado');
            const first = startAndClose(f.appDir, envWith(undefined));
            assert.equal(first.status, 0, first.stderr);
            const legacyPath = path.join(f.appDir, 'banco.db');
            assert.ok(fs.existsSync(legacyPath));
            await sqlite(legacyPath,
                'INSERT INTO Turmas (nome_turma, codigo_acesso) VALUES (?, ?)',
                ['Berçário Legado', 'abc123']);
            const second = startAndClose(f.appDir, envWith(undefined));
            assert.equal(second.status, 0, second.stderr);
            const rows = await sqlite(legacyPath,
                'SELECT id, nome_turma, codigo_acesso FROM Turmas', [], 'all');
            assert.equal(rows.length, 1);
            assert.equal(rows[0].nome_turma, 'Berçário Legado');
            assert.equal(rows[0].codigo_acesso, 'abc123');
        });

        await t.test('MURAL_DB_PATH externo existente conserva IDs, tokens e imagem em reinício HTTP', async () => {
            const f = fixture(temp, 'externo');
            // Provisionamento explícito e descartável, não migração implícita.
            await provisionarBancoDeTeste(f.dbPath);
            let server;
            let imageUrl;
            const originalToken = 'a1b2c3';
            try {
                server = await launchServer(f);
                const created = await json(server.base, '/api/turmas', {
                    method: 'POST', headers: {
                        Authorization: secret, 'Content-Type': 'application/json'
                    }, body: JSON.stringify({ nome_turma: 'Maternal' })
                });
                assert.equal(created.status, 201);
                assert.match(created.body.codigo_acesso, /^[0-9a-f]{6}$/);
                const generatedToken = created.body.codigo_acesso;
                const id = created.body.id;
                // Uma segunda turma fictícia confirma preservação de IDs independentes.
                await sqlite(f.dbPath, 'INSERT INTO Turmas (nome_turma,codigo_acesso) VALUES (?,?)',
                    ['Jardim', originalToken]);
                const form = new FormData();
                for (const [key, value] of Object.entries({
                    titulo: 'Evento', descricao: 'Teste', data: '2026-11-11',
                    tipo: 'Evento', destino: 'turma', turma_id: id
                })) form.set(key, String(value));
                form.set('imagem', new Blob([Buffer.from('imagem fictícia')], { type: 'image/png' }), 'foto.png');
                const pub = await json(server.base, '/api/publicacoes', {
                    method: 'POST', headers: { Authorization: secret }, body: form
                });
                assert.equal(pub.status, 201);
                imageUrl = pub.body.imagem_url;
                assert.match(imageUrl, /^\/uploads\/[0-9]+-[0-9a-f]{16}\.png$/);
                assert.ok(fs.existsSync(path.join(f.uploadDir, path.basename(imageUrl))));
                await shutdown(server.child);
                server = null;
                assert.ok(fs.existsSync(f.dbPath));
                assert.ok(!fs.existsSync(path.join(f.appDir, 'banco.db')),
                    'Não criar banco oculto no checkout quando MURAL_DB_PATH existe');

                server = await launchServer(f);
                const lista = await json(server.base, '/api/turmas', {
                    headers: { Authorization: secret }
                });
                assert.equal(lista.status, 200);
                const maternal = lista.body.find(row => row.id === id);
                assert.equal(maternal.codigo_acesso, generatedToken);
                assert.ok(lista.body.some(row => row.codigo_acesso === originalToken));
                const publicacoes = await json(server.base, '/api/admin/publicacoes', {
                    headers: { Authorization: secret }
                });
                assert.equal(publicacoes.body.length, 1);
                assert.equal(publicacoes.body[0].turma_id, id);
                assert.equal(publicacoes.body[0].imagem_url, imageUrl);
                const img = await fetch(server.base + imageUrl, { signal: AbortSignal.timeout(4000) });
                assert.equal(img.status, 200);
                assert.equal(Buffer.from(await img.arrayBuffer()).toString(), 'imagem fictícia');
                const mural = await json(server.base,
                    '/api/publicacoes/token/' + generatedToken);
                assert.equal(mural.status, 200);
                assert.equal(mural.body.publicacoes.length, 1);
                assert.ok(!fs.existsSync(path.join(f.appDir, 'banco.db')));
            } finally {
                if (server) await shutdown(server.child);
            }
        });

        await t.test('rejeita variável relativa, vazia, arquivo ausente ou destino interno', async () => {
            const f = fixture(temp, 'rejeicoes');
            const wrongPaths = [
                ['arquivo relativo', 'dados/mural.db', /caminho absoluto/],
                ['vazio', '', /caminho absoluto/],
                ['pai inexistente', path.join(f.dir, 'nao-existe', 'mural.db'), /diretório/],
                ['arquivo ausente', f.dbPath, /banco não encontrado/]
            ];
            const internal = path.join(f.appDir, 'banco.db');
            fs.writeFileSync(internal, '');
            wrongPaths.push(['dentro do checkout', internal, /fora do checkout/]);
            const symlinkDb = path.join(f.dataDir, 'alias.db');
            fs.symlinkSync(internal, symlinkDb);
            wrongPaths.push(['arquivo symlink', symlinkDb, /link simbólico/]);
            const isDirectory = path.join(f.dataDir, 'pasta.db');
            fs.mkdirSync(isDirectory);
            wrongPaths.push(['caminho é diretório', isDirectory, /arquivo regular/]);
            const aliasDir = path.join(f.dir, 'alias-checkout');
            fs.symlinkSync(f.appDir, aliasDir);
            wrongPaths.push(['pasta symlink para checkout',
                path.join(aliasDir, 'banco.db'), /fora do checkout/]);

            for (const [label, dbPath, pattern] of wrongPaths) {
                const result = startAndClose(f.appDir, envWith(dbPath));
                assert.notEqual(result.status, 0, label + ' deveria falhar');
                assert.match(result.stderr, pattern, label);
            }
            assert.ok(!fs.existsSync(f.dbPath));
            assert.ok(!fs.existsSync(path.join(f.appDir, 'banco-secreto.db')));
        });

        await t.test('arquivo externo zero bytes é recusado sem criar tabela ou alterar bytes', async () => {
            const f = fixture(temp, 'zero-byte');
            fs.writeFileSync(f.dbPath, '');
            const r = startAndClose(f.appDir, envWith(f.dbPath));
            assert.notEqual(r.status, 0);
            assert.match(r.stderr, /banco SQLite vazio ou incompleto/);
            assert.equal(fs.statSync(f.dbPath).size, 0);
            assert.ok(!fs.existsSync(path.join(f.appDir, 'banco.db')));
        });

        await t.test('arquivo não SQLite e SQLite truncado falham sem inicialização implícita', async () => {
            const f = fixture(temp, 'corrompido');
            fs.writeFileSync(f.dbPath, 'texto aleatório que não é SQLite'.repeat(6));
            const invalid = startAndClose(f.appDir, envWith(f.dbPath));
            assert.notEqual(invalid.status, 0);
            assert.match(invalid.stderr, /não é um banco SQLite válido/);
            await provisionarBancoDeTeste(path.join(f.dataDir, 'valido.db'));
            const truncado = path.join(f.dataDir, 'valido.db');
            fs.truncateSync(truncado, 120);
            const corrupted = startAndClose(f.appDir, envWith(truncado));
            assert.notEqual(corrupted.status, 0);
            assert.match(corrupted.stderr, /integridade|banco externo inválido/);
        });

        await t.test('banco com esquema incompatível é recusado e permanece intacto', async () => {
            const f = fixture(temp, 'esquema-incompativel');
            await provisionarBancoDeTeste(f.dbPath);
            await sqlite(f.dbPath, 'DROP TABLE Publicacoes');
            const before = fs.statSync(f.dbPath).size;
            const r = startAndClose(f.appDir, envWith(f.dbPath));
            assert.notEqual(r.status, 0);
            assert.match(r.stderr, /esquema Publicacoes|relacionamento de turma|banco externo inválido/);
            const tables = await sqlite(f.dbPath,
                "SELECT name FROM sqlite_master WHERE type='table' AND name='Publicacoes'", [], 'all');
            assert.equal(tables.length, 0, 'O aplicativo não recria a tabela ausente');
            assert.equal(fs.statSync(f.dbPath).size, before);
        });


        await t.test('verifica permissões sem criar arquivos inesperados', async () => {
            if (typeof process.getuid === 'function' && process.getuid() === 0) {
                t.diagnostic('Teste de permissões não avaliado como root');
                return;
            }
            const f = fixture(temp, 'permissoes');
            await provisionarBancoDeTeste(f.dbPath);
            fs.chmodSync(f.dataDir, 0o500);
            try {
                const r = startAndClose(f.appDir, envWith(f.dbPath));
                assert.notEqual(r.status, 0);
                assert.match(r.stderr, /permissões insuficientes|inacessível/);
            } finally {
                fs.chmodSync(f.dataDir, 0o700);
            }
            const valid = startAndClose(f.appDir, envWith(f.dbPath));
            assert.equal(valid.status, 0, valid.stderr);
        });
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
