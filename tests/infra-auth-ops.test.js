'use strict';
// Operação de segurança da autenticação: apenas fixtures SQLite descartáveis.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tool = path.resolve(__dirname, '..', 'scripts', 'ops', 'mural_data.py');
const python = (code, args = []) =>
  spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8', timeout: 20000 });
const run = args => spawnSync('python3', [tool, ...args],
  { encoding: 'utf8', timeout: 20000 });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-auth-ops-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sqlite-original.db');
  const uploads = path.join(root, 'uploads-original');
  const snapshot = path.join(root, 'snapshot');
  const newDb = path.join(root, 'state-restaurado', 'banco.db');
  const newUploads = path.join(root, 'uploads-restaurados');
  fs.mkdirSync(uploads, { mode: 0o700 });
  fs.writeFileSync(path.join(uploads, 'imagem-ficticia.png'),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { mode: 0o600 });
  // Somente registros e digests sintéticos. Nunca usar dados ou segredos reais.
  const ddl = `
import sqlite3,sys
con=sqlite3.connect(sys.argv[1])
con.execute("PRAGMA foreign_keys=ON")
con.execute("CREATE TABLE Turmas(id INTEGER PRIMARY KEY, nome_turma TEXT, codigo_acesso TEXT UNIQUE)")
con.execute("CREATE TABLE Publicacoes(id INTEGER PRIMARY KEY, titulo TEXT, descricao TEXT, data TEXT, tipo TEXT, imagem_url TEXT, turma_id INTEGER REFERENCES Turmas(id))")
con.execute("INSERT INTO Turmas VALUES(7,'Turma fictícia','token-sintetico-001')")
con.execute("INSERT INTO Publicacoes VALUES(13,'Aviso sintético','Somente teste','2026-01-01','Aviso','/uploads/imagem-ficticia.png',7)")
con.execute("CREATE TABLE AdminCredencial(id INTEGER PRIMARY KEY, senha_hash BLOB, salt BLOB, geracao_sessao INTEGER)")
con.execute("CREATE TABLE AdminSessoes(sid_digest BLOB PRIMARY KEY, admin_id INTEGER, revogado_em INTEGER)")
con.execute("INSERT INTO AdminCredencial VALUES(1,zeroblob(64),zeroblob(16),2)")
con.execute("INSERT INTO AdminSessoes VALUES(zeroblob(32),1,NULL)")
con.commit(); con.close()
`;
  const result = python(ddl, [db]);
  assert.equal(result.status, 0, result.stderr);
  return { root, db, uploads, snapshot, newDb, newUploads };
}
function backup(a) {
  const result = run(['backup', '--db', a.db, '--uploads', a.uploads,
    '--output', a.snapshot, '--quiesced']);
  assert.equal(result.status, 0, result.stderr);
}
function summary(db) {
  const result = python(`
import sqlite3,sys,json
con=sqlite3.connect(sys.argv[1])
print(json.dumps({
'turmas':con.execute('SELECT id,nome_turma,codigo_acesso FROM Turmas').fetchall(),
'publicacoes':con.execute('SELECT id,titulo,imagem_url,turma_id FROM Publicacoes').fetchall(),
'credenciais':con.execute('SELECT id,length(senha_hash),length(salt),geracao_sessao FROM AdminCredencial').fetchall(),
'sessoes':con.execute('SELECT length(sid_digest),admin_id,revogado_em FROM AdminSessoes').fetchall()
},ensure_ascii=False))
con.close()
`, [db]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('auth-ops: snapshot e restore preservam domínio, credencial e sessões fictícias', t => {
  const a = fixture(t);
  backup(a);
  assert.equal(run(['verify', '--snapshot', a.snapshot]).status, 0);
  const initial = summary(a.db);
  fs.mkdirSync(path.dirname(a.newDb), { mode: 0o700 });
  const dry = run(['restore', '--snapshot', a.snapshot, '--db', a.newDb,
    '--uploads', a.newUploads]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(fs.existsSync(a.newDb), false);
  const apply = run(['restore', '--snapshot', a.snapshot, '--db', a.newDb,
    '--uploads', a.newUploads, '--quiesced', '--apply']);
  assert.equal(apply.status, 0, apply.stderr);
  assert.deepEqual(summary(a.newDb), initial);
  assert.deepEqual(fs.readFileSync(path.join(a.newUploads, 'imagem-ficticia.png')),
    fs.readFileSync(path.join(a.uploads, 'imagem-ficticia.png')));
  assert.equal(fs.statSync(a.newDb).mode & 0o077, 0);
  // Uma restauração antiga reintroduz sessões! O runbook proíbe colocá-la on-line
  // antes da revogação/rotação offline pelo Backend.
  assert.equal(summary(a.newDb).sessoes.length, 1);
});

test('auth-ops: corrupção do snapshot bloqueia restore e preserva destinos', t => {
  const a = fixture(t);
  backup(a);
  fs.appendFileSync(path.join(a.snapshot, 'sqlite.db'), 'adulterado');
  assert.equal(run(['verify', '--snapshot', a.snapshot]).status, 2);
  fs.mkdirSync(path.dirname(a.newDb));
  const r = run(['restore', '--snapshot', a.snapshot, '--db', a.newDb,
    '--uploads', a.newUploads, '--quiesced', '--apply']);
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(a.newDb), false);
  assert.equal(fs.existsSync(a.newUploads), false);
});

test('auth-ops: restauração não sobrescreve banco preexistente', t => {
  const a = fixture(t);
  backup(a);
  fs.mkdirSync(path.dirname(a.newDb));
  fs.writeFileSync(a.newDb, 'CONTEUDO_EXTERNO_NAO_MODIFICAR');
  assert.equal(run(['restore', '--snapshot', a.snapshot, '--db', a.newDb,
    '--uploads', a.newUploads, '--quiesced', '--apply']).status, 2);
  assert.equal(fs.readFileSync(a.newDb, 'utf8'), 'CONTEUDO_EXTERNO_NAO_MODIFICAR');
  assert.equal(fs.existsSync(a.newUploads), false);
});
