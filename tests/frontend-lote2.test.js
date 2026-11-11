'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

class Element {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.listeners = {};
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.required = false;
        this.hidden = false;
        this.textContent = '';
        this.className = '';
        this.selectedIndex = 0;
        this.attributes = {};
        this.classList = { add() {}, remove() {}, toggle() {} };
    }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...items) { this.children = items; }
    setAttribute(name, value) { this.attributes[name] = value; }
    reset() { this.value = ''; }
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html || ''; }
    get options() { return this.children; }
}

function makeDocument(ids) {
    const elements = Object.fromEntries(ids.map(id => [
        id, new Element(id === 'turma_id' ? 'select' : 'div')
    ]));
    const events = {};
    return {
        elements,
        events,
        document: {
            getElementById(id) { return elements[id] || null; },
            createElement(tag) { return new Element(tag); },
            addEventListener(name, handler) { events[name] = handler; }
        }
    };
}

function parseScript(html) {
    const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g));
    assert.equal(scripts.length, 1);
    return scripts[0][1];
}

async function settle() {
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
}

class FakeFormData {
    constructor(form) {
        this.fields = new Map([
            ['titulo', form.title || 'Publicação de teste'],
            ['pub_id', form.pubId || ''],
            ['turma_id', form.turmaId || ''],
            ['senha_admin', form.senha || ''],
            ['imagem', null]
        ]);
    }
    get(key) { return this.fields.get(key); }
    set(key, value) { this.fields.set(key, value); }
    delete(key) { this.fields.delete(key); }
    has(key) { return this.fields.has(key); }
}

function setupAdmin() {
    const ids = [
        'senha_admin', 'turma_id', 'lista-publicacoes', 'estado-admin',
        'btn-carregar-dados', 'form-publicacao', 'pub_id', 'titulo',
        'descricao', 'data', 'tipo', 'form-title', 'btn-submit',
        'nova-turma-nome', 'nova-turma-senha', 'modal-turma',
        'publicacao-geral', 'imagem-preservada', 'notificacao',
        'notificacao-mensagem', 'notificacao-icone', 'notificacao-fechar'
    ];
    const { document, elements: el, events } = makeDocument(ids);
    const requests = [];
    const notices = [];
    const clipboard = [];
    const response = (data, status = 200) => ({ ok: status >= 200 && status < 300,
        status, json: async () => data });
    const fetchMock = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith('/api/turmas')) {
            if (options.method === 'POST') {
                return response({ id: 2, nome_turma: 'B', codigo_acesso: 'def456' }, 201);
            }
            return response([{ id: 1, nome_turma: 'A', codigo_acesso: 'abc123' }]);
        }
        if (url.endsWith('/api/admin/publicacoes')) {
            return response([
                { id: 10, titulo: '<img src=x onerror=alert(1)>',
                    descricao: 'Descrição', data: '2026-11-11',
                    tipo: 'Evento', turma_id: null, nome_turma: null, imagem_url: null },
                { id: 11, titulo: 'Aviso A', descricao: 'Somente A',
                    data: '2026-11-11', tipo: 'Cardápio', turma_id: 1,
                    nome_turma: 'A', imagem_url: '/uploads/abc123.jpg' }
            ]);
        }
        return response({ mensagem: 'OK' });
    };
    const context = vm.createContext({
        document,
        window: { location: { origin: 'https://mural.example' }, scrollTo() {} },
        navigator: { clipboard: { writeText: async value => clipboard.push(value) } },
        fetch: fetchMock,
        FormData: FakeFormData,
        alert: () => { throw new Error('alert() rotineiro não permitido'); },
        confirm: () => true,
        setTimeout: () => 1,
        clearTimeout() {}
    });
    vm.runInContext(parseScript(adminHtml), context);
    events.DOMContentLoaded();
    return { context, el, requests, notices, clipboard };
}

test('checkbox Geral limpa e bloqueia turma; desmarcar exige nova escolha', () => {
    const { el } = setupAdmin();
    el.turma_id.value = '1';
    el['publicacao-geral'].checked = true;
    el['publicacao-geral'].listeners.change();
    assert.equal(el.turma_id.value, '');
    assert.equal(el.turma_id.disabled, true);
    assert.equal(el.turma_id.required, false);
    el['publicacao-geral'].checked = false;
    el['publicacao-geral'].listeners.change();
    assert.equal(el.turma_id.value, '');
    assert.equal(el.turma_id.disabled, false);
    assert.equal(el.turma_id.required, true);
});

test('Geral e específica podem ser editadas, sem restaurar seleção ao mudar destino', async () => {
    const { el } = setupAdmin();
    el.senha_admin.value = 'senha-de-teste';
    await el['btn-carregar-dados'].listeners.click();
    const linhas = el['lista-publicacoes'].children;
    assert.equal(linhas.length, 2);
    const editarGeral = linhas[0].children[1].children[0];
    assert.equal(editarGeral.disabled, false);
    editarGeral.listeners.click();
    assert.equal(el['publicacao-geral'].checked, true);
    assert.equal(el.turma_id.disabled, true);
    assert.equal(el.turma_id.value, '');
    const editarEspecifica = linhas[1].children[1].children[0];
    editarEspecifica.listeners.click();
    assert.equal(el['publicacao-geral'].checked, false);
    assert.equal(el.turma_id.value, '1');
    el['publicacao-geral'].checked = true;
    el['publicacao-geral'].listeners.change();
    el['publicacao-geral'].checked = false;
    el['publicacao-geral'].listeners.change();
    assert.equal(el.turma_id.value, '');
});

test('POST Geral remove turma_id e PUT Turma envia destino separadamente', async () => {
    const { el, requests } = setupAdmin();
    el.senha_admin.value = 'senha-de-teste';
    el['form-publicacao'].title = 'Teste Geral';
    el['form-publicacao'].pubId = '';
    el['publicacao-geral'].checked = true;
    await el['form-publicacao'].listeners.submit({
        preventDefault() {}, target: el['form-publicacao']
    });
    const post = requests.find(r => r.options.method === 'POST' &&
        r.url.endsWith('/api/publicacoes'));
    assert.ok(post);
    assert.equal(post.options.body.get('destino'), 'geral');
    assert.equal(post.options.body.has('turma_id'), false);
    assert.equal(post.options.body.has('senha_admin'), false);
    assert.equal(post.options.headers.Authorization, 'senha-de-teste');

    el['publicacao-geral'].checked = false;
    el.turma_id.value = '1';
    el['form-publicacao'].pubId = '11';
    el['form-publicacao'].turmaId = '1';
    await el['form-publicacao'].listeners.submit({
        preventDefault() {}, target: el['form-publicacao']
    });
    const put = requests.find(r => r.options.method === 'PUT');
    assert.ok(put);
    assert.equal(put.options.body.get('destino'), 'turma');
    assert.equal(put.options.body.get('turma_id'), '1');
    assert.equal(put.options.headers.Authorization, 'senha-de-teste');
});

test('avisos centralizados, fecháveis e sem executar conteúdo HTML', async () => {
    const { el } = setupAdmin();
    el.senha_admin.value = 'senha-de-teste';
    await el['btn-carregar-dados'].listeners.click();
    const first = el['lista-publicacoes'].children[0];
    assert.match(first.children[0].children[1].textContent, /<img/);
    assert.equal(first.children[0].children[1].children.length, 0);
    el.turma_id.value = '';
    await el['form-publicacao'].listeners.submit({
        preventDefault() {}, target: el['form-publicacao']
    });
    assert.match(el['notificacao-mensagem'].textContent, /Selecione uma turma/);
    assert.equal(el.notificacao.attributes.role, 'alert');
    assert.match(el.notificacao.className, /left-1\/2/);
    el['notificacao-fechar'].listeners.click();
    assert.equal(el.notificacao.hidden, true);
    assert.doesNotMatch(adminHtml, /\bwindow\.alert\s*\(/);
});

function setupPublic(search, payload, status = 200) {
    const ids = ['sec-geral', 'conteudo-turma', 'turma-titulo', 'header-turma'];
    const { document, elements: el, events } = makeDocument(ids);
    const requests = [];
    const context = vm.createContext({
        document,
        window: { location: { origin: 'https://mural.example', search } },
        URLSearchParams,
        fetch: async url => {
            requests.push(url);
            return { ok: status === 200, status, json: async () => payload };
        }
    });
    vm.runInContext(appJs, context);
    return { el, events, requests };
}

test('mural mostra Geral em área própria e específica, sem executar payload HTML', async () => {
    const unsafe = '<img src=x onerror=alert(1)>';
    const { el, events, requests } = setupPublic('?token=abc123', {
        nome_turma: 'Turma A',
        publicacoes: [
            { turma_id: null, titulo: unsafe, descricao: '<script>alert(1)</script>',
                tipo: 'Evento', data: '2026-11-11', imagem_url: 'javascript:alert(1)' },
            { turma_id: 1, titulo: 'Da Turma A', descricao: 'Conteúdo',
                tipo: 'Cardápio', data: '2026-11-11', imagem_url: '/uploads/1234abcd.png' }
        ]
    });
    await events.DOMContentLoaded();
    assert.equal(requests.length, 1);
    assert.match(el['header-turma'].textContent, /Turma A/);
    assert.equal(el['sec-geral'].children.length, 1);
    assert.equal(el['conteudo-turma'].children.length, 1);
    const card = el['sec-geral'].children[0];
    assert.equal(card.children.length, 1, 'URL insegura não cria imagem');
    assert.equal(card.children[0].children[1].textContent, unsafe);
    assert.equal(card.children[0].children[2].textContent, '<script>alert(1)</script>');
    const turmaCard = el['conteudo-turma'].children[0];
    assert.equal(turmaCard.children[0].src, '/uploads/1234abcd.png');
});

test('token ausente ou inválido não consulta outras turmas e mantém Apoie disponível', async () => {
    const ausente = setupPublic('', {});
    await ausente.events.DOMContentLoaded();
    assert.equal(ausente.requests.length, 0);
    assert.match(ausente.el['sec-geral'].children[0].children[0].textContent,
        /Link de turma necessário/);
    const invalido = setupPublic('?token=invalido', {}, 404);
    await invalido.events.DOMContentLoaded();
    assert.equal(invalido.requests.length, 1);
    assert.match(invalido.el['sec-geral'].children[0].children[0].textContent,
        /Mural indisponível/);
    assert.ok(indexHtml.includes('id="sec-apoie"'));
    assert.match(indexHtml, /Dados para doação serão disponibilizados após confirmação do CEI/);
    assert.doesNotMatch(indexHtml, /pix-key|QR Code Aqui|Festa Junina Solidária/);
});
