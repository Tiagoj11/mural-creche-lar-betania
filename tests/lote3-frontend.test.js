'use strict';

// Suíte isolada do Frontend Lote 3, executada por npm test sem navegador nem
// banco real. Os testes visuais/instalabilidade continuam em cenário Chromium.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const swSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function pngSize(file) {
    const bytes = fs.readFileSync(path.join(root, 'assets', file));
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('manifest instalável sem token e ícones PNG reais de 192/512', () => {
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.lang, 'pt-BR');
    assert.equal(manifest.theme_color, '#b83b43');
    assert.equal(fs.existsSync(path.join(root, 'assets', 'pwa-icon-192.png')), true);
    assert.equal(fs.existsSync(path.join(root, 'assets', 'pwa-icon-512.png')), true);
    assert.deepEqual(pngSize('pwa-icon-192.png'), [192, 192]);
    assert.deepEqual(pngSize('pwa-icon-512.png'), [512, 512]);
    assert.deepEqual(manifest.icons.map(i => i.sizes), ['192x192', '512x512']);
    assert.deepEqual(manifest.icons.map(i => i.src), [
        '/assets/pwa-icon-192.png', '/assets/pwa-icon-512.png'
    ]);
    assert.ok(manifest.icons.every(i => i.type === 'image/png' && i.purpose === 'any'));
    assert.doesNotMatch(JSON.stringify(manifest), /[?&](token|turma)=|\/api\/|\/admin\.html/);
});

function swHarness() {
    const listeners = {};
    const calls = { added: [], matches: [], deleted: [], network: [], claimed: 0, skipped: 0 };
    const cache = {
        async addAll(items) { calls.added.push(...items); },
        async match(request) {
            calls.matches.push(request.url);
            return { cached: true, path: new URL(request.url).pathname };
        }
    };
    const caches = {
        async open(name) { calls.openName = name; return cache; },
        async keys() { return ['mural-public-static-antiga', 'outro-site-cache',
            'mural-public-static-v1', 'mural-public-static-v2', 'mural-public-static-v3']; },
        async delete(name) { calls.deleted.push(name); return true; }
    };
    const self = {
        location: { origin: 'https://mural.example' },
        clients: { async claim() { calls.claimed++; } },
        async skipWaiting() { calls.skipped++; },
        addEventListener(name, handler) { listeners[name] = handler; }
    };
    vm.runInNewContext(swSource, {
        self, caches, URL,
        async fetch(request) { calls.network.push(request.url); return { network: true }; }
    });
    async function dispatch(type, request) {
        let pending, response;
        const event = {
            request,
            waitUntil(p) { pending = p; },
            respondWith(p) { response = p; }
        };
        listeners[type](event);
        if (pending) await pending;
        return response ? await response : null;
    }
    return { calls, dispatch };
}

function request(path, method = 'GET', mode = 'no-cors', authorization = false) {
    return {
        url: new URL(path, 'https://mural.example').toString(),
        method, mode,
        headers: { has(key) { return authorization && key === 'authorization'; } }
    };
}

test('service worker pré-armazena somente logo, ícones e manifest', async () => {
    const { calls, dispatch } = swHarness();
    await dispatch('install');
    assert.deepEqual(Array.from(calls.added), [
        '/assets/Logo.jpg', '/assets/pwa-icon-192.png',
        '/assets/pwa-icon-512.png', '/manifest.webmanifest'
    ]);
    assert.equal(calls.skipped, 1);
    assert.equal(calls.openName, 'mural-public-static-v3');
    assert.ok(calls.added.every(v => !/[?]|\/api|\/uploads|\.html|token|turma/.test(v)));
});

test('ativação remove só caches antigos do próprio PWA', async () => {
    const { calls, dispatch } = swHarness();
    await dispatch('activate');
    assert.deepEqual(Array.from(calls.deleted), [
        'mural-public-static-antiga', 'mural-public-static-v1', 'mural-public-static-v2'
    ]);
    assert.equal(calls.claimed, 1);
});

test('SW mantém network-only navegação, API, uploads, admin, tokens e queries', async () => {
    const { calls, dispatch } = swHarness();
    const paths = [
        request('/?token=abc123', 'GET', 'navigate'),
        request('/?turma=A', 'GET', 'navigate'),
        request('/', 'GET', 'navigate'),
        request('/admin.html', 'GET', 'navigate'),
        request('/api/turmas'),
        request('/api/admin/publicacoes'),
        request('/api/publicacoes/token/abc123'),
        request('/uploads/arquivo.jpg'),
        request('/app.js'),
        request('/manifest.webmanifest?token=abc123'),
        request('/assets/pwa-icon-192.png?turma=A'),
        request('/assets/pwa-icon-512.png', 'GET', 'navigate'),
        request('/assets/Logo.jpg', 'GET', 'no-cors', true),
        request('https://cdn.tailwindcss.com/'),
        request('/assets/Logo.jpg', 'POST')
    ];
    for (const value of paths) {
        assert.equal(await dispatch('fetch', value), null, value.url);
    }
    assert.equal(calls.matches.length, 0);
    const allowed = await dispatch('fetch', request('/assets/pwa-icon-192.png'));
    assert.equal(allowed.cached, true);
    assert.equal(allowed.path, '/assets/pwa-icon-192.png');
    assert.equal(calls.matches.length, 1);
});

test('manifest, HTML, painel e SW apontam apenas para os ícones PNG reais', () => {
    const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    assert.deepEqual(manifest.icons.map(icon => icon.src),
        ['/assets/pwa-icon-192.png', '/assets/pwa-icon-512.png']);
    for (const icon of manifest.icons) {
        const diskFile = path.resolve(root, '.' + icon.src);
        assert.ok(diskFile.startsWith(root + path.sep));
        assert.equal(fs.existsSync(diskFile), true, 'Ícone ausente: ' + icon.src);
        assert.deepEqual(pngSize(path.basename(icon.src)), icon.sizes.split('x').map(Number));
        assert.ok(swSource.includes("'" + icon.src + "'"), 'SW não pré-carrega ' + icon.src);
    }
    assert.match(html, /rel="icon"[^>]*href="\/assets\/pwa-icon-192\.png"/);
    assert.match(html, /rel="apple-touch-icon" href="\/assets\/pwa-icon-192\.png"/);
    assert.match(adminHtml, /rel="icon"[^>]*href="\/assets\/pwa-icon-192\.png\?v=3"/);
    for (const value of [html, adminHtml, swSource, JSON.stringify(manifest)])
        assert.doesNotMatch(value, /\/assets\/pwa-logo-(192|512)\.png/);
});

test('index registra SW em contexto seguro e mantém shell pública sem token', () => {
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /window\.isSecureContext/);
    assert.match(html, /serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/);
    assert.match(html, /id="sec-apoie"/);
    assert.doesNotMatch(html, /urlParams\.get\('turma'\)|pix-key|QR Code Aqui/);
});

function appHarness() {
    class El {
        constructor(tag) {
            this.tagName = tag;
            this.style = {};
            this.children = [];
            this.events = {};
            this.textContent = '';
            this.className = '';
            this.removed = false;
        }
        appendChild(item) { this.children.push(item); return item; }
        addEventListener(name, fn) { this.events[name] = fn; }
        remove() { this.removed = true; }
    }
    const document = {
        createElement(tag) { return new El(tag); },
        getElementById() { return new El('div'); },
        addEventListener() {}
    };
    const context = vm.createContext({
        document,
        window: { location: { origin: 'https://mural.example', search: '?token=teste' } },
        URLSearchParams, fetch: async () => { throw new Error('Não deveria haver rede neste teste'); }
    });
    vm.runInContext(appSource, context);
    return pub => {
        context.pub = pub;
        return vm.runInContext('criarCartaoPublicacao(pub, true)', context);
    };
}

test('imagem conserva proporção e limite de altura; erro remove imagem quebrada', () => {
    const render = appHarness();
    for (const formato of ['vertical', 'horizontal', 'quadrada', 'panorâmica']) {
        const card = render({
            titulo: 'Imagem ' + formato, tipo: 'Evento', descricao: 'Teste',
            imagem_url: '/uploads/1234567890abcd.jpg'
        });
        const image = card.children[0];
        assert.equal(image.tagName, 'img');
        assert.equal(image.loading, 'lazy');
        assert.equal(image.className, 'imagem-mural');
        assert.match(html, /\.imagem-mural\s*\{/);
        assert.match(html, /max-height:\s*min\(56vh,\s*26rem\)/);
        assert.match(html, /object-fit:\s*contain/);
        assert.doesNotMatch(html, /\.imagem-mural\s*\{[^}]*object-fit:\s*cover/);
        assert.equal(typeof image.onerror, 'function');
        image.onerror();
        assert.equal(image.removed, true);
        assert.equal(image.onerror, null);
    }
});

test('imagem ausente ou URL externa não produz tag img nem HTML executável', () => {
    const render = appHarness();
    for (const url of [null, '', 'javascript:alert(1)', 'https://externo.example/foto.jpg',
        '/uploads/../../segredo.jpg', '/uploads/foto.png?token=abc']) {
        const card = render({
            titulo: '<img src=x onerror=alert(1)>', descricao: '<script>falha</script>',
            tipo: 'Evento', imagem_url: url
        });
        assert.equal(card.children.filter(node => node.tagName === 'img').length, 0);
        assert.equal(card.children[0].children[1].textContent, '<img src=x onerror=alert(1)>');
        assert.equal(card.children[0].children[2].textContent, '<script>falha</script>');
    }
});
