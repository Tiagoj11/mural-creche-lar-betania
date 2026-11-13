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
    focus() { this.focused = true; }
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
    for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
}
class FakeFormData {
    constructor(form) {
        this.fields = new Map([
            ['titulo', form.title || 'Publicação de teste'],
            ['pub_id', form.pubId || ''],
            ['turma_id', form.turmaId || ''],
            ['imagem', form.image || null]
        ]);
    }
    get(key) { return this.fields.get(key); }
    set(key, value) { this.fields.set(key, value); }
    delete(key) { this.fields.delete(key); }
    has(key) { return this.fields.has(key); }
}
function setupAdmin(state = {}) {
    const ids = [
        'auth-shell', 'auth-estado', 'auth-login', 'auth-bootstrap', 'auth-change',
        'auth-bloqueado', 'admin-panel', 'acoes-sessao', 'form-login',
        'form-bootstrap', 'form-alterar-senha', 'login-senha', 'token-inicial',
        'bootstrap-senha', 'bootstrap-confirmar', 'senha-atual', 'senha-nova',
        'senha-confirmar', 'btn-entrar', 'btn-criar-senha', 'btn-confirmar-troca',
        'btn-cancelar-troca', 'btn-alterar-senha', 'btn-sair',
        'btn-verificar-sessao', 'btn-revalidar-sessao',
        'turma_id', 'lista-publicacoes', 'estado-admin', 'btn-carregar-dados',
        'form-publicacao', 'pub_id', 'titulo', 'descricao', 'data', 'tipo',
        'form-title', 'btn-submit', 'nova-turma-nome', 'modal-turma',
        'publicacao-geral', 'imagem-preservada', 'notificacao',
        'notificacao-mensagem', 'notificacao-icone', 'notificacao-fechar'
    ];
    const { document, elements: el, events } = makeDocument(ids);
    const requests = [];
    const clipboard = [];
    const fixture = Object.assign({
        configured: true, logged: false, password: 'senha-teste-valida-12',
        csrf: 'csrf-constante-por-sid', turmas: [
            { id: 1, nome_turma: 'Turma A', codigo_acesso: 'abc123' }
        ], publicacoes: [
            { id: 10, titulo: '<img src=x onerror=alert(1)>',
                descricao: 'Descrição', data: '2026-11-11',
                tipo: 'Evento', turma_id: null, nome_turma: null, imagem_url: null },
            { id: 11, titulo: 'Aviso A', descricao: 'Somente A',
                data: '2026-11-11', tipo: 'Cardápio', turma_id: 1,
                nome_turma: 'Turma A', imagem_url: '/uploads/abc123.jpg' }
        ], overrideStatus: null, waiting: null, logoutStatus: 204
    }, state);
    const response = (data, status = 200) => ({
        ok: status >= 200 && status < 300, status,
        json: async () => {
            if (status === 204) throw new Error('204 não admite JSON');
            return data;
        }
    });
    async function fetchMock(url, options = {}) {
        requests.push({ url, options });
        const pathname = new URL(url).pathname;
        const method = options.method || 'GET';
        if (fixture.waiting && pathname === '/api/admin/publicacoes')
            await fixture.waiting.promise;
        if (fixture.overrideStatus && pathname === fixture.overrideStatus.path) {
            const code = fixture.overrideStatus.code;
            fixture.overrideStatus = null;
            return response({ erro: 'Requisição não autorizada. Atualize o painel.' }, code);
        }
        if (pathname === '/api/admin/auth/session') {
            return fixture.logged
                ? response({ autenticado: true, csrf_token: fixture.csrf })
                : response({ erro: 'Sessão inexistente ou expirada.' }, 401);
        }
        if (pathname === '/api/admin/auth/status')
            return response({ configurado: fixture.configured });
        if (pathname === '/api/admin/auth/bootstrap') {
            if (fixture.configured)
                return response({ erro: 'Já configurado.' }, 409);
            const payload = JSON.parse(options.body);
            if (payload.token_inicial !== 'token-operador-ficticio')
                return response({ erro: 'Não autorizado.' }, 403);
            fixture.configured = true;
            fixture.password = payload.nova_senha;
            return response({ configurado: true }, 201);
        }
        if (pathname === '/api/admin/auth/login') {
            const payload = JSON.parse(options.body);
            if (payload.senha !== fixture.password)
                return response({ erro: 'Credenciais inválidas.' }, 401);
            fixture.logged = true;
            return response({ autenticado: true });
        }
        if (pathname === '/api/admin/auth/logout') {
            fixture.logged = false;
            return response(null, fixture.logoutStatus);
        }
        if (pathname === '/api/admin/auth/change-password') {
            if (!fixture.logged) return response({ erro: 'Sem sessão.' }, 401);
            const payload = JSON.parse(options.body);
            if (payload.senha_atual !== fixture.password)
                return response({ erro: 'Senha atual incorreta.' }, 403);
            fixture.password = payload.nova_senha;
            fixture.logged = false;
            return response(null, 204);
        }
        if (!fixture.logged)
            return response({ erro: 'Sem sessão.' }, 401);
        if (method !== 'GET' && options.headers?.['X-CSRF-Token'] !== fixture.csrf)
            return response({ erro: 'CSRF incorreto.' }, 403);
        if (pathname === '/api/turmas') {
            if (method === 'POST') {
                const data = JSON.parse(options.body);
                const turma = { id: fixture.turmas.length + 1,
                    nome_turma: data.nome_turma, codigo_acesso: 'def456' };
                fixture.turmas.push(turma);
                return response(turma, 201);
            }
            return response(fixture.turmas);
        }
        if (pathname === '/api/admin/publicacoes')
            return response(fixture.publicacoes);
        if (pathname.startsWith('/api/publicacoes')) {
            if (method === 'DELETE')
                fixture.publicacoes = fixture.publicacoes.filter(p =>
                    !pathname.endsWith('/' + p.id));
            return response({ mensagem: 'OK' });
        }
        throw new Error('API não simulada: ' + pathname);
    }
    const context = vm.createContext({
        document,
        window: { location: { origin: 'https://mural.example' }, scrollTo() {} },
        navigator: { clipboard: { writeText: async value => clipboard.push(value) } },
        fetch: fetchMock, FormData: FakeFormData,
        alert: () => { throw new Error('alert rotineiro é proibido'); },
        confirm: () => true, setTimeout: () => 1, clearTimeout() {}
    });
    vm.runInContext(parseScript(adminHtml), context);
    events.DOMContentLoaded();
    async function login(senha = fixture.password) {
        await settle();
        el['login-senha'].value = senha;
        await el['form-login'].listeners.submit({ preventDefault() {} });
        await settle();
    }
    async function enviar(formId, target = el[formId]) {
        await el[formId].listeners.submit({ preventDefault() {}, target });
        await settle();
    }
    return { el, events, requests, state: fixture, clipboard, context,
        login, enviar, settle };
}

test('cadastro inicial exige token do operador e não cria sessão', async () => {
    const app = setupAdmin({ configured: false });
    const { el, requests } = app;
    await settle();
    assert.equal(el['auth-bootstrap'].hidden, false);
    assert.equal(el['admin-panel'].hidden, true);
    assert.equal(requests.some(r => r.url.endsWith('/api/turmas')), false);
    el['token-inicial'].value = 'incorreto';
    el['bootstrap-senha'].value = 'senha-nova-bem-longa';
    el['bootstrap-confirmar'].value = 'senha-nova-bem-longa';
    await app.enviar('form-bootstrap');
    assert.equal(app.state.configured, false);
    assert.match(el['notificacao-mensagem'].textContent, /Não autorizado/);
    el['token-inicial'].value = 'token-operador-ficticio';
    el['bootstrap-senha'].value = 'senha-nova-bem-longa';
    el['bootstrap-confirmar'].value = 'senha-nova-bem-longa';
    await app.enviar('form-bootstrap');
    assert.equal(app.state.configured, true);
    assert.equal(app.state.logged, false);
    assert.equal(el['auth-login'].hidden, false);
    assert.equal(el['token-inicial'].value, '');
    await app.login('senha-nova-bem-longa');
    assert.equal(el['admin-panel'].hidden, false);
    assert.ok(requests.some(r => r.url.endsWith('/api/admin/auth/session')));
});

test('login único, senha incorreta e recuperação da sessão sem Authorization', async () => {
    const app = setupAdmin();
    const { el, requests, context } = app;
    await settle();
    assert.equal(el['auth-login'].hidden, false);
    await app.login('senha-errada');
    assert.equal(el['auth-login'].hidden, false);
    assert.equal(el['login-senha'].value, '');
    await app.login();
    assert.equal(el['admin-panel'].hidden, false);
    assert.equal(el['lista-publicacoes'].children.length, 2);
    assert.ok(requests.some(r => r.url.endsWith('/api/turmas')));
    for (const r of requests) {
        assert.equal(r.options.credentials, 'same-origin');
        assert.equal(r.options.headers?.Authorization, undefined);
        assert.equal(r.options.headers?.authorization, undefined);
        if (!r.options.method || r.options.method === 'GET')
            assert.equal(r.options.cache, 'no-store');
    }
    const count = requests.length;
    await vm.runInContext('verificarEstadoInicial()', context);
    assert.equal(el['admin-panel'].hidden, false);
    assert.ok(requests.length > count);
    assert.equal(app.state.csrf, 'csrf-constante-por-sid');
    assert.doesNotMatch(adminHtml, /localStorage|sessionStorage|id="senha_admin"/);
});

test('checkbox Geral e edição específica continuam funcionando sem HTML executável', async () => {
    const { el, login } = setupAdmin();
    await login();
    const linhas = el['lista-publicacoes'].children;
    assert.equal(linhas.length, 2);
    assert.match(linhas[0].children[0].children[1].textContent, /<img/);
    assert.equal(linhas[0].children[0].children[1].children.length, 0);
    linhas[0].children[1].children[0].listeners.click();
    assert.equal(el['publicacao-geral'].checked, true);
    assert.equal(el.turma_id.disabled, true);
    assert.equal(el.turma_id.value, '');
    linhas[1].children[1].children[0].listeners.click();
    assert.equal(el['publicacao-geral'].checked, false);
    assert.equal(el.turma_id.value, '1');
    el['publicacao-geral'].checked = true;
    el['publicacao-geral'].listeners.change();
    el['publicacao-geral'].checked = false;
    el['publicacao-geral'].listeners.change();
    assert.equal(el.turma_id.value, '');
    assert.equal(el.turma_id.required, true);
});

test('POST Geral e PUT Turma usam cookie/CSRF e não reenviam senha', async () => {
    const app = setupAdmin();
    const { el, requests } = app;
    await app.login();
    el['form-publicacao'].title = 'Aviso Geral';
    el['form-publicacao'].pubId = '';
    el['publicacao-geral'].checked = true;
    await app.enviar('form-publicacao');
    const post = requests.find(r => r.options.method === 'POST' &&
        r.url.endsWith('/api/publicacoes'));
    assert.ok(post);
    assert.equal(post.options.body.get('destino'), 'geral');
    assert.equal(post.options.body.has('turma_id'), false);
    assert.equal(post.options.body.has('senha_admin'), false);
    assert.equal(post.options.headers['X-CSRF-Token'], app.state.csrf);
    assert.equal(post.options.headers.Authorization, undefined);
    assert.equal(post.options.headers['Content-Type'], undefined);
    el['publicacao-geral'].checked = false;
    el.turma_id.value = '1';
    el['form-publicacao'].pubId = '11';
    el['form-publicacao'].turmaId = '1';
    await app.enviar('form-publicacao');
    const put = requests.find(r => r.options.method === 'PUT');
    assert.ok(put);
    assert.equal(put.options.body.get('destino'), 'turma');
    assert.equal(put.options.body.get('turma_id'), '1');
    assert.equal(put.options.headers['X-CSRF-Token'], app.state.csrf);
});

test('403 não repete mutação e revalidação explícita recupera CSRF', async () => {
    const app = setupAdmin();
    const { el, requests, state } = app;
    await app.login();
    el['publicacao-geral'].checked = true;
    state.overrideStatus = { path: '/api/publicacoes', code: 403 };
    await app.enviar('form-publicacao');
    assert.equal(el['btn-revalidar-sessao'].hidden, false);
    assert.match(el['notificacao-mensagem'].textContent, /Requisição não autorizada/);
    const before = requests.filter(r => r.options.method === 'POST' &&
        r.url.endsWith('/api/publicacoes')).length;
    el['btn-revalidar-sessao'].listeners.click();
    await settle();
    assert.equal(requests.filter(r => r.options.method === 'POST' &&
        r.url.endsWith('/api/publicacoes')).length, before);
    assert.equal(el['admin-panel'].hidden, false);
});

test('cadastro de turma, link e exclusão mantêm contratos anteriores', async () => {
    const app = setupAdmin();
    const { el, requests, clipboard } = app;
    await app.login();
    el['nova-turma-nome'].value = 'Turma B';
    await vm.runInContext('salvarNovaTurma()', app.context);
    assert.equal(app.state.turmas.length, 2);
    assert.equal(el.turma_id.children.some(e => e.textContent === 'Turma B'), true);
    const idx = el.turma_id.children.findIndex(e => e.textContent === 'Turma B');
    el.turma_id.selectedIndex = idx;
    await vm.runInContext('copiarLinkTurma()', app.context);
    assert.equal(clipboard.length, 1);
    assert.equal(new URL(clipboard[0]).searchParams.get('token'), 'def456');
    await vm.runInContext('deletarPublicacao(10)', app.context);
    assert.equal(app.state.publicacoes.length, 1);
    assert.ok(requests.some(r => r.options.method === 'DELETE'
        && r.options.headers['X-CSRF-Token'] === app.state.csrf));
});

test('logout 204 não tenta ler JSON, limpa painel e não persiste token', async () => {
    const app = setupAdmin();
    const { el, requests } = app;
    await app.login();
    await el['btn-sair'].listeners.click();
    assert.equal(app.state.logged, false);
    assert.equal(el['admin-panel'].hidden, true);
    assert.equal(el['auth-login'].hidden, false);
    assert.equal(el.turma_id.children.length, 0);
    assert.equal(el['lista-publicacoes'].children.length, 0);
    assert.ok(requests.some(r => r.url.endsWith('/api/admin/auth/logout')
        && r.options.headers['X-CSRF-Token'] === 'csrf-constante-por-sid'));
    assert.doesNotMatch(adminHtml, /window\.alert\s*\(|localStorage|sessionStorage/);
});

test('troca de senha: 403 não desloga, 204 revoga sessão e volta ao login', async () => {
    const app = setupAdmin();
    const { el } = app;
    await app.login();
    el['btn-alterar-senha'].listeners.click();
    assert.equal(el['auth-change'].hidden, false);
    el['senha-atual'].value = 'errada';
    el['senha-nova'].value = 'outra-senha-ficticia-123';
    el['senha-confirmar'].value = 'outra-senha-ficticia-123';
    await app.enviar('form-alterar-senha');
    assert.equal(app.state.logged, true);
    assert.equal(el['auth-change'].hidden, false);
    el['senha-atual'].value = app.state.password;
    el['senha-nova'].value = 'outra-senha-ficticia-123';
    el['senha-confirmar'].value = 'outra-senha-ficticia-123';
    await app.enviar('form-alterar-senha');
    assert.equal(app.state.logged, false);
    assert.equal(el['admin-panel'].hidden, true);
    assert.equal(el['auth-login'].hidden, false);
    await app.login('outra-senha-ficticia-123');
    assert.equal(el['admin-panel'].hidden, false);
});

test('401 revogado limpa dados antes de qualquer resposta tardia', async () => {
    const app = setupAdmin();
    const { el, state, requests } = app;
    await app.login();
    state.logged = false;
    await el['btn-carregar-dados'].listeners.click();
    assert.equal(el['admin-panel'].hidden, true);
    assert.equal(el['auth-login'].hidden, false);
    assert.equal(el['lista-publicacoes'].children.length, 0);
    assert.equal(el.turma_id.children.length, 0);
    assert.ok(requests.filter(r => r.url.endsWith('/api/turmas')).length > 0);
    // A versão anterior não deve reapresentar dados se for concluída após logout.
    state.logged = true;
    await app.login();
    let resolve;
    state.waiting = { promise: new Promise(r => { resolve = r; }) };
    const pending = el['btn-carregar-dados'].listeners.click();
    await settle();
    const logout = el['btn-sair'].listeners.click();
    resolve();
    await Promise.all([pending, logout]);
    assert.equal(el['admin-panel'].hidden, true);
    assert.equal(el['lista-publicacoes'].children.length, 0);
});

test('avisos acessíveis, sem HTML injetado, e validação de destino', async () => {
    const app = setupAdmin();
    const { el } = app;
    await app.login();
    el['publicacao-geral'].checked = false;
    el.turma_id.value = '';
    await app.enviar('form-publicacao');
    assert.match(el['notificacao-mensagem'].textContent, /Selecione uma turma/);
    assert.equal(el.notificacao.attributes.role, 'alert');
    assert.match(el.notificacao.className, /left-1\/2/);
    el['notificacao-fechar'].listeners.click();
    assert.equal(el.notificacao.hidden, true);
});


test('429 no login não inventa temporizador nem abre o painel', async () => {
    const app = setupAdmin();
    const { el, state, requests } = app;
    await settle();
    state.overrideStatus = { path: '/api/admin/auth/login', code: 429 };
    await app.login();
    assert.equal(el['auth-login'].hidden, false);
    assert.equal(el['admin-panel'].hidden, true);
    assert.match(el['notificacao-mensagem'].textContent, /Requisição não autorizada/);
    assert.equal(el['login-senha'].value, '');
    assert.equal(requests.some(r => r.url.endsWith('/api/turmas')), false);
});

test('5xx em /session bloqueia dados; rechecagem posterior recupera', async () => {
    const app = setupAdmin({ overrideStatus:
        { path: '/api/admin/auth/session', code: 500 } });
    const { el, state, context } = app;
    await settle();
    assert.equal(el['auth-bloqueado'].hidden, false);
    assert.equal(el['admin-panel'].hidden, true);
    assert.equal(el['lista-publicacoes'].children.length, 0);
    state.logged = true;
    await vm.runInContext('verificarEstadoInicial()', context);
    assert.equal(el['admin-panel'].hidden, false);
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
    assert.match(indexHtml, /Associação Assistencial Lar Betânia/);
    assert.match(indexHtml, /83\.526\.640\/0001-67/);
    assert.match(indexHtml, /id="btn-copiar-pix"/);
    assert.doesNotMatch(indexHtml, /pix-key|QR Code Aqui|Festa Junina Solidária|12\.345\.678\/0001-90/);
});
