#!/usr/bin/env node
'use strict';
// REC-001: recuperação ADMINISTRATIVA OFFLINE após restore de SQLite.
// Exige manutenção/serviço parado, arquivo existente e bloqueio EXCLUSIVE.
// NÃO é rota HTTP, não usa bootstrap e NUNCA grava senha em argv, URL ou logs.
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { newHash, passwordPolicy, KDF_VERSION } = require('../admin-auth');
const REQUIRED_VERSION = 101;

function assertFile(file) {
    if (!file || !path.isAbsolute(file)) {
        throw new Error('Informe --db com caminho ABSOLUTO de banco existente.');
    }
    const data = fs.lstatSync(file);
    if (!data.isFile() || data.isSymbolicLink() || data.size < 100) {
        throw new Error('Arquivo SQLite ausente, vazio, inválido ou link simbólico.');
    }
    const project = fs.realpathSync(path.resolve(__dirname, '..'));
    const real = fs.realpathSync(file);
    const relative = path.relative(project, real);
    if (relative === '' ||
        (relative !== '..' && !relative.startsWith('..' + path.sep) &&
         !path.isAbsolute(relative))) {
        throw new Error('Banco deve estar fora do checkout do projeto.');
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const header = Buffer.alloc(16);
        if (fs.readSync(fd, header, 0, 16, 0) !== 16 ||
            !header.equals(Buffer.from('SQLite format 3\0'))) {
            throw new Error('Cabeçalho SQLite inválido.');
        }
    } finally {
        fs.closeSync(fd);
    }
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(path.dirname(file), fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}
function open(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, err =>
            err ? reject(err) : resolve(db));
    });
}
function get(db, sql, args = []) {
    return new Promise((resolve, reject) =>
        db.get(sql, args, (err, value) => err ? reject(err) : resolve(value)));
}
function all(db, sql, args = []) {
    return new Promise((resolve, reject) =>
        db.all(sql, args, (err, rows) => err ? reject(err) : resolve(rows)));
}
function run(db, sql, args = []) {
    return new Promise((resolve, reject) =>
        db.run(sql, args, function(err) {
            err ? reject(err) : resolve({ changes: this.changes });
        }));
}
function close(db) {
    return new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
}
async function assertSchema(db) {
    const version = await get(db, 'PRAGMA user_version');
    if (!version || version.user_version !== REQUIRED_VERSION) {
        throw new Error('Esquema administrativo incompatível; versão 101 obrigatória.');
    }
    const check = await get(db, 'PRAGMA integrity_check');
    if (!check || check.integrity_check !== 'ok') throw new Error('SQLite com falha de integridade.');
    if ((await all(db, 'PRAGMA foreign_key_check')).length) {
        throw new Error('SQLite com referências inválidas.');
    }
    const tables = {
        Turmas: ['id','nome_turma','codigo_acesso'],
        Publicacoes: ['id','titulo','descricao','data','tipo','imagem_url','turma_id'],
        AdminCredencial: ['id','senha_hash','salt','kdf','parametros_versao',
            'criado_em','atualizado_em','geracao_sessao'],
        AdminSessoes: ['sid_digest','admin_id','csrf_digest','criado_em',
            'ultimo_uso_em','expira_absoluto_em','geracao_sessao','revogado_em']
    };
    for (const [name, fields] of Object.entries(tables)) {
        const columns = await all(db, 'PRAGMA table_info("' + name + '")');
        if (!fields.every(field => columns.some(c => c.name === field))) {
            throw new Error('Esquema incompatível: ' + name);
        }
    }
    const credential = await get(db,
        'SELECT id,senha_hash,salt,kdf,parametros_versao,geracao_sessao ' +
        'FROM AdminCredencial WHERE id=1');
    const count = await get(db, 'SELECT COUNT(*) AS total FROM AdminCredencial');
    if (!credential || count.total !== 1 || credential.kdf !== 'scrypt' ||
        credential.parametros_versao !== KDF_VERSION ||
        !Buffer.isBuffer(credential.senha_hash) ||
        credential.senha_hash.length !== 64 ||
        !Buffer.isBuffer(credential.salt) || credential.salt.length < 16 ||
        !Number.isSafeInteger(credential.geracao_sessao) ||
        credential.geracao_sessao < 0 ||
        credential.geracao_sessao >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Credencial singleton ausente ou incompatível.');
    }
    const refs = await all(db, 'PRAGMA foreign_key_list("AdminSessoes")');
    if (!refs.some(f => f.table === 'AdminCredencial' && f.from === 'admin_id')) {
        throw new Error('Relacionamento da sessão incompatível.');
    }
    return credential.geracao_sessao;
}
async function withExclusive(file, callback) {
    assertFile(file);
    const db = await open(file);
    let transaction = false;
    try {
        // Falha IMEDIATA se outro escritor mantiver lock; não tentar recuperar DB ativo.
        await run(db, 'PRAGMA busy_timeout = 0');
        await run(db, 'PRAGMA foreign_keys = ON');
        await run(db, 'PRAGMA locking_mode = EXCLUSIVE');
        await run(db, 'BEGIN EXCLUSIVE');
        transaction = true;
        const result = await callback(db);
        // O chamador sempre encerra a transação aqui, nunca em outro processo.
        await run(db, 'COMMIT');
        transaction = false;
        return result;
    } catch (err) {
        if (transaction) await run(db, 'ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await close(db);
    }
}
async function inspect(file, { quiesced } = {}) {
    if (quiesced !== true) throw new Error('Exigida confirmação --quiesced de serviço parado.');
    return withExclusive(file, assertSchema);
}
async function recover(file, password, { quiesced, expectedGeneration, beforeCommit } = {}) {
    if (quiesced !== true) throw new Error('Exigida confirmação --quiesced de serviço parado.');
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
        throw new Error('Informe --expected-generation obtida do preflight offline.');
    }
    if (!passwordPolicy(password)) throw new Error('Senha fora da política 12–128 caracteres.');
    // KDF executado fora do lock; parâmetros idênticos ao login do servidor.
    assertFile(file);
    const { hash, salt } = await newHash(password);
    return withExclusive(file, async db => {
        const generation = await assertSchema(db);
        if (generation !== expectedGeneration) {
            throw new Error('Geração divergente: recuperação repetida ou concorrente recusada.');
        }
        const changed = await run(db,
            'UPDATE AdminCredencial SET senha_hash=?,salt=?,kdf=?,parametros_versao=?, ' +
            'atualizado_em=?,geracao_sessao=geracao_sessao+1 ' +
            'WHERE id=1 AND geracao_sessao=?',
            [hash, salt, 'scrypt', KDF_VERSION, Date.now(), generation]);
        if (changed.changes !== 1) throw new Error('Recuperação concorrente recusada.');
        await run(db,
            'UPDATE AdminSessoes SET revogado_em=? WHERE revogado_em IS NULL',
            [Date.now()]);
        if (beforeCommit) await beforeCommit(); // Injeção exclusiva do teste em memória.
        await assertSchema(db);
        return generation + 1;
    });
}
// Leitura da senha sem eco no terminal; --password-stdin para fixtures/pipe.
// A senha NUNCA é aceita via argumento ou variável de ambiente.
function inputPassword(fromPipe) {
    return new Promise((resolve, reject) => {
        const terminal = process.stdin.isTTY && !fromPipe;
        if (!terminal && !fromPipe) {
            return reject(new Error('Use terminal interativo ou --password-stdin.'));
        }
        let value = '';
        if (terminal) {
            process.stderr.write('Nova senha administrativa (oculta): ');
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding('utf8');
        process.stdin.resume();
        const cleanup = () => {
            process.stdin.removeListener('data', onData);
            process.stdin.removeListener('end', onEnd);
            if (terminal) {
                process.stdin.setRawMode(false);
                process.stderr.write('\n');
            }
            process.stdin.pause();
        };
        const finish = (err, result) => { cleanup(); err ? reject(err) : resolve(result); };
        const onEnd = () => finish(new Error('Entrada encerrada sem senha completa.'));
        const onData = chunk => {
            for (const ch of chunk) {
                if (ch === '\n' || ch === '\r') {
                    return finish(null, value);
                }
                if (ch === '\u0003') return finish(new Error('Operação cancelada.'));
                if (terminal && (ch === '\u007f' || ch === '\b')) {
                    value = value.slice(0, -1);
                    continue;
                }
                value += ch;
                if (Buffer.byteLength(value, 'utf8') > 512) {
                    return finish(new Error('Senha excede limite de tamanho.'));
                }
            }
        };
        process.stdin.on('data', onData);
        process.stdin.once('end', onEnd);
    });
}
function parseArgs(argv) {
    const config = { quiesced: false, inspect: false, passwordStdin: false };
    const seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (seen.has(a)) throw new Error('Argumento duplicado: ' + a);
        seen.add(a);
        if (a === '--db' || a === '--expected-generation') {
            if (++i >= argv.length) throw new Error('Parâmetro incompleto: ' + a);
            const value = argv[i];
            if (a === '--db') config.db = value;
            else config.expectedGeneration = Number(value);
        } else if (a === '--quiesced') config.quiesced = true;
        else if (a === '--inspect') config.inspect = true;
        else if (a === '--password-stdin') config.passwordStdin = true;
        else throw new Error('Argumento inválido: ' + a);
    }
    if (!config.db || !config.quiesced) {
        throw new Error('Uso: --db /caminho/absoluto/mural.db --quiesced ' +
            '[--inspect | --expected-generation N [--password-stdin]]');
    }
    if (config.inspect && (config.passwordStdin || config.expectedGeneration !== undefined)) {
        throw new Error('--inspect não aceita senha nem geração.');
    }
    if (!config.inspect && config.expectedGeneration === undefined) {
        throw new Error('Recuperação requer --expected-generation N.');
    }
    return config;
}
if (require.main === module) {
    (async () => {
        const args = parseArgs(process.argv.slice(2));
        if (args.inspect) {
            const generation = await inspect(args.db, args);
            process.stdout.write('Geração atual: ' + generation + '\n');
        } else {
            const password = await inputPassword(args.passwordStdin);
            const generation = await recover(args.db, password, args);
            process.stdout.write('Recuperação offline concluída. Nova geração: ' + generation + '\n');
        }
    })().catch(err => {
        // Nunca ecoar argumentos, senha, hash, SQL, nomes de tabelas privadas.
        const message = err.message && !err.message.includes('SQLITE_')
            ? err.message : 'Arquivo indisponível ou concorrência detectada.';
        console.error('REC-001: operação recusada: ' + message);
        process.exitCode = 1;
    });
}
module.exports = { inspect, recover };
