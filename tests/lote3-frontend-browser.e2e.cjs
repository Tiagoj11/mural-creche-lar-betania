'use strict';

// Teste opcional de navegador real (Node + Playwright Chromium).
// Executar após instalar Playwright: node --test tests/lote3-frontend-browser.e2e.cjs
// Não pertence ao glob npm test e não altera o workflow compartilhado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const publicRoot = path.resolve(__dirname, '..', 'public');
const fotos = {
    vertical: [360, 900], horizontal: [1200, 600],
    quadrada: [640, 640], panoramica: [1600, 240]
};
let quantidadeDeConsultas = 0;

function respostaJson(res, status, objeto) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store' });
    res.end(JSON.stringify(objeto));
}

function servidorDescartavel() {
    return http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        // O E2E Lote 3 usa HTTP sintético. Para validar a nova tela de login,
        // simular apenas o estado "configurado, sem sessão"; nunca criar
        // credenciais ou autenticar o visitante neste teste público.
        if (req.method === 'GET' && url.pathname === '/api/admin/auth/session') {
            return respostaJson(res, 401, { erro: 'Sessão não autenticada.' });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/auth/status') {
            return respostaJson(res, 200, { configurado: true });
        }
        if (url.pathname.startsWith('/api/publicacoes/token/')) {
            quantidadeDeConsultas++;
            if (url.pathname !== '/api/publicacoes/token/valid123') {
                return respostaJson(res, 404, { erro: 'Link inválido' });
            }
            return respostaJson(res, 200, {
                nome_turma: 'Turma de teste',
                publicacoes: [
                    ...Object.keys(fotos).map((formato, i) => ({
                        id: i + 1, titulo: formato, descricao: 'Imagem fictícia de teste',
                        data: '2026-11-11', tipo: 'Evento',
                        turma_id: i === 0 ? null : 1,
                        imagem_url: '/uploads/' + formato + '.png'
                    })),
                    { id: 99, titulo: '<img src=x onerror=alert(1)>',
                        descricao: '<script>alert(1)</script>',
                        data: '2026-11-11', tipo: 'Aviso Geral', turma_id: null,
                        imagem_url: '/uploads/ausente.png' }
                ]
            });
        }

        const name = /^\/uploads\/([a-z]+)\.png$/.exec(url.pathname)?.[1];
        if (name && fotos[name]) {
            const [width, height] = fotos[name];
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width +
                '" height="' + height + '"><rect width="100%" height="100%" fill="#b83b43"/>' +
                '<rect x="3" y="3" width="' + (width - 6) + '" height="' + (height - 6) +
                '" fill="none" stroke="#fff" stroke-width="6"/></svg>';
            res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
            return res.end(svg);
        }
        // Caminhos públicos existentes, sem acesso fora de public/.
        const target = path.resolve(publicRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!target.startsWith(publicRoot + path.sep) ||
            !fs.existsSync(target) || !fs.statSync(target).isFile()) {
            res.writeHead(404); return res.end();
        }
        const ext = path.extname(target);
        const mime = {
            '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
            '.webmanifest': 'application/manifest+json', '.png': 'image/png',
            '.jpg': 'image/jpeg'
        };
        res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store' });
        fs.createReadStream(target).pipe(res);
    });
}

test('Lote 3: Chromium PWA localhost e quatro proporções sem cache sensível',
    { timeout: 90000 }, async () => {
        const server = servidorDescartavel();
        let browser;
        try {
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            const origin = 'http://127.0.0.1:' + server.address().port;
            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext({ serviceWorkers: 'allow' });
            const page = await context.newPage();
            await page.route('https://cdn.tailwindcss.com/**', route => route.abort());
            await page.goto(origin + '/?token=valid123', { waitUntil: 'load' });
            // O CSS de imagens não depende do CDN de Tailwind.
            await page.addStyleTag({ content: '.hidden{display:none!important}.max-w-md{max-width:28rem}' +
                '.mx-auto{margin-left:auto;margin-right:auto}.px-4{padding-left:1rem;padding-right:1rem}' });
            await page.locator('#sec-geral article').first().waitFor();
            const ready = await page.evaluate(async () => {
                const reg = await navigator.serviceWorker.ready;
                return reg.active?.state;
            });
            assert.equal(ready, 'activated');
            const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
            assert.equal(manifest.start_url, '/');
            assert.equal(manifest.scope, '/');
            assert.equal(manifest.icons.length, 2);

            for (const [width, height] of [[320, 640], [375, 760], [430, 850], [1280, 900]]) {
                await page.setViewportSize({ width, height });
                const entries = [];

                // Cada aba precisa estar visível antes de rolar e decodificar
                // imagens lazy. Não tentar scrollIntoView em #sec-turma oculta.
                for (const [aba, secao] of [
                    ['#tab-geral', '#sec-geral'],
                    ['#tab-turma', '#sec-turma']
                ]) {
                    await page.locator(aba).click();
                    await page.locator(secao).waitFor({ state: 'visible' });
                    if (secao === '#sec-geral') {
                        // Força o lazy-load do arquivo ausente e exige seu tratamento;
                        // não tenta decodificar uma imagem removida pelo onerror.
                        await page.locator('#sec-geral article').last().scrollIntoViewIfNeeded();
                        await page.locator('#sec-geral img[src="/uploads/ausente.png"]')
                            .waitFor({ state: 'detached' });
                    }
                    const formatosDaAba = secao === '#sec-geral'
                        ? ['vertical'] : ['horizontal', 'quadrada', 'panoramica'];
                    for (const formato of formatosDaAba) {
                        const img = page.locator(secao + ' article')
                            .filter({ has: page.locator('h2', { hasText: formato }) })
                            .locator('img');
                        await img.scrollIntoViewIfNeeded();
                        await img.evaluate(node => node.decode());
                    }
                    const medidas = await page.locator(secao + ' article')
                        .evaluateAll(articles => articles.flatMap(article => {
                            const img = article.querySelector('img');
                            if (!img) return [];
                            const box = img.getBoundingClientRect();
                            const card = article.getBoundingClientRect();
                            return [{
                                formato: article.querySelector('h2')?.textContent,
                                natWidth: img.naturalWidth, natHeight: img.naturalHeight,
                                boxWidth: box.width, boxHeight: box.height,
                                withinCard: box.left >= card.left - 1 && box.right <= card.right + 1,
                                maxAllowed: Math.min(window.innerHeight * .56, 416),
                                overflow: document.documentElement.scrollWidth > window.innerWidth
                            }];
                        }));
                    entries.push(...medidas);
                }
                assert.equal(entries.length, 4, 'Todos os formatos foram medidos');
                assert.deepEqual(entries.map(e => e.formato).sort(),
                    Object.keys(fotos).sort(), 'Vertical, horizontal, quadrada e panorâmica');
                for (const e of entries) {
                    assert.deepEqual([e.natWidth, e.natHeight], fotos[e.formato],
                        'Dimensões naturais de ' + e.formato);
                    assert.ok(Math.abs(e.boxWidth / e.boxHeight -
                        e.natWidth / e.natHeight) < .01, 'Sem deformar/cortar imagem');
                    assert.ok(e.boxHeight <= e.maxAllowed + 1, 'Altura responsiva');
                    assert.ok(e.withinCard && !e.overflow, 'Sem overflow horizontal');
                }
            }
            // Testes de XSS e imagens ausentes exigem que Geral esteja visível.
            await page.locator('#tab-geral').click();
            await page.locator('#sec-geral').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#sec-geral [onerror]').count(), 0);
            assert.equal(await page.locator('#sec-geral img[src="/uploads/ausente.png"]').count(), 0);
            assert.match(await page.locator('#sec-geral').innerText(), /<img src=x onerror/);

            const cached = await page.evaluate(async () => {
                const names = await caches.keys();
                const urls = (await Promise.all(names.map(async name =>
                    (await caches.open(name)).keys()))).flat().map(r => new URL(r.url).pathname);
                return { names, urls };
            });
            assert.ok(cached.urls.includes('/assets/Logo.jpg'));
            assert.ok(!cached.urls.some(p => p.startsWith('/api/') || p.startsWith('/uploads/') ||
                p === '/' || p === '/admin.html' || p.endsWith('.html')));
            const initial = quantidadeDeConsultas;
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.locator('#sec-geral article').first().waitFor();
            assert.ok(quantidadeDeConsultas > initial, 'Mural continua network-only');

            await page.goto(origin + '/?token=invalido', { waitUntil: 'domcontentloaded' });
            await page.locator('#tab-apoie').click();
            assert.match(await page.locator('#sec-apoie').innerText(), /Dados para doação/);
            const adminResponse = await page.goto(origin + '/admin.html', {
                waitUntil: 'domcontentloaded'
            });
            assert.equal(adminResponse.status(), 200);
            await page.locator('#auth-login').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#auth-shell').isVisible(), true);
            assert.equal(await page.locator('#form-login').isVisible(), true);
            assert.equal(await page.locator('#login-senha').count(), 1);
            assert.equal(await page.locator('#login-senha').getAttribute('type'), 'password');
            assert.equal(await page.locator('#login-senha').getAttribute('autocomplete'),
                'current-password');
            assert.equal(await page.locator('#form-login input[type="password"]').count(), 1,
                'Login deve solicitar somente uma senha.');
            assert.equal(await page.locator('#senha_admin').count(), 0,
                'Campo legado de senha por operação deve estar ausente.');
            assert.equal(await page.locator('#admin-panel').isHidden(), true,
                'Sem sessão, dados e operações administrativas devem permanecer ocultos.');
            await context.close();
        } finally {
            if (browser) await browser.close();
            await new Promise(resolve => server.close(resolve));
        }
    });
