'use strict';
// Isolated infrastructure acceptance tests. No Express/production database/VM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const utility = path.join(__dirname, '..', 'scripts', 'ops', 'mural_data.py');
function run(args) {
  return spawnSync('python3', [utility, ...args], { encoding: 'utf8', timeout: 20000 });
}
function python(script, args = []) {
  return spawnSync('python3', ['-c', script, ...args], { encoding: 'utf8', timeout: 20000 });
}
function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-ops-ci-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'legacy.db');
  const images = path.join(root, 'original-images');
  fs.mkdirSync(images);
  fs.writeFileSync(path.join(images, 'img-001.png'), Buffer.from([137,80,78,71,13,10,26,10]));
  const mk = python(`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('CREATE TABLE Turmas(id INTEGER PRIMARY KEY, nome_turma TEXT, codigo_acesso TEXT)')\nc.execute('INSERT INTO Turmas VALUES(7,?,?)',('Turma Demo','ficticio-123'))\nc.commit()\nc.close()`, [db]);
  assert.equal(mk.status, 0, mk.stderr);
  return { root, db, images, snapshot: path.join(root, 'snapshot'), restoredDB: path.join(root, 'new-state', 'banco.db'), restoredImages: path.join(root, 'new-uploads') };
}
function createSnapshot(env) {
  const r = run(['backup', '--db', env.db, '--uploads', env.images, '--output', env.snapshot, '--quiesced']);
  assert.equal(r.status, 0, r.stderr);
}

test('infra: exige confirmação de pausa de escritas para backup', t => {
  const env = environment(t);
  const r = run(['backup','--db',env.db,'--uploads',env.images,'--output',env.snapshot]);
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(env.snapshot), false);
});

test('infra: snapshot/restore preservam SQLite com IDs e imagens', t => {
  const env = environment(t);
  createSnapshot(env);
  assert.equal(run(['verify','--snapshot',env.snapshot]).status, 0);
  fs.mkdirSync(path.dirname(env.restoredDB));
  const dry = run(['restore','--snapshot',env.snapshot,'--db',env.restoredDB,'--uploads',env.restoredImages]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(fs.existsSync(env.restoredDB), false);
  const restored = run(['restore','--snapshot',env.snapshot,'--db',env.restoredDB,'--uploads',env.restoredImages,'--quiesced','--apply']);
  assert.equal(restored.status, 0, restored.stderr);
  const probe = python(`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nprint(c.execute('SELECT id,codigo_acesso FROM Turmas').fetchone())`, [env.restoredDB]);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.includes("(7, 'ficticio-123')"), true);
  assert.deepEqual(fs.readFileSync(path.join(env.restoredImages, 'img-001.png')),
    fs.readFileSync(path.join(env.images,'img-001.png')));
  assert.equal(fs.statSync(env.snapshot).mode & 0o077, 0);
  assert.equal(fs.statSync(env.restoredDB).mode & 0o077, 0);
});

test('infra: restauração nunca sobrescreve arquivos existentes', t => {
  const env = environment(t); createSnapshot(env);
  fs.mkdirSync(path.dirname(env.restoredDB));
  fs.writeFileSync(env.restoredDB, 'arquivo-existente');
  const r = run(['restore','--snapshot',env.snapshot,'--db',env.restoredDB,'--uploads',env.restoredImages,'--quiesced','--apply']);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(env.restoredDB,'utf8'), 'arquivo-existente');
  assert.equal(fs.existsSync(env.restoredImages), false);
});

test('infra: symlink ou corrupção de arquivo bloqueiam backup/verify', t => {
  const env = environment(t);
  const external = path.join(env.root,'other.png');
  fs.writeFileSync(external,'fake');
  fs.symlinkSync(external,path.join(env.images,'img-symlink.png'));
  assert.equal(run(['backup','--db',env.db,'--uploads',env.images,'--output',env.snapshot,'--quiesced']).status, 2);
  fs.unlinkSync(path.join(env.images,'img-symlink.png'));
  createSnapshot(env);
  fs.appendFileSync(path.join(env.snapshot,'uploads','img-001.png'),'alterado');
  assert.equal(run(['verify','--snapshot',env.snapshot]).status, 2);
});

test('infra: migração legada é dry-run por padrão, sem sobrescrever conflitos', t => {
  const env = environment(t);
  const destination = path.join(env.root,'external');
  fs.mkdirSync(destination);
  assert.equal(run(['migrate-images','--source',env.images,'--target',destination]).status, 0);
  assert.equal(fs.readdirSync(destination).length, 0);
  assert.equal(run(['migrate-images','--source',env.images,'--target',destination,'--apply']).status, 0);
  assert.equal(run(['migrate-images','--source',env.images,'--target',destination,'--apply']).status, 0);
  assert.deepEqual(fs.readFileSync(path.join(destination,'img-001.png')),fs.readFileSync(path.join(env.images,'img-001.png')));
  fs.writeFileSync(path.join(destination,'img-001.png'),'conflict');
  assert.equal(run(['migrate-images','--source',env.images,'--target',destination,'--apply']).status, 2);
  assert.equal(fs.readFileSync(path.join(destination,'img-001.png'),'utf8'), 'conflict');
});

test('infra: preflight rejeita banco dentro checkout e paths por symlink', t => {
  const env = environment(t);
  const preflight = path.join(__dirname, '..', 'scripts', 'ops', 'preflight.py');
  const state = path.join(env.root, 'state');
  const uploads = path.join(env.root, 'ext-uploads');
  const checkout = path.join(env.root, 'checkout');
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(uploads, { mode: 0o700 });
  fs.mkdirSync(checkout);
  fs.chmodSync(uploads, 0o700);
  fs.copyFileSync(env.db, path.join(state, 'banco.db'));
  fs.chmodSync(path.join(state, 'banco.db'), 0o600);
  const valid = spawnSync('python3',[preflight,'--checkout',checkout,'--db',path.join(state, 'banco.db'),'--uploads',uploads], { encoding:'utf8' });
  assert.equal(valid.status,0,valid.stderr);
  fs.copyFileSync(env.db,path.join(checkout,'banco.db'));
  fs.chmodSync(path.join(checkout,'banco.db'),0o600);
  assert.equal(spawnSync('python3',[preflight,'--checkout',checkout,'--db',path.join(checkout,'banco.db'),'--uploads',uploads]).status,2);
  const fake = path.join(env.root, 'upload-link');
  fs.symlinkSync(uploads,fake);
  assert.equal(spawnSync('python3',[preflight,'--checkout',checkout,'--db',path.join(state,'banco.db'),'--uploads',fake]).status,2);
});
