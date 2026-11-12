'use strict';

// MELHORIA-ADM-AUTH-001. Contrato normativo privado: migração offline obrigatória.
// CSRF canônico: HMAC-SHA256(key=SID aleatório de 32 bytes, message='mural-csrf-v1')
// codificado em HEX MINÚSCULO (64 caracteres), somente após autenticar a sessão.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const SID_COOKIE = 'mural_admin_sid';
const IDLE_MS = 30 * 60 * 1000;
const ABS_MS = 8 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const KDF = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const KDF_VERSION = 1;

function dbApi(db) {
    return {
        get(sql, params = []) {
            return new Promise((resolve, reject) =>
                db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
        },
        all(sql, params = []) {
            return new Promise((resolve, reject) =>
                db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
        },
        run(sql, params = []) {
            return new Promise((resolve, reject) =>
                db.run(sql, params, function (err) {
                    err ? reject(err) : resolve({ changes: this.changes, lastID: this.lastID });
                }));
        }
    };
}
const sha256 = data => crypto.createHash('sha256').update(data).digest();
const safeEqual = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b)
    && a.length === b.length && crypto.timingSafeEqual(a, b);
const csrfFor = sid => crypto.createHmac('sha256', sid).update('mural-csrf-v1').digest('hex');
function passwordPolicy(value) {
    return typeof value === 'string' && value.length >= 12 &&
        value.length <= 128 && Buffer.byteLength(value, 'utf8') <= 512;
}
async function newHash(pass) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(pass, salt, 64, KDF);
    return { salt, hash };
}
async function checkPassword(pass, row) {
    if (!row || row.kdf !== 'scrypt' || row.parametros_versao !== KDF_VERSION
        || !Buffer.isBuffer(row.salt) || !Buffer.isBuffer(row.senha_hash)) return false;
    const h = await scrypt(pass, row.salt, row.senha_hash.length, KDF);
    return safeEqual(h, row.senha_hash);
}
function parseCookie(header) {
    if (typeof header !== 'string') return null;
    const values = header.split(';').map(t => t.trim()).filter(t => t.startsWith(SID_COOKIE + '='));
    if (values.length !== 1) return null;
    const raw = values[0].slice(SID_COOKIE.length + 1);
    if (!/^[0-9a-f]{64}$/.test(raw)) return null;
    return Buffer.from(raw, 'hex');
}
function reject(res, status, message) {
    return res.status(status).json({ erro: message });
}
function failure(res) {
    return reject(res, 500, 'Serviço temporariamente indisponível.');
}
function createLimiter(now) {
    const salt = crypto.randomBytes(32);
    const buckets = new Map();
    const originKey = req => {
        // req.ip é calculado pelo Express com proxy confiável SOMENTE quando
        // o peer real é loopback. Não usar X-Forwarded-For cru.
        const origin = String(req.ip || req.socket?.remoteAddress || 'unknown');
        return crypto.createHmac('sha256', salt).update(origin).digest('hex');
    };
    function check(scope, req, perOriginMax, globalMax) {
        const time = now(), localKey = scope + ':i:' + originKey(req);
        const globalKey = scope + ':global';
        if (buckets.size > 1500) {
            for (const [key, item] of buckets) if (item.until <= time) buckets.delete(key);
            if (buckets.size > 1500) buckets.delete(buckets.keys().next().value);
        }
        function state(key) {
            const value = buckets.get(key);
            if (!value || value.until <= time) {
                const newValue = { count: 0, until: time + WINDOW_MS };
                buckets.set(key, newValue);
                return newValue;
            }
            return value;
        }
        const local = state(localKey), global = state(globalKey);
        if (local.count >= perOriginMax)
            return { blocked: true, wait: Math.max(1, Math.ceil((local.until - time) / 1000)) };
        // Limitação global temporária, evitando lockout global de 15 minutos.
        if (global.blockedUntil && time < global.blockedUntil)
            return { blocked: true, wait: Math.max(1, Math.ceil((global.blockedUntil - time) / 1000)) };
        if (global.count >= globalMax) {
            // Pausa GLOBAL curta; não reter bloqueio de todos os usuários por 15 min.
            global.blockedUntil = time + 30000;
            global.count = 0;
            return { blocked: true, wait: 30 };
        }
        return { blocked: false, fail() { local.count++; global.count++; }, success() {
            buckets.delete(localKey);
        } };
    }
    return { check };
}
function createAuth(db, options = {}) {
    const io = dbApi(db);
    const now = options.now || Date.now;
    const limiter = createLimiter(now);
    const publicOrigin = process.env.ADMIN_PUBLIC_ORIGIN || 'http://localhost:' + (process.env.PORT || 3000);
    let expectedOrigin;
    try {
        const url = new URL(publicOrigin);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== publicOrigin
            || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:'))
            throw new Error('origin invalid');
        expectedOrigin = url.origin;
    } catch {
        throw new Error('ADMIN_PUBLIC_ORIGIN deve ser uma origem HTTP(S) canônica; HTTPS é obrigatório em produção.');
    }
    const isSecure = expectedOrigin.startsWith('https://');
    const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: isSecure, path: '/' };
    // 15 min é o máximo desde o início do processo; o operador também deve
    // definir ADMIN_BOOTSTRAP_UNTIL em epoch milliseconds (não basta ENABLED).
    const startedAt = now();
    const bootstrapUntil = Number(process.env.ADMIN_BOOTSTRAP_UNTIL || 0);
    const bootstrapReady = process.env.ADMIN_BOOTSTRAP_ENABLED === 'true'
        && typeof process.env.ADMIN_BOOTSTRAP_TOKEN === 'string'
        && process.env.ADMIN_BOOTSTRAP_TOKEN.length >= 43
        && Number.isSafeInteger(bootstrapUntil)
        && bootstrapUntil > startedAt && bootstrapUntil <= startedAt + WINDOW_MS;

    async function assertSchema() {
        // Ausência de tabela/versão é FALHA FECHADA; não executar DDL no startup.
        const version = await io.get('PRAGMA user_version');
        if (!version || version.user_version !== 101)
            throw new Error('Versão da migração auth ausente/incompatível. Execute o migrador OFFLINE.');
        const rows = await io.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('AdminCredencial','AdminSessoes')");
        if (rows.length !== 2) throw new Error('Esquema auth ausente. Execute o migrador OFFLINE antes de iniciar.');
        for (const [table, expected] of Object.entries({
            AdminCredencial: ['id', 'senha_hash', 'salt', 'kdf', 'parametros_versao', 'geracao_sessao'],
            AdminSessoes: ['sid_digest', 'csrf_digest', 'criado_em', 'ultimo_uso_em', 'expira_absoluto_em', 'revogado_em']
        })) {
            const info = await io.all('PRAGMA table_info("' + table + '")');
            if (!expected.every(key => info.some(r => r.name === key)))
                throw new Error('Esquema auth incompatível: ' + table);
        }
    }
    function originOk(req, res, next) {
        if (req.get('origin') !== expectedOrigin) {
            reject(res, 403, 'Requisição não autorizada. Atualize o painel.');
            return;
        }
        if (process.env.NODE_ENV === 'production' && !req.secure) {
            reject(res, 403, 'Requisição não autorizada. Atualize o painel.');
            return;
        }
        next();
    }
    async function sessionFor(req) {
        const sid = parseCookie(req.headers.cookie);
        if (!sid) return null;
        const dig = sha256(sid);
        const row = await io.get(
            'SELECT s.sid_digest, s.csrf_digest, s.criado_em, s.ultimo_uso_em, s.expira_absoluto_em, ' +
            's.revogado_em, s.geracao_sessao, c.geracao_sessao AS atual ' +
            'FROM AdminSessoes s INNER JOIN AdminCredencial c ON s.admin_id=c.id WHERE s.sid_digest=?',
            [dig]);
        const time = now();
        if (!row || row.revogado_em !== null || row.geracao_sessao !== row.atual
            || time - row.ultimo_uso_em >= IDLE_MS || time >= row.expira_absoluto_em) return null;
        const csrfHex = csrfFor(sid);
        if (!safeEqual(row.csrf_digest, sha256(Buffer.from(csrfHex, 'ascii')))) return null;
        // Compare-and-update impede reativação por um login com sessão revogada.
        const updated = await io.run('UPDATE AdminSessoes SET ultimo_uso_em=? ' +
            'WHERE sid_digest=? AND revogado_em IS NULL AND geracao_sessao=? ' +
            'AND EXISTS (SELECT 1 FROM AdminCredencial WHERE id=1 AND geracao_sessao=?)',
            [time, dig, row.atual, row.atual]);
        if (updated.changes !== 1) return null;
        return { sidDigest: dig, csrfHex, generation: row.atual };
    }
    function authenticated(req, res, next) {
        sessionFor(req).then(session => {
            if (!session) return reject(res, 401, 'Sessão inexistente ou expirada.');
            req.adminSession = session;
            next();
        }).catch(() => failure(res));
    }
    function csrf(req, res, next) {
        const supplied = req.get('X-CSRF-Token');
        const accepted = typeof supplied === 'string' && /^[0-9a-f]{64}$/.test(supplied)
            && safeEqual(Buffer.from(supplied, 'ascii'), Buffer.from(req.adminSession.csrfHex, 'ascii'));
        if (!accepted) return reject(res, 403, 'Requisição não autorizada. Atualize o painel.');
        next();
    }
    function mutate(req, res, next) {
        originOk(req, res, () => authenticated(req, res, () => csrf(req, res, next)));
    }
    const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(() => failure(res));
    function limitResponse(res, wait) {
        if (Number.isInteger(wait) && wait > 0) res.set('Retry-After', String(wait));
        return reject(res, 429, 'Muitas tentativas. Tente novamente mais tarde.');
    }
    function noStore(req, res, next) {
        res.set('Cache-Control', 'no-store');
        next();
    }

    function register(app) {
        app.get('/api/admin/auth/status', wrap(async (req, res) => {
            const row = await io.get('SELECT id FROM AdminCredencial WHERE id=1');
            res.json({ configurado: !!row });
        }));
        app.post('/api/admin/auth/bootstrap', originOk, wrap(async (req, res) => {
            const old = await io.get('SELECT id FROM AdminCredencial WHERE id=1');
            if (old) return reject(res, 409, 'A configuração inicial já foi realizada.');
            const body = req.body || {};
            if (!passwordPolicy(body.nova_senha) || typeof body.token_inicial !== 'string')
                return reject(res, 400, 'Dados inválidos.');
            const bucket = limiter.check('bootstrap', req, 3, 10);
            if (bucket.blocked) return limitResponse(res, bucket.wait);
            const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
            const allowed = bootstrapReady && now() <= bootstrapUntil
                && typeof expected === 'string'
                && safeEqual(sha256(Buffer.from(expected)), sha256(Buffer.from(body.token_inicial)));
            if (!allowed) {
                bucket.fail();
                return reject(res, 403, 'Configuração inicial não autorizada.');
            }
            const { hash, salt } = await newHash(body.nova_senha);
            try {
                await io.run(
                    "INSERT INTO AdminCredencial (id, senha_hash, salt, kdf, parametros_versao, criado_em, atualizado_em, geracao_sessao) " +
                    "VALUES (1,?,?, 'scrypt', ?, ?, ?, 0)",
                    [hash, salt, KDF_VERSION, now(), now()]);
            } catch (e) {
                if (e.code === 'SQLITE_CONSTRAINT') return reject(res, 409, 'A configuração inicial já foi realizada.');
                throw e;
            }
            bucket.success();
            // Após cadastro a janela deixa de funcionar neste processo; o
            // singleton no banco impede repetição mesmo após reinício.
            delete process.env.ADMIN_BOOTSTRAP_TOKEN;
            process.env.ADMIN_BOOTSTRAP_ENABLED = 'false';
            res.status(201).json({ configurado: true });
        }));
        app.post('/api/admin/auth/login', originOk, wrap(async (req, res) => {
            const password = req.body?.senha;
            if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 512)
                return reject(res, 400, 'Dados inválidos.');
            const bucket = limiter.check('login', req, 5, 100);
            if (bucket.blocked) return limitResponse(res, bucket.wait);
            const row = await io.get('SELECT * FROM AdminCredencial WHERE id=1');
            if (!row || !(await checkPassword(password, row))) {
                bucket.fail();
                return reject(res, 401, 'Credenciais inválidas.');
            }
            bucket.success();
            const old = parseCookie(req.headers.cookie);
            if (old) await io.run('UPDATE AdminSessoes SET revogado_em=? WHERE sid_digest=? AND revogado_em IS NULL',
                [now(), sha256(old)]);
            const sid = crypto.randomBytes(32);
            const csrfHex = csrfFor(sid);
            const time = now();
            await io.run('INSERT INTO AdminSessoes (sid_digest, admin_id, csrf_digest, criado_em, ultimo_uso_em, ' +
                'expira_absoluto_em, geracao_sessao, revogado_em) VALUES (?,1,?,?,?,?,?,NULL)', [
                    sha256(sid), sha256(Buffer.from(csrfHex, 'ascii')), time, time,
                    time + ABS_MS, row.geracao_sessao
                ]);
            res.cookie(SID_COOKIE, sid.toString('hex'), { ...cookieOptions, maxAge: ABS_MS });
            res.json({ autenticado: true });
        }));
        app.get('/api/admin/auth/session', authenticated, (req, res) => {
            res.json({ autenticado: true, csrf_token: req.adminSession.csrfHex });
        });
        app.post('/api/admin/auth/logout', mutate, wrap(async (req, res) => {
            await io.run('UPDATE AdminSessoes SET revogado_em=? WHERE sid_digest=? AND revogado_em IS NULL',
                [now(), req.adminSession.sidDigest]);
            res.clearCookie(SID_COOKIE, cookieOptions);
            res.status(204).end();
        }));
        app.post('/api/admin/auth/change-password', mutate, wrap(async (req, res) => {
            const { senha_atual: old, nova_senha: updated } = req.body || {};
            if (typeof old !== 'string' || !passwordPolicy(updated))
                return reject(res, 400, 'Dados inválidos.');
            const row = await io.get('SELECT * FROM AdminCredencial WHERE id=1');
            if (!row || !(await checkPassword(old, row)))
                return reject(res, 403, 'Senha atual incorreta.');
            const { hash, salt } = await newHash(updated);
            await io.run('BEGIN IMMEDIATE');
            try {
                const change = await io.run('UPDATE AdminCredencial SET senha_hash=?, salt=?, parametros_versao=?, ' +
                    'atualizado_em=?, geracao_sessao=geracao_sessao+1 WHERE id=1 AND geracao_sessao=?',
                    [hash, salt, KDF_VERSION, now(), row.geracao_sessao]);
                if (change.changes !== 1) {
                    await io.run('ROLLBACK');
                    return reject(res, 403, 'Requisição não autorizada. Atualize o painel.');
                }
                await io.run('UPDATE AdminSessoes SET revogado_em=? WHERE revogado_em IS NULL', [now()]);
                await io.run('COMMIT');
            } catch (e) {
                await io.run('ROLLBACK').catch(() => {});
                throw e;
            }
            res.clearCookie(SID_COOKIE, cookieOptions);
            res.status(204).end();
        }));
    }
    return { register, assertSchema, authenticated, mutate, noStore, originOk };
}
module.exports = { createAuth };
