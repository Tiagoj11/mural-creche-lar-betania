'use strict';

/**
 * Lote 2 - acceptance E2E for a COMBINED Backend+Frontend checkout.
 * NOT part of npm test / baseline V1 CI. Manual CI opt-in only.
 * Real Express, isolated SQLite/uploads, real Chromium; no API/DOM mocks.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-lote2-e2e-'));
const uploads = path.join(workspace, 'upload-external');
const secret = crypto.randomBytes(32).toString('hex');
const date = '2026-11-11';
const malicious = '<img src=x onerror="window.__muralXss=1">';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB3sAAAAASUVORK5CYII=', 'base64');
let server, database, browser, base;
let capturedOutput = '';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(sql, params = []) {
    return new Promise((resolve, reject) =>
        database.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        }));
}
async function port() {
    const socket = net.createServer();
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.listen(0, '127.0.0.1', resolve);
    });
    const result = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return result;
}
async function request(route, options = {}) {
    const headers = {};
    if (options.admin) headers.Authorization = secret;
    let body;
    if (options.form) {
        body = new FormData();
        for (const [key, value] of Object.entries(options.form)) body.set(key, String(value));
    }
    if (options.image) {
        if (!body) body = new FormData();
        body.set('imagem', new Blob([options.image.data], { type: options.image.type }),
            options.image.name);
    }
    const response = await fetch(base + route, {
        method: options.method || 'GET', headers, body, signal: AbortSignal.timeout(8000)
    });
    if (options.raw) return response;
    assert.match(response.headers.get('content-type') || '', /^application\/json\b/,
        'Resposta JSON obrigatória: ' + route.replace(/\/token\/.*/, '/token/[oculto]'));
    return { status: response.status, data: await response.json() };
}
async function start() {
    fs.mkdirSync(uploads, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(workspace, 'public'), { recursive: true });
    for (const name of ['server.js', 'database.js']) {
        fs.copyFileSync(path.join(project, name), path.join(workspace, name));
    }
    for (const name of ['index.html', 'app.js', 'admin.html']) {
        fs.copyFileSync(path.join(project, 'public', name), path.join(workspace, 'public', name));
    }
    fs.symlinkSync(path.join(project, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
    base = 'http://127.0.0.1:' + await port();
    server = spawn(process.execPath, ['server.js'], {
        cwd: workspace,
        env: { ...process.env, NODE_ENV: 'test', PORT: new URL(base).port,
            ADMIN_SECRET_KEY: secret, MURAL_UPLOAD_DIR: uploads },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const capture = chunk => {
        // Truncate and redact; do not print logs in normal successful run.
        capturedOutput = (capturedOutput + chunk.toString()).slice(-2000);
    };
    server.stdout.on('data', capture);
    server.stderr.on('data', capture);
    let alive = false;
    for (let i = 0; i < 100; i++) {
        assert.ok(server.exitCode === null && server.signalCode === null,
            'Express encerrou antes de inicializar');
        try {
            const response = await request('/api/turmas', { admin: true });
            if (response.status === 200) { alive = true; break; }
        } catch { /* Aguardar startup. */ }
        await sleep(100);
    }
    assert.ok(alive, 'Express/SQLite não iniciou em até 10 segundos');
    const filepath = path.join(workspace, 'banco.db');
    assert.ok(fs.existsSync(filepath));
    database = await new Promise((resolve, reject) => {
        const instance = new sqlite3.Database(filepath, err =>
            err ? reject(err) : resolve(instance));
    });
    await run('PRAGMA foreign_keys = ON');
}
async function seed() {
    const alpha = (await run('INSERT INTO Turmas(nome_turma,codigo_acesso) VALUES (?,?)',
        ['Alfa E2E', 'aaaaaa'])).id;
    const beta = (await run('INSERT INTO Turmas(nome_turma,codigo_acesso) VALUES (?,?)',
        ['Beta E2E', 'bbbbbb'])).id;
    return { alpha, beta };
}
async function shutdown() {
    if (browser) await browser.close();
    if (database) await new Promise((resolve, reject) =>
        database.close(err => err ? reject(err) : resolve()));
    if (server && server.exitCode === null && server.signalCode === null) {
        server.kill('SIGTERM');
        await Promise.race([
            new Promise(resolve => server.once('exit', resolve)),
            sleep(3000)
        ]);
        if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    }
    fs.rmSync(workspace, { recursive: true, force: true });
}
function publication(form = {}) {
    return {
        titulo: form.titulo || 'Evento fictício',
        descricao: form.descricao || 'Descrição fictícia',
        data: date,
        tipo: 'Evento',
        ...form
    };
}
function validUploadName(relative) {
    assert.match(relative, /^\/uploads\/[a-zA-Z0-9._-]+\.(png|jpe?g|gif|webp|avif)$/);
    assert.ok(!relative.includes('..'));
}
async function showToast(page, regex, type) {
    const note = page.locator('[role="status"],[role="alert"]').filter({ hasText: regex }).last();
    await note.waitFor({ state: 'visible' });
    const rect = await note.boundingBox();
    assert.ok(rect, 'Aviso deve ser visível');
    const viewport = page.viewportSize();
    assert.ok(Math.abs(rect.x + rect.width / 2 - viewport.width / 2) < viewport.width * 0.15,
        'Aviso deve ficar CENTRALIZADO horizontalmente');
    assert.ok(rect.y < viewport.height * 0.25, 'Aviso deve aparecer NO TOPO');
    const className = (await note.getAttribute('class')) || '';
    // A implementação pode usar classes Tailwind ou estilos próprios;
    // verificar cor computada sem exigir biblioteca de UI.
    const colors = await note.evaluate(el => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, color: style.color };
    });
    assert.notEqual(colors.background, 'rgba(0, 0, 0, 0)');
    assert.notEqual(colors.color, colors.background);
    if (type === 'error') assert.equal(await note.getAttribute('role'), 'alert');
    return note;
}

test('Lote 2 - integração combinada real: API/SQLite/Chromium/uploads', { timeout: 120000 }, async t => {
    try {
        await start();
        const { alpha, beta } = await seed();
        let id;
        let imagePath;

        await t.test('HTTP: geral NULL, destino obsoleto e duas turmas isoladas', async () => {
            const created = await request('/api/publicacoes', {
                admin: true, method: 'POST',
                form: publication({ titulo: 'Geral do CEI',
                    destino: 'geral', turma_id: String(alpha) })
            });
            assert.equal(created.status, 201);
            id = created.data.id;
            const admin = await request('/api/admin/publicacoes', { admin: true });
            assert.equal(admin.status, 200);
            const general = admin.data.find(p => p.id === id);
            assert.equal(general.turma_id, null, 'Geral deve ignorar turma obsoleta e persistir NULL');

            const specific = await request('/api/publicacoes', {
                admin: true, method: 'POST',
                form: publication({ titulo: 'Só Alfa', destino: 'turma', turma_id: String(alpha) })
            });
            assert.equal(specific.status, 201);

            for (const [code, expected] of [
                ['aaaaaa', 'Alfa E2E'], ['bbbbbb', 'Beta E2E']
            ]) {
                const result = await request('/api/publicacoes/token/' + code);
                assert.equal(result.status, 200);
                assert.equal(result.data.nome_turma, expected);
                assert.ok(result.data.publicacoes.some(p => p.id === id && p.turma_id === null));
                assert.doesNotMatch(JSON.stringify(result.data), /codigo_acesso|aaaaaa|bbbbbb/);
                assert.equal(result.data.publicacoes.some(p => p.titulo === 'Só Alfa'),
                    code === 'aaaaaa');
            }
            const bad = await request('/api/publicacoes/token/invalido');
            assert.equal(bad.status, 404);
            assert.equal(typeof bad.data.erro, 'string');
            assert.doesNotMatch(JSON.stringify(bad.data), /codigo_acesso|Alfa E2E|Beta E2E/);
        });

        await t.test('HTTP: alternância Geral↔Turma preserva ID e imagem', async () => {
            const toSpecific = await request('/api/publicacoes/' + id, {
                admin: true, method: 'PUT',
                form: publication({ titulo: 'Mudou para Beta',
                    destino: 'turma', turma_id: String(beta) })
            });
            assert.equal(toSpecific.status, 200);
            const admin = await request('/api/admin/publicacoes', { admin: true });
            assert.equal(admin.data.find(p => p.id === id).turma_id, beta);

            const back = await request('/api/publicacoes/' + id, {
                admin: true, method: 'PUT',
                form: publication({ titulo: 'Novamente Geral', destino: 'geral' })
            });
            assert.equal(back.status, 200);
            const check = await request('/api/admin/publicacoes', { admin: true });
            assert.equal(check.data.find(p => p.id === id).turma_id, null);

            const missing = await request('/api/publicacoes', {
                admin: true, method: 'POST',
                form: publication({ destino: 'turma' })
            });
            assert.equal(missing.status, 400);
            const invalid = await request('/api/publicacoes', {
                admin: true, method: 'POST',
                form: publication({ destino: 'turma', turma_id: '9999999' })
            });
            assert.equal(invalid.status, 400);
            const unauthorized = await request('/api/admin/publicacoes');
            assert.equal(unauthorized.status, 401);
        });

        await t.test('HTTP: upload externo, GET público, restrição e persistência', async () => {
            const uploaded = await request('/api/publicacoes', {
                admin: true, method: 'POST',
                form: publication({ titulo: 'Imagem isolada', destino: 'turma',
                    turma_id: String(alpha) }),
                image: { data: image, name: 'ilustracao.png', type: 'image/png' }
            });
            assert.equal(uploaded.status, 201);
            imagePath = uploaded.data.imagem_url;
            validUploadName(imagePath);
            const diskFile = path.join(uploads, path.basename(imagePath));
            assert.ok(fs.existsSync(diskFile), 'Imagem não foi gravada no caminho externo');
            assert.equal(fs.existsSync(path.join(workspace, 'public', 'uploads',
                path.basename(imagePath))), false, 'Não gravar imagens novas no checkout');
            const accessible = await request(imagePath, { raw: true });
            assert.equal(accessible.status, 200);
            assert.match(accessible.headers.get('content-type') || '', /^image\//);
            const unknown = await request('/uploads/nome-inexistente.png', { raw: true });
            assert.equal(unknown.status, 404);
            for (const traversal of [
                '/uploads/%2e%2e%2fserver.js',
                '/uploads/%2Fetc%2Fpasswd',
                '/uploads/..%5Cdatabase.js'
            ]) {
                const response = await request(traversal, { raw: true });
                assert.notEqual(response.status, 200, 'Traversal não pode devolver arquivo: ' + traversal);
            }
            const denied = await request('/api/publicacoes', {
                admin: true, method: 'POST',
                form: publication({ titulo: 'Upload proibido',
                    destino: 'turma', turma_id: String(alpha) }),
                image: { data: Buffer.from('teste'), type: 'text/plain', name: 'teste.txt' }
            });
            assert.equal(denied.status, 400);
            const updated = await request('/api/publicacoes/' + uploaded.data.id, {
                admin: true, method: 'PUT',
                form: publication({ titulo: 'Imagem preservada',
                    destino: 'geral' })
            });
            assert.equal(updated.status, 200);
            const admin = await request('/api/admin/publicacoes', { admin: true });
            const row = admin.data.find(p => p.id === uploaded.data.id);
            assert.equal(row.imagem_url, imagePath);
            assert.equal(row.turma_id, null);
            assert.equal((await request(imagePath, { raw: true })).status, 200);
        });

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            permissions: ['clipboard-read', 'clipboard-write']
        });
        const page = await context.newPage();
        page.on('dialog', dialog => dialog.accept());
        await page.route('https://cdn.tailwindcss.com/**', route => route.abort());
        const adminResponse = await page.goto(base + '/admin.html', {
            waitUntil: 'domcontentloaded'
        });
        assert.equal(adminResponse.status(), 200);
        await page.addStyleTag({ content: '.hidden { display: none !important; }' });

        await t.test('Chromium: checkbox Geral limpa/desabilita Turma e exige nova escolha', async () => {
            const password = page.locator('#senha_admin');
            await password.fill(secret);
            await page.locator('#btn-carregar-dados').click();
            await page.waitForFunction(() =>
                document.querySelector('#estado-admin')?.textContent.includes('carregadas'));
            const checkbox = page.getByRole('checkbox', { name: /Publicação geral/i });
            const team = page.locator('#turma_id');
            await team.selectOption({ label: 'Alfa E2E' });
            await checkbox.check();
            assert.equal(await team.inputValue(), '');
            assert.equal(await team.isDisabled(), true);
            assert.equal(await team.evaluate(el => el.required), false);
            await checkbox.uncheck();
            assert.equal(await team.isDisabled(), false);
            assert.equal(await team.inputValue(), '');
            assert.equal(await team.evaluate(el => el.required), true);
        });

        await t.test('Chromium: CRUD Geral, edição Geral↔Turma e feedback topo central', async () => {
            const checkbox = page.getByRole('checkbox', { name: /Publicação geral/i });
            const team = page.locator('#turma_id');
            await checkbox.check();
            await page.locator('#titulo').fill('Novo aviso geral E2E');
            await page.locator('#descricao').fill('Descrição fictícia');
            await page.locator('#data').fill(date);
            await page.locator('#tipo').selectOption('Evento');
            await page.locator('#form-publicacao button[type="submit"]').click();
            await page.locator('#lista-publicacoes').getByText('Novo aviso geral E2E').waitFor();
            await showToast(page, /cadastrad|criad|sucesso/i, 'success');
            const row = page.locator('#lista-publicacoes > div')
                .filter({ hasText: 'Novo aviso geral E2E' });
            await row.getByRole('button', { name: /Editar/i }).click();
            assert.equal(await checkbox.isChecked(), true);
            assert.equal(await team.isDisabled(), true);
            await checkbox.uncheck();
            assert.equal(await team.inputValue(), '');
            await team.selectOption({ label: 'Beta E2E' });
            await page.locator('#titulo').fill('Agora específico Beta E2E');
            await page.locator('#form-publicacao button[type="submit"]').click();
            await page.locator('#lista-publicacoes')
                .getByText('Agora específico Beta E2E').waitFor();
            const betaRow = page.locator('#lista-publicacoes > div')
                .filter({ hasText: 'Agora específico Beta E2E' });
            assert.match(await betaRow.innerText(), /Beta E2E/);
            await betaRow.getByRole('button', { name: /Excluir/i }).click();
            await page.waitForFunction(() =>
                !document.querySelector('#lista-publicacoes')
                    .textContent.includes('Agora específico Beta E2E'));
            await showToast(page, /exclu|removid|sucesso/i, 'success');
        });

        await t.test('Chromium: mural público Geral/Turma, tokens e XSS como texto', async () => {
            const pub = await request('/api/publicacoes', {
                admin: true, method: 'POST',
                form: publication({ titulo: malicious, descricao: malicious,
                    destino: 'geral' })
            });
            assert.equal(pub.status, 201);
            for (const [code, groupName] of [['aaaaaa', 'Alfa E2E'], ['bbbbbb', 'Beta E2E']]) {
                const publicPage = await context.newPage();
                try {
                    const response = await publicPage.goto(base + '/?token=' + code, {
                        waitUntil: 'domcontentloaded'
                    });
                    assert.equal(response.status(), 200);
                    await publicPage.locator('#sec-geral').getByText(malicious).first().waitFor();
                    assert.equal(await publicPage.evaluate(() => window.__muralXss === 1), false);
                    assert.equal(await publicPage.locator('#sec-geral img[onerror]').count(), 0);
                    assert.match(await publicPage.locator('#turma-titulo').innerText(),
                        new RegExp(groupName, 'i'));
                    assert.equal(await publicPage.locator('#sec-geral')
                        .getByText('Novamente Geral').count(), 1);
                } finally {
                    await publicPage.close();
                }
            }
            for (const suffix of ['', '?token=invalido']) {
                const publicPage = await context.newPage();
                try {
                    await publicPage.goto(base + '/' + suffix, { waitUntil: 'domcontentloaded' });
                    await publicPage.getByRole('button', { name: /Apoie/i }).click();
                    assert.equal(await publicPage.locator('#sec-apoie').isVisible(), true);
                    assert.equal(await publicPage.getByText('12.345.678/0001-90').count(), 0);
                } finally {
                    await publicPage.close();
                }
            }
        });

        await context.close();
    } finally {
        await shutdown();
    }
});
