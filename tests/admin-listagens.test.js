'use strict';
// Teste isolado de lógica das rotas. Não substitui integração HTTP/SQLite real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const secret = 'credencial-ficticia-de-teste';

function setup() {
    const routes = new Map();
    const turmas = [
        { id: 1, nome_turma: 'A', codigo_acesso: 'aaa111' },
        { id: 2, nome_turma: 'B', codigo_acesso: 'bbb222' }
    ];
    const pubs = [
        { id: 2, titulo: 'Geral', descricao: 'Todos', data: '2026-11-11', tipo: 'Evento', imagem_url: null, turma_id: null },
        { id: 1, titulo: 'Turma A', descricao: 'A', data: '2026-11-11', tipo: 'Cardápio', imagem_url: null, turma_id: 1 }
    ];
    let chamadas = 0;
    const db = {
        all(sql, params, cb) {
            chamadas++;
            if (sql.includes('FROM Turmas ORDER BY')) return cb(null, turmas);
            if (sql.includes('FROM Publicacoes p') && !sql.includes('WHERE')) {
                assert.match(sql, /LEFT JOIN Turmas/);
                assert.doesNotMatch(sql, /codigo_acesso/);
                assert.deepEqual(Array.from(params), []);
                return cb(null, pubs.map(p => ({
                    ...p, nome_turma: turmas.find(t => t.id === p.turma_id)?.nome_turma ?? null
                })));
            }
            throw new Error('Consulta inesperada');
        },
        get(sql, params, cb) {
            chamadas++;
            cb(null, turmas.find(t => t.codigo_acesso === params[0]));
        },
        run(sql, params, cb) {
            chamadas++;
            if (!sql.startsWith('INSERT INTO Turmas')) throw new Error('Escrita inesperada');
            if (turmas.some(t => t.nome_turma === params[0])) return cb.call({}, new Error('UNIQUE'));
            const id = turmas.length + 1;
            turmas.push({ id, nome_turma: params[0], codigo_acesso: params[1] });
            cb.call({ lastID: id }, null);
        }
    };
    const app = {
        use() {},
        get(route, ...handlers) { routes.set('GET ' + route, handlers); },
        post(route, ...handlers) { routes.set('POST ' + route, handlers); },
        put(route, ...handlers) { routes.set('PUT ' + route, handlers); },
        delete(route, ...handlers) { routes.set('DELETE ' + route, handlers); },
        listen(_port, cb) { cb(); }
    };
    const express = () => app;
    express.json = () => () => {};
    express.urlencoded = () => () => {};
    express.static = () => () => {};
    const multer = () => ({ single: () => (_req, _res, next) => next() });
    multer.diskStorage = () => ({});
    multer.MulterError = class extends Error {};
    const deps = { express, multer, path, './database': db,
        os: { homedir: () => path.resolve(__dirname, '..', '..') },
        fs: { mkdirSync() {} }, cors: () => () => {},
        dotenv: { config() {} }, crypto: require('node:crypto') };
    vm.runInNewContext(source, {
        require: name => deps[name],
        __dirname: path.join(__dirname, '..'),
        process: { env: { ADMIN_SECRET_KEY: secret, PORT: 0 } },
        console: { log() {}, error() {} }
    });
    function call(method, route, authorization, body = {}, params = {}) {
        const handlers = routes.get(method + ' ' + route);
        assert.ok(handlers, route);
        const req = { headers: {}, body, params };
        if (authorization !== undefined) req.headers.authorization = authorization;
        const res = {
            statusCode: 200, data: null,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.data = data; return this; }
        };
        for (const handler of handlers) {
            let next = false;
            handler(req, res, () => { next = true; });
            if (!next) break;
        }
        return res;
    }
    return { call, routes, get chamadas() { return chamadas; } };
}

test('ambas as listagens exigem senha administrativa', () => {
    const a = setup();
    for (const route of ['/api/turmas', '/api/admin/publicacoes']) {
        for (const senha of [undefined, 'invalida']) {
            const res = a.call('GET', route, senha);
            assert.equal(res.statusCode, 401);
            assert.equal(typeof res.data.erro, 'string');
            assert.doesNotMatch(JSON.stringify(res.data), /codigo_acesso|aaa111|bbb222/);
        }
    }
    assert.equal(a.chamadas, 0);
});

test('turmas autorizadas preservam os códigos e IDs', () => {
    const res = setup().call('GET', '/api/turmas', secret);
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.length, 2);
    assert.deepEqual(Object.keys(res.data[0]), ['id', 'nome_turma', 'codigo_acesso']);
});

test('admin lista publicações gerais e específicas sem códigos de turma', () => {
    const res = setup().call('GET', '/api/admin/publicacoes', secret);
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.length, 2);
    assert.equal(res.data[0].turma_id, null);
    assert.equal(res.data[0].nome_turma, null);
    assert.equal(res.data[1].turma_id, 1);
    assert.equal(res.data[1].nome_turma, 'A');
    assert.deepEqual(Object.keys(res.data[0]), [
        'id', 'titulo', 'descricao', 'data', 'tipo', 'imagem_url', 'turma_id', 'nome_turma'
    ]);
    assert.doesNotMatch(JSON.stringify(res.data), /codigo_acesso|aaa111|bbb222/);
});

test('POST de turma mantém autenticação, geração e duplicidade', () => {
    const a = setup();
    assert.equal(a.call('POST', '/api/turmas', undefined, { nome_turma: 'C' }).statusCode, 401);
    const novo = a.call('POST', '/api/turmas', secret, { nome_turma: 'C' });
    assert.equal(novo.statusCode, 201);
    assert.equal(novo.data.codigo_acesso.length, 6);
    assert.equal(a.call('POST', '/api/turmas', secret, { nome_turma: 'C' }).statusCode, 400);
});

test('rotas CRUD permanecem protegidas e token inválido permanece 404', () => {
    const a = setup();
    for (const [method, route] of [
        ['POST', '/api/publicacoes'],
        ['PUT', '/api/publicacoes/:id'],
        ['DELETE', '/api/publicacoes/:id']
    ]) assert.equal(a.call(method, route).statusCode, 401);
    const invalid = a.call('GET', '/api/publicacoes/token/:codigo', undefined, {}, { codigo: 'invalido' });
    assert.equal(invalid.statusCode, 404);
});
