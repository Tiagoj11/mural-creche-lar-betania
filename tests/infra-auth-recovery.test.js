'use strict';
// REC-001 / DevOps: backup -> restauração em destinos NOVOS ->
// recuperação OFFLINE -> HTTP 401 dos cookies anteriores.
// Exclusivamente SQLite, imagens e senhas fictícias em os.tmpdir().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const root = path.resolve(__dirname, '..');
const ops = path.join(root, 'scripts', 'ops', 'mural_data.py');
const recoverCLI = path.join(root, 'scripts', 'recover-admin-auth.js');
const migrateCLI = path.join(root, 'scripts', 'migrate-admin-auth.js');
const before = 'senha-sintetica-rec001-inicial';
const after = 'senha-sintetica-rec001-recuperada';

const run = (program, args, opts = {}) => spawnSync(program, args, {
  cwd: root, encoding: 'utf8', timeout: 20000, ...opts
});
function ok(out, message) {
  assert.equal(out.status, 0, message + ': ' + (out.stderr || out.stdout || 'exit desconhecido'));
}
const py = (args, opts) => run('python3', [ops, ...args], opts);
const cli = (args, opts) => run(process.execPath, [recoverCLI, ...args], opts);
function open(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, err => err ? reject(err) : resolve(db));
  });
}
function dbRun(db, sql, args = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, args, err => err ? reject(err) : resolve()));
}
function dbAll(db, sql) {
  return new Promise((resolve, reject) =>
    db.all(sql, (err, rows) => err ? reject(err) : resolve(rows)));
}
function dbClose(db) {
  return new Promise((resolve, reject) =>
    db.close(err => err ? reject(err) : resolve()));
}
async function domain(dbPath) {
  const db = await open(dbPath);
  try {
    return {
      turmas: await dbAll(db, 'SELECT id,nome_turma,codigo_acesso FROM Turmas ORDER BY id'),
      pub: await dbAll(db, 'SELECT id,titulo,imagem_url,turma_id FROM Publicacoes ORDER BY id')
    };
  } finally { await dbClose(db); }
}
async function authRows(dbPath) {
  const db = await open(dbPath);
  try {
    return {
      credential: await dbAll(db, 'SELECT id,geracao_sessao,hex(senha_hash) AS hash,hex(salt) AS salt FROM AdminCredencial'),
      sessions: await dbAll(db, 'SELECT hex(sid_digest) AS sid,revogado_em,geracao_sessao FROM AdminSessoes ORDER BY sid')
    };
  } finally { await dbClose(db); }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-rec001-devops-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'state'), dbFile = path.join(base, 'original.sqlite');
  const uploads = path.join(dir, 'uploads');
  const snapshot = path.join(dir, 'snapshot');
  const restored = path.join(dir, 'restored');
  const dbRestored = path.join(restored, 'banco.db');
  const uploadsRestored = path.join(dir, 'uploads-restored');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploads, { mode: 0o700 });
  fs.mkdirSync(restored, { mode: 0o700 });
  const fakePng = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,69,78,68]);
  fs.writeFileSync(path.join(uploads, 'imagem-ficticia.png'), fakePng, { mode: 0o600 });
  const db = await open(dbFile);
  try {
    await dbRun(db, 'PRAGMA foreign_keys=ON');
    await dbRun(db, 'CREATE TABLE Turmas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome_turma TEXT NOT NULL UNIQUE, codigo_acesso TEXT UNIQUE)');
    await dbRun(db, 'CREATE TABLE Publicacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL, descricao TEXT, data TEXT NOT NULL, tipo TEXT NOT NULL, imagem_url TEXT, turma_id INTEGER, FOREIGN KEY(turma_id) REFERENCES Turmas(id) ON DELETE CASCADE)');
    await dbRun(db, "INSERT INTO Turmas(id,nome_turma,codigo_acesso) VALUES(7,'Turma sintética','token-ficticio-rec001')");
    await dbRun(db, "INSERT INTO Publicacoes(id,titulo,descricao,data,tipo,imagem_url,turma_id) VALUES(31,'Aviso sintético','Conteúdo fictício','2026-01-01','Evento','/uploads/imagem-ficticia.png',7)");
  } finally { await dbClose(db); }
  ok(run(process.execPath, [migrateCLI, '--db', dbFile]), 'Migrador offline inicial');
  return {dir,dbFile,uploads,snapshot,dbRestored,uploadsRestored,fakePng};
}
async function port() {
  const server = net.createServer();
  await new Promise((resolve,reject) => {
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const p=server.address().port;
  await new Promise(resolve => server.close(resolve));
  return p;
}
async function start(f, dbFile, uploads) {
  const p=await port(), base='http://127.0.0.1:'+p;
  const token='bootstrap-sintetico-'+crypto.randomBytes(32).toString('hex');
  const proc=spawn(process.execPath,[path.join(root,'server.js')], {
    cwd: root,
    env: {...process.env, NODE_ENV:'test', PORT:String(p),
      MURAL_DB_PATH:dbFile, MURAL_UPLOAD_DIR:uploads, ADMIN_PUBLIC_ORIGIN:base,
      ADMIN_BOOTSTRAP_ENABLED:'true',
      ADMIN_BOOTSTRAP_UNTIL:String(Date.now()+10*60*1000),
      ADMIN_BOOTSTRAP_TOKEN:token},
    stdio:'ignore'
  });
  for(let i=0;i<90;i++){
    if(proc.exitCode!==null || proc.signalCode!==null)
      throw new Error('Express sintético encerrou antes do teste');
    try{
      const res=await fetch(base+'/api/admin/auth/status',
        {signal:AbortSignal.timeout(900)});
      if(res.status===200)return{proc,base,token};
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,70));
  }
  proc.kill('SIGKILL');
  throw new Error('Express sintético não inicializou');
}
async function stop(instance) {
  if(!instance || instance.proc.exitCode!==null || instance.proc.signalCode!==null)return;
  const child=instance.proc;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill('SIGTERM');
  const result=await Promise.race([exited,new Promise(resolve=>setTimeout(()=>resolve('timeout'),3000))]);
  if(result==='timeout'){child.kill('SIGKILL');await exited;}
  assert.ok(child.exitCode!==null || child.signalCode!==null,'PID de teste realmente encerrado');
}
async function call(app,url,{method='GET',cookie,body}={}){
  const headers={};
  if(cookie)headers.Cookie=cookie;
  if(method!=='GET')headers.Origin=app.base;
  if(body)headers['Content-Type']='application/json';
  const r=await fetch(app.base+url,{method,headers,
    ...(body?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(7000)});
  return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';',1)[0],
    body:await r.text()};
}
async function login(app,password){
  const r=await call(app,'/api/admin/auth/login',
    {method:'POST',body:{senha:password}});
  assert.equal(r.status,200,'Login de fixture deve funcionar');
  assert.match(r.cookie||'',/^mural_admin_sid=[0-9a-f]{64}$/);
  return r.cookie;
}
function digest(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}

test('REC-001 DevOps: serviço parado, backup + restore reais, recuperação offline, 401 e preservação', async t=>{
  const f=await fixture(t);
  const originalDomain=await domain(f.dbFile);
  const originalImage=digest(fs.readFileSync(path.join(f.uploads,'imagem-ficticia.png')));
  let app=await start(f,f.dbFile,f.uploads);
  let cookies;
  try{
    assert.equal((await call(app,'/api/admin/auth/bootstrap',{
      method:'POST',body:{token_inicial:app.token,nova_senha:before}
    })).status,201);
    cookies=[await login(app,before),await login(app,before)];
    for(const cookie of cookies)
      assert.equal((await call(app,'/api/admin/auth/session',{cookie})).status,200);
  }finally{await stop(app);}
  // Checagem REAL de parada do processo de teste, além do flag declarativo.
  assert.ok(app.proc.exitCode!==null||app.proc.signalCode!==null);
  assert.notEqual(py(['backup','--db',f.dbFile,'--uploads',f.uploads,
    '--output',f.snapshot]).status,0,'Sem --quiesced deve falhar fechado');
  ok(py(['backup','--db',f.dbFile,'--uploads',f.uploads,'--output',f.snapshot,'--quiesced']),'Backup');
  ok(py(['verify','--snapshot',f.snapshot]),'Manifest e integridade SQLite');
  ok(py(['restore','--snapshot',f.snapshot,'--db',f.dbRestored,
    '--uploads',f.uploadsRestored]),'Restore dry-run');
  assert.equal(fs.existsSync(f.dbRestored),false,'dry-run não escreve SQLite');
  ok(py(['restore','--snapshot',f.snapshot,'--db',f.dbRestored,
    '--uploads',f.uploadsRestored,'--quiesced','--apply']),'Restore');
  assert.deepEqual(await domain(f.dbRestored),originalDomain);
  assert.equal(digest(fs.readFileSync(path.join(f.uploadsRestored,'imagem-ficticia.png'))),
    originalImage);
  const beforeState=await authRows(f.dbRestored);
  assert.equal(beforeState.sessions.length,2,'restauração contém duas sessões antigas');
  assert.equal(beforeState.sessions.filter(x=>x.revogado_em===null).length,2);
  const inspect=cli(['--db',f.dbRestored,'--quiesced','--inspect']);
  ok(inspect,'Inspeção offline');
  const gen=Number(/Geração atual: (\d+)/.exec(inspect.stdout)?.[1]);
  assert.ok(Number.isSafeInteger(gen));
  // Erro real de lock: o CLI não pode operar com outro escritor.
  const writer=await open(f.dbRestored);
  try {
    await dbRun(writer,'BEGIN IMMEDIATE');
    const denied=cli(['--db',f.dbRestored,'--quiesced','--expected-generation',
      String(gen),'--password-stdin'],{input:after+'\n'});
    assert.notEqual(denied.status,0,'Escritor concorrente deve impedir recuperação');
  }finally{
    await dbRun(writer,'ROLLBACK');
    await dbClose(writer);
  }
  assert.deepEqual(await authRows(f.dbRestored),beforeState,
    'Lock não modifica credenciais nem sessões');
  // Injeção de falha ANTES do COMMIT: rollback deve ser integral.
  const {recover}=require('../scripts/recover-admin-auth.js');
  await assert.rejects(()=>recover(f.dbRestored,after,{
    quiesced:true,expectedGeneration:gen,
    beforeCommit:async()=>{throw new Error('falha fictícia antes do COMMIT');}
  }));
  assert.deepEqual(await authRows(f.dbRestored),beforeState,'ROLLBACK preserva estado');
  assert.deepEqual(await domain(f.dbRestored),originalDomain);
  const change=cli(['--db',f.dbRestored,'--quiesced',
    '--expected-generation',String(gen),'--password-stdin'],{input:after+'\n'});
  ok(change,'Recuperação offline');
  const afterState=await authRows(f.dbRestored);
  assert.equal(afterState.credential[0].geracao_sessao,gen+1);
  assert.notEqual(afterState.credential[0].hash,beforeState.credential[0].hash);
  assert.ok(afterState.sessions.every(x=>x.revogado_em!==null));
  assert.notEqual(cli(['--db',f.dbRestored,'--quiesced','--expected-generation',
    String(gen),'--password-stdin'],{input:after+'\n'}).status,0,
    'Geração obsoleta bloqueia recuperação repetida');
  assert.deepEqual(await authRows(f.dbRestored),afterState);
  // Somente AGORA o Express fictício pode religar usando banco restaurado.
  app=await start(f,f.dbRestored,f.uploadsRestored);
  let newCookie;
  try{
    for(const cookie of cookies)
      assert.equal((await call(app,'/api/admin/auth/session',{cookie})).status,401);
    assert.equal((await call(app,'/api/admin/auth/login',{
      method:'POST',body:{senha:before}
    })).status,401,'Senha antiga recusada');
    newCookie=await login(app,after);
    assert.equal((await call(app,'/api/admin/auth/session',{cookie:newCookie})).status,200);
  }finally{await stop(app);}
  app=await start(f,f.dbRestored,f.uploadsRestored);
  try {
    assert.equal((await call(app,'/api/admin/auth/session',{cookie:newCookie})).status,200,
      'Sessão nova válida permanece após reinício real do processo');
    for(const cookie of cookies)
      assert.equal((await call(app,'/api/admin/auth/session',{cookie})).status,401);
  } finally {await stop(app);}
  assert.deepEqual(await domain(f.dbRestored),originalDomain,
    'IDs, turma, token, publicação e URL legada intactos');
  assert.equal(digest(fs.readFileSync(path.join(f.uploadsRestored,'imagem-ficticia.png'))),
    originalImage,'Imagem fictícia intacta');
});
