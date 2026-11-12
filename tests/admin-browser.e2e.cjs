'use strict';

/**
 * Browser E2E: the real V1 admin.html served by the real Express server
 * and a disposable SQLite database. Requires playwright only on CI runner.
 * No production secrets, DB, uploads or HTTP mocks are used.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');

const sourceRoot = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-v1-browser-'));
const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-v1-uploads-'));
const secret = crypto.randomBytes(24).toString('hex');
const injection = '<img src=x onerror="window.__executouXss=true">';
let server;
let db;
let browser;
let context;
let base;
let processOutput = '';

function execute(sql, values = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, values, function (err) {
            err ? reject(err) : resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

async function freePort() {
    const socket = net.createServer();
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.listen(0, '127.0.0.1', resolve);
    });
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return port;
}

async function startServer() {
    fs.mkdirSync(path.join(temp, 'public'), { recursive: true });
    for (const name of ['server.js', 'database.js']) {
        fs.copyFileSync(path.join(sourceRoot, name), path.join(temp, name));
    }
    fs.copyFileSync(path.join(sourceRoot, 'public', 'admin.html'),
        path.join(temp, 'public', 'admin.html'));
    fs.symlinkSync(path.join(sourceRoot, 'node_modules'),
        path.join(temp, 'node_modules'), 'dir');
    assert.notEqual(path.join(temp, 'banco.db'), path.join(sourceRoot, 'banco.db'));

    base = 'http://127.0.0.1:' + await freePort();
    server = spawn(process.execPath, ['server.js'], {
        cwd: temp,
        env: { ...process.env, PORT: new URL(base).port, ADMIN_SECRET_KEY: secret,
            NODE_ENV: 'test', MURAL_UPLOAD_DIR: uploads },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => { processOutput += chunk.toString().slice(0, 1000); });
    server.stderr.on('data', chunk => { processOutput += chunk.toString().slice(0, 1000); });

    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        if (server.exitCode !== null || server.signalCode !== null) {
            throw new Error('Express terminou antes do teste (verificar dependências e inicialização)');
        }
        try {
            const res = await fetch(base + '/api/turmas', {
                headers: { Authorization: secret },
                signal: AbortSignal.timeout(500)
            });
            if (res.status === 200) { ready = true; break; }
        } catch { /* Aguarda SQLite inicializar. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Servidor Express/SQLite indisponível');
    const dbFile = path.join(temp, 'banco.db');
    assert.ok(fs.existsSync(dbFile), 'SQLite deve ser criado no diretório temporário');
    db = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(dbFile, err =>
            err ? reject(err) : resolve(connection));
    });
    await execute('PRAGMA foreign_keys = ON');
}

async function seed() {
    const a = (await execute('INSERT INTO Turmas (nome_turma, codigo_acesso) VALUES (?,?)',
        ['Turma Alfa', 'aaaaaa'])).id;
    const b = (await execute('INSERT INTO Turmas (nome_turma, codigo_acesso) VALUES (?,?)',
        ['Turma Beta', 'bbbbbb'])).id;
    const insert = 'INSERT INTO Publicacoes (titulo, descricao, data, tipo, imagem_url, turma_id) VALUES (?,?,?,?,?,?)';
    await execute(insert, ['Evento para todos', 'Descrição de teste', '2026-11-11', 'Evento', null, null]);
    await execute(insert, [injection, 'Descrição inofensiva', '2026-11-11', 'Evento', null, a]);
    await execute(insert, ['Aviso turma Beta', 'Conteúdo de teste', '2026-11-11', 'Evento', null, b]);
}

async function cleanup() {
    if (context) await context.close();
    if (browser) await browser.close();
    if (db) await new Promise((resolve, reject) =>
        db.close(err => err ? reject(err) : resolve()));
    if (server && server.exitCode === null && server.signalCode === null) {
        server.kill('SIGTERM');
        await Promise.race([
            new Promise(resolve => server.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);
        if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    }
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(uploads, { recursive: true, force: true });
}

test('V1: painel real em Chromium com Express e SQLite temporários', { timeout: 90000 }, async t => {
    try {
        await startServer();
        await seed();
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({
            permissions: ['clipboard-read', 'clipboard-write']
        });
        const page = await context.newPage();
        const requests = [];
        const dialogs = [];
        page.on('request', request => {
            const url = new URL(request.url());
            if (url.origin !== base || !url.pathname.startsWith('/api/')) return;
            const header = request.headers()['authorization'];
            requests.push({
                pathname: url.pathname.replace(/\/token\/[^/]+/, '/token/[redacted]'),
                method: request.method(), hasAuth: Boolean(header),
                validAuth: header === secret
            });
        });
        page.on('dialog', async dialog => {
            // Não registrar o texto completo: alertas podem conter links com tokens.
            dialogs.push({ type: dialog.type(),
                category: /já existe/.test(dialog.message()) ? 'duplicada'
                    : /exclu/.test(dialog.message()) ? 'exclusao' : 'outro' });
            await dialog.accept();
        });
        // A CDN de CSS não deve ser necessária para os testes funcionais.
        await page.route('https://cdn.tailwindcss.com/**', route => route.abort());
        const response = await page.goto(base + '/admin.html', { waitUntil: 'domcontentloaded' });
        assert.equal(response.status(), 200);
        await page.addStyleTag({ content: '.hidden { display: none !important; }' });

        const $ = selector => page.locator(selector);
        const status = $('#estado-admin');
        const load = $('#btn-carregar-dados');
        const list = $('#lista-publicacoes');
        const row = value => list.locator(':scope > div').filter({ hasText: value });

        await t.test('não solicita listagens protegidas antes de autenticar', async () => {
            assert.equal(requests.filter(r => r.method === 'GET'
                && ['/api/turmas', '/api/admin/publicacoes'].includes(r.pathname)).length, 0);
            assert.match(await status.innerText(), /Informe a senha/);
        });

        await t.test('senha inválida: 401 e nenhum dado sensível no painel', async () => {
            await $('#senha_admin').fill('credencial-incorreta');
            await load.click();
            await page.waitForFunction(() => document.querySelector('#estado-admin')
                .textContent.includes('inválida'));
            assert.match(await status.innerText(), /inválida/);
            assert.equal(await $('#turma_id option').count(), 1);
            assert.equal(requests.some(r => r.pathname === '/api/turmas'
                && r.hasAuth && !r.validAuth), true);
            assert.equal(requests.some(r => r.pathname === '/api/admin/publicacoes'), false);
        });

        await t.test('senha correta: Authorization nos dois GETs e Geral/turmas', async () => {
            await $('#senha_admin').fill(secret);
            await load.click();
            await page.waitForFunction(() => document.querySelector('#estado-admin')
                .textContent.includes('carregadas'));
            assert.ok(requests.some(r => r.method === 'GET' && r.pathname === '/api/turmas' && r.validAuth));
            assert.ok(requests.some(r => r.method === 'GET' && r.pathname === '/api/admin/publicacoes' && r.validAuth));
            assert.equal(await $('#turma_id option').count(), 3);
            assert.equal(await row('Evento para todos').count(), 1);
            assert.match(await row('Evento para todos').innerText(), /Geral/);
            assert.match(await row('Aviso turma Beta').innerText(), /Turma Beta/);
            const editarGeral = row('Evento para todos').getByRole('button', { name: 'Editar' });
            // Lote 1: edição geral desabilitada; Lote 2: CRUD geral habilitado.
            if (await $('#publicacao-geral').count()) {
                assert.equal(await editarGeral.isEnabled(), true);
            } else {
                assert.equal(await editarGeral.isDisabled(), true);
            }
        });

        await t.test('texto vindo do SQLite não executa HTML/JS', async () => {
            assert.equal(await row(injection).count(), 1);
            assert.equal(await row(injection).locator('img').count(), 0);
            assert.equal(await page.evaluate(() => window.__executouXss === true), false);
        });

        await t.test('troca de senha limpa dados administrativos antigos', async () => {
            await $('#senha_admin').fill('outra-senha-incorreta');
            assert.equal(await $('#turma_id option').count(), 1);
            assert.equal(await row('Evento para todos').count(), 0);
            await $('#senha_admin').fill(secret);
            await load.click();
            await page.waitForFunction(() => document.querySelector('#estado-admin')
                .textContent.includes('carregadas'));
        });

        await t.test('cadastra turma, rejeita duplicidade e preserva código', async () => {
            await page.getByTitle('Cadastrar nova turma').click();
            await $('#nova-turma-nome').fill('Turma Nova');
            await $('#nova-turma-senha').fill(secret);
            await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
            await page.waitForFunction(() => Array.from(document.querySelectorAll('#turma_id option'))
                .some(option => option.textContent === 'Turma Nova'));
            assert.equal(await $('#turma_id option').count(), 4);

            await page.getByTitle('Cadastrar nova turma').click();
            await $('#nova-turma-nome').fill('Turma Nova');
            await $('#nova-turma-senha').fill(secret);
            const duplicateResponse = page.waitForResponse(response =>
                response.url() === base + '/api/turmas' &&
                response.request().method() === 'POST' && response.status() === 400);
            await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
            await duplicateResponse;
            if (await $('#notificacao-mensagem').count()) {
                await page.waitForFunction(() =>
                    document.querySelector('#notificacao-mensagem')?.textContent.includes('já existe'));
                assert.match(await $('#notificacao-mensagem').innerText(), /já existe/);
            } else {
                assert.ok(dialogs.some(d => d.category === 'duplicada'));
            }
            assert.equal(await $('#turma_id option').count(), 4);
            await page.getByRole('button', { name: 'Cancelar' }).click();
        });

        await t.test('copia link válido /?token= sem registrar token', async () => {
            await $('#turma_id').selectOption({ label: 'Turma Nova' });
            await page.getByRole('button', { name: 'Copiar Link Mágico' }).click();
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            const url = new URL(copied);
            assert.equal(url.origin, base);
            assert.equal(url.pathname, '/');
            assert.equal([...url.searchParams.keys()].join(','), 'token');
            assert.match(url.searchParams.get('token'), /^[0-9a-f]{6}$/);
            // O workspace descartável serve admin.html, não copia index.html.
            // Validamos o token via endpoint real, sem exigir uma homepage de teste.
            const valid = await fetch(base + '/api/publicacoes/token/' +
                encodeURIComponent(url.searchParams.get('token')));
            assert.equal(valid.status, 200);
            const invalid = await fetch(base + '/api/publicacoes/token/invalido');
            assert.equal(invalid.status, 404);
        });

        await t.test('cria, edita e exclui publicação específica pela interface real', async () => {
            await $('#turma_id').selectOption({ label: 'Turma Nova' });
            await $('#titulo').fill('Publicação temporária');
            await $('#descricao').fill('Conteúdo fictício');
            await $('#data').fill('2026-11-11');
            await $('#tipo').selectOption('Evento');
            await page.getByRole('button', { name: 'Publicar', exact: true }).click();
            await row('Publicação temporária').waitFor();
            assert.equal(requests.some(r => r.pathname === '/api/publicacoes'
                && r.method === 'POST' && r.validAuth), true);

            await row('Publicação temporária').getByRole('button', { name: 'Editar' }).click();
            assert.equal(await $('#titulo').inputValue(), 'Publicação temporária');
            await $('#titulo').fill('Publicação editada');
            await page.getByRole('button', { name: 'Salvar Alterações' }).click();
            await row('Publicação editada').waitFor();
            assert.equal(await row('Publicação temporária').count(), 0);
            assert.equal(requests.some(r => /^\/api\/publicacoes\/[0-9]+$/.test(r.pathname)
                && r.method === 'PUT' && r.validAuth), true);

            await row('Publicação editada').getByRole('button', { name: 'Excluir' }).click();
            await page.waitForFunction(() => !document.querySelector('#lista-publicacoes')
                .textContent.includes('Publicação editada'));
            assert.ok(dialogs.some(d => d.type === 'confirm'));
            assert.equal(requests.some(r => /^\/api\/publicacoes\/[0-9]+$/.test(r.pathname)
                && r.method === 'DELETE' && r.validAuth), true);
        });
    } finally {
        await cleanup();
    }
});
