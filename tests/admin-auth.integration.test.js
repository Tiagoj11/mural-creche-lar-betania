'use strict';
// HTTP real Express + SQLite e uploads temporários; credenciais exclusivamente fictícias.
// Não toca o banco da raiz do repositório, nem configura segredo operacional real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const root = path.resolve(__dirname, '..');
const token = 'token-ficticio-bootstrap-' + 'a'.repeat(48);
const initialPass = 'senha-ficticia-muito-longa-12345';
const changedPass = 'outra-senha-ficticia-longa-56789';

function command(args, cwd, env) {
    const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r;
}
function execSql(db, sql, params = [], method = 'run') {
    return new Promise((resolve, reject) => {
        db[method](sql, params, function (err, result) {
            if (err) reject(err);
            else resolve(method === 'run' ? { changes: this.changes, lastID: this.lastID } : result);
        });
    });
}
async function portFree() {
    const n = net.createServer();
    await new Promise((resolve, reject) => {
        n.once('error', reject);
        n.listen(0, '127.0.0.1', resolve);
    });
    const port = n.address().port;
    await new Promise(resolve => n.close(resolve));
    return port;
}
async function fixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-auth-test-'));
    const app = path.join(tmp, 'checkout');
    const ext = path.join(tmp, 'persistente');
    fs.mkdirSync(app); fs.mkdirSync(ext);
    const dbPath = path.join(ext, 'mural.db');
    for (const file of ['database.js', 'server.js', 'admin-auth.js']) {
        fs.copyFileSync(path.join(root, file), path.join(app, file));
    }
    fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(root, 'scripts', 'migrate-admin-auth.js'),
        path.join(app, 'scripts', 'migrate-admin-auth.js'));
    fs.mkdirSync(path.join(app, 'public'), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'), 'dir');
    const db = await new Promise((resolve, reject) => {
        const d = new sqlite3.Database(dbPath, err => err ? reject(err) : resolve(d));
    });
    await execSql(db, 'CREATE TABLE Turmas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome_turma TEXT NOT NULL UNIQUE, codigo_acesso TEXT UNIQUE)');
    await execSql(db, 'CREATE TABLE Publicacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL, descricao TEXT, data TEXT NOT NULL, tipo TEXT NOT NULL, imagem_url TEXT, turma_id INTEGER, FOREIGN KEY(turma_id) REFERENCES Turmas(id) ON DELETE CASCADE)');
    await execSql(db, 'INSERT INTO Turmas (nome_turma,codigo_acesso) VALUES (?,?)', ['Alfa', 'abc123']);
    await execSql(db, 'INSERT INTO Turmas (nome_turma,codigo_acesso) VALUES (?,?)', ['Beta', 'def456']);
    await execSql(db, "INSERT INTO Publicacoes (titulo,descricao,data,tipo,turma_id) VALUES ('Geral','Teste','2026-11-11','Evento',NULL)");
    await execSql(db, "INSERT INTO Publicacoes (titulo,descricao,data,tipo,turma_id) VALUES ('Alfa','Teste','2026-11-11','Evento',1)");
    await new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve()));
    const env = { ...process.env, MURAL_DB_PATH: dbPath };
    command(['scripts/migrate-admin-auth.js', '--db', dbPath], app, env);
    command(['scripts/migrate-admin-auth.js', '--db', dbPath], app, env); // idempotência
    const port = await portFree();
    const origin = 'http://127.0.0.1:' + port;
    const uploadDir = path.join(ext, 'uploads');
    fs.mkdirSync(uploadDir);
    const server = spawn(process.execPath, ['server.js'], {
        cwd: app, env: { ...env, PORT: String(port), ADMIN_PUBLIC_ORIGIN: origin,
            ADMIN_BOOTSTRAP_ENABLED: 'true', ADMIN_BOOTSTRAP_UNTIL: String(Date.now() + 10 * 60 * 1000),
            ADMIN_BOOTSTRAP_TOKEN: token, MURAL_UPLOAD_DIR: uploadDir, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    server.stdout.on('data', part => { logs += part.toString(); });
    server.stderr.on('data', part => { logs += part.toString(); });
    for (let n = 0; n < 80; n++) {
        try {
            const response = await fetch(origin + '/api/admin/auth/status', {
                signal: AbortSignal.timeout(800)
            });
            if (response.status === 200) break;
        } catch {}
        if (server.exitCode !== null) throw new Error('Servidor encerrou: ' + logs);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(server.exitCode, null, 'Express não inicializou: ' + logs);
    return {
        app, tmp, dbPath, origin, uploadDir, server,
        async close() {
            if (server.exitCode === null) {
                server.kill('SIGTERM');
                await Promise.race([new Promise(r => server.once('exit', r)),
                    new Promise(r => setTimeout(r, 2500))]);
                if (server.exitCode === null) server.kill('SIGKILL');
            }
            fs.rmSync(tmp, { recursive: true, force: true });
        },
        async sql(text, args = [], method = 'get') {
            const conn = await new Promise((resolve, reject) => {
                const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE,
                    err => err ? reject(err) : resolve(d));
            });
            try { return await execSql(conn, text, args, method); }
            finally { await new Promise((r, e) => conn.close(x => x ? e(x) : r())); }
        }
    };
}
async function api(h, endpoint, { method = 'GET', cookie, origin, csrf, json, form } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (origin !== undefined) headers.Origin = origin;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    let body;
    if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
    } else if (form) {
        body = new FormData();
        for (const [k, v] of Object.entries(form)) {
            if (k === 'imagem') body.set(k, new Blob([v], { type: 'image/png' }), 'foto.png');
            else body.set(k, String(v));
        }
    }
    const res = await fetch(h.origin + endpoint, {
        method, headers, body, signal: AbortSignal.timeout(6000)
    });
    const raw = await res.text();
    if (res.status !== 204) assert.match(res.headers.get('content-type') || '', /application\/json/, endpoint);
    return {
        status: res.status, raw, data: raw ? JSON.parse(raw) : null,
        cookie: res.headers.get('set-cookie')?.split(';')[0],
        headers: res.headers
    };
}
function error(r, status) {
    assert.equal(r.status, status, JSON.stringify(r.data));
    assert.equal(typeof r.data.erro, 'string');
    assert.ok(r.data.erro.length > 0);
    assert.doesNotMatch(JSON.stringify(r.data), /senha-ficticia|abc123|def456|sid_digest|csrf_digest/);
}
test('auth: migração e contrato HTTP reais em SQLite temporário', async t => {
    const h = await fixture();
    try {
        const status = await api(h, '/api/admin/auth/status');
        assert.equal(status.status, 200);
        assert.equal(status.data.configurado, false);
        error(await api(h, '/api/admin/auth/bootstrap', { method: 'POST', json: {
            token_inicial: token, nova_senha: initialPass
        }}), 403); // Origin obrigatório
        error(await api(h, '/api/admin/auth/bootstrap', { method: 'POST', origin: h.origin, json: {
            token_inicial: 'token-invalido', nova_senha: initialPass
        }}), 403);
        const data = { token_inicial: token, nova_senha: initialPass };
        const pair = await Promise.all([0,1].map(() => api(h, '/api/admin/auth/bootstrap',
            { method:'POST', origin:h.origin, json:data })));
        assert.deepEqual(pair.map(x => x.status).sort(), [201,409]);
        assert.equal((await api(h, '/api/admin/auth/status')).data.configurado, true);
        const stored = await h.sql('SELECT * FROM AdminCredencial WHERE id=1');
        assert.equal(stored.kdf, 'scrypt');
        assert.equal(stored.senha_hash.length, 64);
        assert.ok(stored.salt.length >= 16);
        assert.doesNotMatch(JSON.stringify(stored), /senha-ficticia/);
        error(await api(h, '/api/admin/auth/bootstrap', { method:'POST', origin:h.origin, json:data }), 409);
        const users = await h.sql('SELECT COUNT(*) AS n FROM AdminCredencial');
        assert.equal(users.n, 1);
        const attempts = ['incorreta', 'incorreta2'];
        for (const senha of attempts) error(await api(h, '/api/admin/auth/login',
            { method:'POST', origin:h.origin, json:{ senha } }), 401);
        error(await api(h, '/api/admin/auth/login',
            { method:'POST', json:{ senha:initialPass } }), 403);
        const login = await api(h, '/api/admin/auth/login',
            { method:'POST', origin:h.origin, json:{ senha:initialPass } });
        assert.equal(login.status, 200);
        assert.deepEqual(login.data, { autenticado:true });
        assert.match(login.headers.get('set-cookie'), /HttpOnly/);
        assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
        assert.doesNotMatch(login.headers.get('set-cookie'), /Domain=/);
        assert.ok(login.cookie.startsWith('mural_admin_sid='));
        const c1 = login.cookie;
        const empty = await api(h, '/api/turmas');
        error(empty, 401);
        const s1 = await api(h, '/api/admin/auth/session', { cookie:c1 });
        assert.equal(s1.status, 200);
        assert.match(s1.data.csrf_token, /^[0-9a-f]{64}$/);
        assert.equal((await api(h, '/api/admin/auth/session', { cookie:c1 })).data.csrf_token,
            s1.data.csrf_token);
        assert.equal(s1.headers.get('cache-control'), 'no-store');
        assert.equal((await api(h, '/api/turmas', { cookie:c1 })).data.length, 2);
        assert.equal((await api(h, '/api/admin/publicacoes', { cookie:c1 })).data.length, 2);
        const wall = await api(h, '/api/publicacoes/token/abc123');
        assert.equal(wall.status, 200);
        assert.equal(wall.data.publicacoes.length, 2);
        assert.equal((await api(h, '/api/publicacoes/token/def456')).data.publicacoes.length, 1);
        for (const args of [
            { cookie:c1, origin:h.origin },
            { cookie:c1, origin:'null', csrf:s1.data.csrf_token },
            { cookie:c1, origin:'https://outro.exemplo', csrf:s1.data.csrf_token },
            { cookie:c1, csrf:s1.data.csrf_token },
            { cookie:c1, origin:h.origin, csrf:'0'.repeat(64) }
        ]) {
            error(await api(h, '/api/publicacoes', { method:'POST', ...args,
                form: { titulo:'Nao salvar', tipo:'Evento', data:'2026-11-11',
                    destino:'geral', imagem:Buffer.from('nao salva') } }), 403);
        }
        assert.equal(fs.readdirSync(h.uploadDir).length, 0);
        assert.equal((await api(h, '/api/admin/publicacoes', { cookie:c1 })).data.length, 2);
        const saved = await api(h, '/api/publicacoes', { method:'POST', cookie:c1,
            origin:h.origin, csrf:s1.data.csrf_token,
            form:{ titulo:'Pode salvar', data:'2026-11-11', tipo:'Evento', destino:'geral' } });
        assert.equal(saved.status, 201);
        assert.equal((await api(h, '/api/admin/publicacoes', { cookie:c1 })).data.length, 3);

        const other = await api(h, '/api/admin/auth/login',
            { method:'POST', origin:h.origin, json:{ senha:initialPass } });
        assert.equal(other.status, 200);
        const c2=other.cookie;
        assert.notEqual(c1,c2);
        const s2 = await api(h, '/api/admin/auth/session', { cookie:c2 });
        assert.equal(s2.status, 200);
        assert.notEqual(s1.data.csrf_token, s2.data.csrf_token);
        assert.equal((await api(h, '/api/admin/auth/session', { cookie:c1 })).status, 200);
        const idleLogin = await api(h, '/api/admin/auth/login', {
            method:'POST', origin:h.origin, json:{ senha:initialPass }
        });
        assert.equal(idleLogin.status, 200);
        await h.sql('UPDATE AdminSessoes SET ultimo_uso_em=? WHERE sid_digest=?',
            [Date.now() - 31 * 60 * 1000,
                require('node:crypto').createHash('sha256').update(
                    Buffer.from(idleLogin.cookie.split('=')[1], 'hex')).digest()], 'run');
        error(await api(h, '/api/admin/auth/session', {cookie:idleLogin.cookie}), 401);
        const absoluteLogin = await api(h, '/api/admin/auth/login', {
            method:'POST', origin:h.origin, json:{ senha:initialPass }
        });
        assert.equal(absoluteLogin.status, 200);
        await h.sql('UPDATE AdminSessoes SET expira_absoluto_em=? WHERE sid_digest=?',
            [Date.now() - 1, require('node:crypto').createHash('sha256').update(
                Buffer.from(absoluteLogin.cookie.split('=')[1], 'hex')).digest()], 'run');
        error(await api(h, '/api/admin/auth/session', {cookie:absoluteLogin.cookie}),401);
        const oldWrong=await api(h, '/api/admin/auth/change-password', { method:'POST',
            cookie:c1, csrf:s1.data.csrf_token, origin:h.origin,
            json:{ senha_atual:'senha-errada', nova_senha:changedPass } });
        error(oldWrong,403);
        const changed=await api(h, '/api/admin/auth/change-password', { method:'POST',
            cookie:c1, csrf:s1.data.csrf_token, origin:h.origin,
            json:{ senha_atual:initialPass, nova_senha:changedPass } });
        assert.equal(changed.status,204);
        assert.equal(changed.raw,'');
        assert.match(changed.headers.get('set-cookie') || '', /(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/);
        error(await api(h, '/api/admin/auth/session', { cookie:c1 }),401);
        error(await api(h, '/api/admin/auth/session', { cookie:c2 }),401);
        error(await api(h, '/api/admin/auth/login',
            { method:'POST', origin:h.origin, json:{ senha:initialPass } }),401);
        const fresh=await api(h, '/api/admin/auth/login', { method:'POST',
            origin:h.origin, json:{ senha:changedPass } });
        assert.equal(fresh.status,200);
        const session=await api(h, '/api/admin/auth/session', { cookie:fresh.cookie });
        const logout=await api(h, '/api/admin/auth/logout', { method:'POST',
            cookie:fresh.cookie, origin:h.origin, csrf:session.data.csrf_token });
        assert.equal(logout.status,204);
        assert.equal(logout.raw,'');
        error(await api(h, '/api/admin/auth/session', { cookie:fresh.cookie }),401);
        // 5 falhas por origem em 15 minutos, depois 429 com Retry-After inteiro.
        for (let i=0;i<5;i++) error(await api(h, '/api/admin/auth/login',
            { method:'POST', origin:h.origin, json:{ senha:'errada-'+i } }),401);
        const limited=await api(h, '/api/admin/auth/login',
            { method:'POST', origin:h.origin, json:{ senha:'errada-6' } });
        error(limited,429);
        assert.match(limited.headers.get('retry-after'), /^\d+$/);
        assert.equal((await h.sql('PRAGMA user_version')).user_version,101);
        assert.ok(!fs.existsSync(path.join(h.app,'banco.db')));
    } finally { await h.close(); }
});
