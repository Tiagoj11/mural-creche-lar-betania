'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const pixJs = fs.readFileSync(path.join(root, 'pix.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const swJs = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const PIX = '83.526.640/0001-67';

function fixture({ clipboard } = {}) {
    const ids = [
        'pix-chave', 'btn-copiar-pix', 'btn-selecionar-pix', 'pix-ajuda-manual',
        'pix-notificacao', 'pix-aviso-mensagem', 'pix-aviso-icone', 'pix-aviso-fechar'
    ];
    const elements = Object.fromEntries(ids.map(id => [id, {
        id, textContent: '', hidden: id === 'pix-notificacao' || id === 'pix-ajuda-manual',
        disabled: false, dataset: {}, attributes: {}, listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; },
        setAttribute(name, value) { this.attributes[name] = value; },
        focus() { this.focused = true; }
    }]));
    const documentListeners = {};
    let selectedNode = null;
    let removed = 0;
    let timerDuration = null;
    let timerCallback = null;
    let clipboardCalls = 0;
    const selected = [];
    const document = {
        readyState: 'loading',
        getElementById(id) { return elements[id] || null; },
        addEventListener(name, callback) { documentListeners[name] = callback; },
        createRange() {
            return { selectNodeContents(el) { selectedNode = el; } };
        }
    };
    const window = {
        clearTimeout() { removed++; },
        setTimeout(fn, duration) {
            timerCallback = fn;
            timerDuration = duration;
            return 1;
        },
        getSelection() {
            return {
                removeAllRanges() { selected.length = 0; },
                addRange() { selected.push(selectedNode); }
            };
        }
    };
    const navigator = {};
    if (clipboard !== null) {
        navigator.clipboard = {
            async writeText(value) {
                clipboardCalls++;
                if (clipboard) return clipboard(value);
                return undefined;
            }
        };
    }
    vm.runInNewContext(pixJs, { window, document, navigator });
    assert.equal(typeof documentListeners.DOMContentLoaded, 'function');
    documentListeners.DOMContentLoaded();
    const click = id => elements[id].listeners.click();
    return {
        el: elements, click, selected, get clipboardCalls() { return clipboardCalls; },
        get timerDuration() { return timerDuration; },
        closeTimer() { timerCallback?.(); },
        get timeoutClears() { return removed; }
    };
}

test('PIX-RF-01..03: beneficiário, chave literal e controles públicos', () => {
    assert.match(html, /Associação Assistencial Lar Betânia/);
    assert.match(html, /id="pix-chave"[^>]*>83\.526\.640\/0001-67<\/p>/);
    assert.match(html, /id="btn-copiar-pix"/);
    assert.match(html, />\s*Copiar chave PIX\s*<\/button>/);
    assert.match(html, /id="btn-selecionar-pix"/);
    assert.match(html, /<script src="pix\.js" defer><\/script>/);
    assert.equal((pixJs.match(/83\.526\.640\/0001-67/g) || []).length, 1);
    assert.doesNotMatch(html, /12\.345\.678\/0001-90|Dados para doação serão disponibilizados/);
});

test('PIX-CA-02/03: sucesso ocorre somente após resolver Clipboard API com valor exato', async () => {
    let resolve;
    const calls = [];
    const app = fixture({ clipboard(value) {
        calls.push(value);
        return new Promise(done => { resolve = done; });
    }});
    const pending = app.click('btn-copiar-pix');
    assert.deepEqual(calls, [PIX]);
    assert.equal(app.el['pix-notificacao'].hidden, true);
    assert.equal(app.el['btn-copiar-pix'].disabled, true);
    await app.click('btn-copiar-pix'); // dupla submissão não copia novamente
    assert.equal(calls.length, 1);
    resolve();
    await pending;
    assert.equal(app.el['pix-aviso-mensagem'].textContent, 'Chave PIX copiada com sucesso!');
    assert.equal(app.el['pix-notificacao'].hidden, false);
    assert.equal(app.el['pix-notificacao'].dataset.estado, 'sucesso');
    assert.equal(app.el['pix-notificacao'].attributes.role, 'status');
    assert.equal(app.el['pix-notificacao'].attributes['aria-live'], 'polite');
    assert.equal(app.el['pix-aviso-icone'].textContent, '✓');
    assert.equal(app.el['btn-copiar-pix'].disabled, false);
    assert.equal(app.timerDuration, 4500);
    app.closeTimer();
    assert.equal(app.el['pix-notificacao'].hidden, true);
});

test('PIX-CA-04: permissão negada mostra erro e seleciona chave para cópia manual', async () => {
    const app = fixture({ clipboard: () => Promise.reject(new Error('NotAllowedError')) });
    await app.click('btn-copiar-pix');
    assert.equal(app.clipboardCalls, 1);
    assert.equal(app.el['pix-notificacao'].dataset.estado, 'erro');
    assert.equal(app.el['pix-notificacao'].attributes.role, 'alert');
    assert.equal(app.el['pix-notificacao'].attributes['aria-live'], 'assertive');
    assert.match(app.el['pix-aviso-mensagem'].textContent, /copiar manualmente/);
    assert.doesNotMatch(app.el['pix-aviso-mensagem'].textContent, /copiada com sucesso/);
    assert.equal(app.el['pix-ajuda-manual'].hidden, false);
    assert.equal(app.el['pix-chave'].focused, true);
    assert.equal(app.selected[0], app.el['pix-chave']);
});

test('PIX-CA-04: Clipboard API ausente nunca confirma cópia; botão manual funciona', async () => {
    const app = fixture({ clipboard: null });
    await app.click('btn-copiar-pix');
    assert.equal(app.clipboardCalls, 0);
    assert.equal(app.el['pix-notificacao'].dataset.estado, 'erro');
    assert.equal(app.el['pix-aviso-mensagem'].textContent.includes('sucesso'), false);
    assert.equal(app.el['pix-ajuda-manual'].hidden, false);
    app.el['pix-ajuda-manual'].hidden = true;
    app.click('btn-selecionar-pix');
    assert.equal(app.el['pix-ajuda-manual'].hidden, false);
    assert.equal(app.selected[0], app.el['pix-chave']);
    app.click('pix-aviso-fechar');
    assert.equal(app.el['pix-notificacao'].hidden, true);
});

test('PIX-CA-05: viewport, quebra de texto, teclado e leitores de tela', () => {
    assert.match(html, /<meta name="viewport" content="width=device-width/);
    assert.match(html, /\.pix-chave\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    assert.match(html, /\.pix-chave:focus-visible/);
    assert.match(html, /id="pix-chave" tabindex="0"/);
    assert.match(html, /id="pix-ajuda-manual" hidden role="status"/);
    assert.match(html, /id="pix-notificacao" role="status" aria-live="polite" hidden/);
    assert.match(html, /id="pix-aviso-fechar" aria-label="Fechar aviso PIX"/);
    assert.match(html, /id="btn-copiar-pix"[\s\S]*?min-h-\[44px\]/);
    assert.match(html, /id="btn-selecionar-pix"[\s\S]*?min-h-\[44px\]/);
    const app = fixture();
    app.click('btn-selecionar-pix');
    assert.equal(app.selected[0], app.el['pix-chave']);
});

test('PIX-RF-07..09: sem QR, pagamentos automáticos, backend ou alteração do mural/PWA', () => {
    assert.doesNotMatch(html, /QR Code Aqui|pix copia e cola|payload de pagamento/i);
    assert.doesNotMatch(pixJs, /fetch\s*\(|XMLHttpRequest|\/api\/|localStorage|sessionStorage|eval\s*\(/);
    assert.match(html, /id="sec-apoie"/);
    assert.match(html, /onclick="switchTab\('apoie'\)"/);
    assert.match(html, /function switchTab\(tabName\)/);
    assert.match(appJs, /new URLSearchParams\(window\.location\.search\)\.get\('token'\)/);
    assert.match(appJs, /if \(!tokenAtual\) \{/);
    assert.match(appJs, /A área Apoie está disponível sem link/);
    assert.match(html, /rel="manifest"/);
    assert.match(html, /serviceWorker\.register\('\/sw\.js'/);
    assert.match(swJs, /const PUBLIC_PATHS = new Set\(PUBLIC_ASSETS\)/);
    assert.doesNotMatch(swJs, /'\/pix\.js'|\/api\/publicacoes\/token\/[^']+/);
});
