'use strict';
// Integração real do Lote 2: Express, SQLite e Multer; sem dados persistentes no checkout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const sqlite3 = require('sqlite3');

const root = path.resolve(__dirname, '..');
const secret = 'teste-backend-lote2-' + process.pid;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-lote2-'));
const appDir = path.join(tmp, 'checkout-temporario');
const uploadDir = path.join(tmp, 'imagens-persistentes');
let processServer;
let sqlite;
let baseUrl;
let output = '';

function sql(sqlText, params = [], operation = 'run') {
    return new Promise((resolve, reject) => {
        sqlite[operation](sqlText, params, function (err, value) {
            if (err) return reject(err);
            resolve(operation === 'run' ? { id: this.lastID, changes: this.changes } : value);
        });
    });
}
function freePort() {
    const sock = net.createServer();
    return new Promise((resolve, reject) => {
        sock.once('error', reject);
        sock.listen(0, '127.0.0.1', () => {
            const p = sock.address().port;
            sock.close(() => resolve(p));
        });
    });
}
async function request(url, { method = 'GET', auth, fields, image, json } = {}) {
    const headers = {};
    let body;
    if (auth !== undefined) headers.Authorization = auth;
    if (fields) {
        body = new FormData();
        for (const [k, v] of Object.entries(fields)) body.set(k, String(v));
        if (image) body.set('imagem', new Blob([image.content], { type: image.mime }), image.filename);
    } else if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
    }
    const response = await fetch(baseUrl + url, {
        method, headers, body, signal: AbortSignal.timeout(10000)
    });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return { status: response.status, body: await response.json(), type: 'json' };
    }
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), type: contentType };
}
function expectError(response, status) {
    assert.equal(response.status, status, JSON.stringify(response.body));
    assert.equal(response.type, 'json');
    assert.equal(typeof response.body.erro, 'string');
    assert.ok(response.body.erro.length > 0);
    assert.doesNotMatch(JSON.stringify(response.body), /codigo_acesso|aaaaaa|bbbbbb/);
}
async function boot() {
    fs.mkdirSync(path.join(appDir, 'public', 'uploads'), { recursive: true });
    fs.mkdirSync(uploadDir, { recursive: true });
    for (const filename of ['server.js', 'database.js'])
        fs.copyFileSync(path.join(root, filename), path.join(appDir, filename));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(appDir, 'node_modules'), 'dir');
    assert.ok(!uploadDir.startsWith(appDir + path.sep));
    assert.ok(!fs.existsSync(path.join(root, 'banco.db')));
    const port = await freePort();
    baseUrl = 'http://127.0.0.1:' + port;
    processServer = spawn(process.execPath, ['server.js'], {
        cwd: appDir,
        env: { ...process.env, PORT: String(port), ADMIN_SECRET_KEY: secret, MURAL_UPLOAD_DIR: uploadDir },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    processServer.stdout.on('data', chunk => { output += chunk.toString(); });
    processServer.stderr.on('data', chunk => { output += chunk.toString(); });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        if (processServer.exitCode !== null) throw new Error('Servidor terminou: ' + output);
        try {
            const response = await request('/api/turmas', { auth: secret });
            if (response.status === 200) { ready = true; break; }
        } catch { /* porta ainda não disponível */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Servidor não iniciou: ' + output);
    const dbPath = path.join(appDir, 'banco.db');
    assert.ok(fs.existsSync(dbPath));
    sqlite = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, err => err ? reject(err) : resolve(db));
    });
    await sql('PRAGMA foreign_keys = ON');
    await sql('INSERT INTO Turmas (nome_turma,codigo_acesso) VALUES (?,?)', ['Alfa', 'aaaaaa']);
    await sql('INSERT INTO Turmas (nome_turma,codigo_acesso) VALUES (?,?)', ['Beta', 'bbbbbb']);
    return { alpha: 1, beta: 2 };
}
async function teardown() {
    if (sqlite) await new Promise((resolve, reject) => sqlite.close(err => err ? reject(err) : resolve()));
    if (processServer && processServer.exitCode === null) {
        processServer.kill('SIGTERM');
        await Promise.race([new Promise(resolve => processServer.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 3000))]);
        if (processServer.exitCode === null) processServer.kill('SIGKILL');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
}
const normal = { titulo: 'Teste', descricao: 'Texto', data: '2026-11-11', tipo: 'Evento' };
const create = (fields, image) => request('/api/publicacoes',
    { method: 'POST', auth: secret, fields: { ...normal, ...fields }, image });
const change = (id, fields, image) => request('/api/publicacoes/' + id,
    { method: 'PUT', auth: secret, fields: { ...normal, ...fields }, image });
const admin = () => request('/api/admin/publicacoes', { auth: secret });

test('Backend Lote 2: contrato HTTP/SQLite real, uploads e legados', async t => {
    try {
        await boot();

        await t.test('POST geral ignora turma obsoleta; duas turmas enxergam Geral', async () => {
            const created = await create({ titulo: 'Para todas', destino: 'geral', turma_id: 99999 });
            assert.equal(created.status, 201);
            const all = await admin();
            assert.equal(all.status, 200);
            const item = all.body.find(p => p.id === created.body.id);
            assert.equal(item.turma_id, null);
            assert.equal(item.nome_turma, null);
            for (const token of ['aaaaaa', 'bbbbbb']) {
                const wall = await request('/api/publicacoes/token/' + token);
                assert.equal(wall.status, 200);
                const pub = wall.body.publicacoes.find(p => p.id === created.body.id);
                assert.equal(pub.turma_id, null);
                assert.equal(pub.titulo, 'Para todas');
                assert.doesNotMatch(JSON.stringify(wall.body), /codigo_acesso|aaaaaa|bbbbbb/);
            }
        });

        await t.test('POST turma válida e legado sem destino; isolamento por token', async () => {
            const specific = await create({ titulo: 'Só Alfa', destino: 'turma', turma_id: 1 });
            assert.equal(specific.status, 201);
            const legacy = await create({ titulo: 'Legado Beta', turma_id: 2 });
            assert.equal(legacy.status, 201);
            const alpha = await request('/api/publicacoes/token/aaaaaa');
            const beta = await request('/api/publicacoes/token/bbbbbb');
            assert.ok(alpha.body.publicacoes.some(p => p.id === specific.body.id));
            assert.ok(!beta.body.publicacoes.some(p => p.id === specific.body.id));
            assert.ok(beta.body.publicacoes.some(p => p.id === legacy.body.id));
            assert.ok(!alpha.body.publicacoes.some(p => p.id === legacy.body.id));
            assert.equal(alpha.body.publicacoes.find(p => p.id === specific.body.id).turma_id, 1);
            assert.equal(beta.body.publicacoes.find(p => p.id === legacy.body.id).turma_id, 2);
        });

        await t.test('POST/PUT rejeitam destino/turma inválidos; erro JSON; senha exigida', async () => {
            for (const fields of [
                {}, { destino: 'turma' }, { destino: 'turma', turma_id: 9999 },
                { turma_id: 9999 }, { destino: 'qualquer', turma_id: 1 },
                { destino: 'turma', turma_id: '1 OR 1=1' }, { destino: 'turma', turma_id: 0 }
            ]) expectError(await create(fields), 400);
            expectError(await request('/api/publicacoes', {
                method: 'POST', fields: { ...normal, destino: 'geral' }
            }), 401);
            expectError(await request('/api/publicacoes', {
                method: 'POST', auth: 'senha-errada', fields: { ...normal, destino: 'geral' }
            }), 401);
            expectError(await request('/api/publicacoes/1', {
                method: 'PUT', fields: { ...normal, destino: 'geral' }
            }), 401);
            expectError(await request('/api/publicacoes/1', {
                method: 'DELETE', auth: 'senha-errada'
            }), 401);
            const created = await create({ destino: 'geral' });
            assert.equal(created.status, 201);
            for (const fields of [{ destino: 'turma' }, { destino: 'turma', turma_id: 8888 },
                { destino: 'desconhecido' }, {}]) {
                expectError(await change(created.body.id, fields), 400);
            }
            expectError(await request('/api/publicacoes/token/invalido'), 404);
            expectError(await request('/api/rota-inexistente'), 404);
        });

        await t.test('PUT muda Geral ↔ Turma sem perder ID', async () => {
            const c = await create({ titulo: 'Alternável', destino: 'geral' });
            assert.equal(c.status, 201);
            const id = c.body.id;
            const a = await change(id, { titulo: 'Agora Beta', destino: 'turma', turma_id: 2 });
            assert.equal(a.status, 200);
            let p = (await admin()).body.find(x => x.id === id);
            assert.equal(p.turma_id, 2);
            assert.equal(p.titulo, 'Agora Beta');
            assert.ok(!(await request('/api/publicacoes/token/aaaaaa')).body.publicacoes.some(x => x.id === id));
            assert.ok((await request('/api/publicacoes/token/bbbbbb')).body.publicacoes.some(x => x.id === id));
            const b = await change(id, { titulo: 'Geral novamente', destino: 'geral', turma_id: 1 });
            assert.equal(b.status, 200);
            p = (await admin()).body.find(x => x.id === id);
            assert.equal(p.turma_id, null);
            assert.ok((await request('/api/publicacoes/token/aaaaaa')).body.publicacoes.some(x => x.id === id));
            assert.ok((await request('/api/publicacoes/token/bbbbbb')).body.publicacoes.some(x => x.id === id));
            assert.equal((await request('/api/publicacoes/token/bbbbbb')).body.publicacoes.find(x => x.id === id).turma_id, null);
        });

        await t.test('upload externo persiste em PUT sem imagem; acesso autorizado por publicação', async () => {
            const img1 = { filename: 'teste.png', mime: 'image/png', content: Buffer.from('imagem-ficticia-1') };
            const img2 = { filename: 'outra.webp', mime: 'image/webp', content: Buffer.from('imagem-ficticia-2') };
            const c = await create({ titulo: 'Imagem Geral', destino: 'geral' }, img1);
            assert.equal(c.status, 201);
            assert.match(c.body.imagem_url, /^\/uploads\/[0-9]+-[0-9a-f]{16}\.png$/);
            let filename = path.basename(c.body.imagem_url);
            assert.ok(fs.existsSync(path.join(uploadDir, filename)));
            assert.ok(!fs.existsSync(path.join(appDir, 'public', 'uploads', filename)));
            let served = await request(c.body.imagem_url);
            assert.equal(served.status, 200);
            assert.deepEqual(served.bytes, img1.content);
            const edit = await change(c.body.id, { titulo: 'Imagem preservada', destino: 'turma', turma_id: 1 });
            assert.equal(edit.status, 200);
            assert.equal((await admin()).body.find(p => p.id === c.body.id).imagem_url, c.body.imagem_url);
            const editImage = await change(c.body.id,
                { titulo: 'Imagem atualizada', destino: 'geral' }, img2);
            assert.equal(editImage.status, 200);
            const newName = path.basename(editImage.body.imagem_url);
            assert.match(newName, /^[0-9]+-[0-9a-f]{16}\.webp$/);
            assert.ok(fs.existsSync(path.join(uploadDir, newName)));
            assert.deepEqual((await request(editImage.body.imagem_url)).bytes, img2.content);
            const deleted = await request('/api/publicacoes/' + c.body.id,
                { method: 'DELETE', auth: secret });
            assert.equal(deleted.status, 200);
            expectError(await request(editImage.body.imagem_url), 404);
            // Arquivos físicos não são apagados no DELETE para não perder histórico/links legados.
        });

        await t.test('upload MIME, limite 10 MB, travessia e arquivo não vinculado', async () => {
            expectError(await create({ destino: 'geral' }, {
                filename: 'arquivo.txt', mime: 'text/plain', content: Buffer.from('não-imagem')
            }), 400);
            expectError(await create({ destino: 'geral' }, {
                filename: 'muito-grande.png', mime: 'image/png', content: Buffer.alloc(10 * 1024 * 1024 + 1)
            }), 413);
            fs.writeFileSync(path.join(uploadDir, 'nao-vinculado.png'), 'privado');
            expectError(await request('/uploads/nao-vinculado.png'), 404);
            for (const p of ['/uploads/.env', '/uploads/%2e%2e%2f.env', '/uploads/banco.db',
                '/uploads/sem-extensao', '/uploads/foo.txt']) {
                const r = await request(p);
                expectError(r, 404);
            }
        });

        await t.test('arquivo legado vinculado em public/uploads continua disponível', async () => {
            const file = '1711111111111-1234567890abcdef.png';
            fs.writeFileSync(path.join(appDir, 'public', 'uploads', file), 'imagem-legada');
            const result = await create({ titulo: 'Com legado', destino: 'geral' });
            assert.equal(result.status, 201);
            await sql('UPDATE Publicacoes SET imagem_url=? WHERE id=?',
                ['/uploads/' + file, result.body.id]);
            const response = await request('/uploads/' + file);
            assert.equal(response.status, 200);
            assert.equal(response.bytes.toString(), 'imagem-legada');
            expectError(await request('/uploads/1711111111111-1234567890abcdee.png'), 404);
        });

        await t.test('cadastro turma e duplicidade preservados', async () => {
            expectError(await request('/api/turmas', { method: 'POST', json: { nome_turma: 'Nova' } }), 401);
            const c = await request('/api/turmas',
                { method: 'POST', auth: secret, json: { nome_turma: 'Nova' } });
            assert.equal(c.status, 201);
            assert.match(c.body.codigo_acesso, /^[0-9a-f]{6}$/);
            expectError(await request('/api/turmas',
                { method: 'POST', auth: secret, json: { nome_turma: 'Nova' } }), 400);
            const list = await request('/api/turmas', { auth: secret });
            assert.equal(list.status, 200);
            assert.ok(list.body.find(turma => turma.id === c.body.id));
            expectError(await request('/api/turmas'), 401);
            expectError(await request('/api/admin/publicacoes'), 401);
        });
    } finally {
        await teardown();
    }
});
