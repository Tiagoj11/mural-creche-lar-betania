'use strict';
// E2E PIX real: roda public/index.html + public/pix.js inalterados via
// Express da composição e SQLite externo descartável. Chromium real.
// Nunca acessa dados, banco, segredos, serviços ou uploads do CEI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const officialKey = '83.526.640/0001-67';
const officialName = 'Associação Assistencial Lar Betânia';

function runSql(db, query) {
  return new Promise((resolve, reject) =>
    db.exec(query, err => err ? reject(err) : resolve()));
}
function closeDb(db) {
  return new Promise((resolve,reject) => db.close(err => err ? reject(err) : resolve()));
}
async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-pix-page-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'data');
  const uploads = path.join(temp, 'uploads');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(uploads, { mode: 0o700 });
  const dbPath = path.join(dataDir, 'mural.sqlite');
  const db = await new Promise((resolve,reject) => {
    const d = new sqlite3.Database(dbPath,err => err ? reject(err) : resolve(d));
  });
  try {
    await runSql(db, 'PRAGMA foreign_keys = ON;'
      + 'CREATE TABLE Turmas(id INTEGER PRIMARY KEY AUTOINCREMENT,'
      + 'nome_turma TEXT NOT NULL UNIQUE, codigo_acesso TEXT UNIQUE);'
      + 'CREATE TABLE Publicacoes(id INTEGER PRIMARY KEY AUTOINCREMENT,'
      + 'titulo TEXT NOT NULL, descricao TEXT, data TEXT NOT NULL, tipo TEXT NOT NULL,'
      + 'imagem_url TEXT, turma_id INTEGER, FOREIGN KEY(turma_id) REFERENCES Turmas(id) ON DELETE CASCADE);'
      + "INSERT INTO Turmas(id,nome_turma,codigo_acesso) VALUES(7,'Turma fictícia','token-ficticio-pix');"
      + "INSERT INTO Publicacoes(id,titulo,descricao,data,tipo,turma_id) VALUES(31,'Aviso geral fictício','Teste público','2026-11-12','Evento',NULL);");
  } finally { await closeDb(db); }
  const migration=spawnSync(process.execPath, ['scripts/migrate-admin-auth.js','--db',dbPath],
    { cwd:root, encoding:'utf8', timeout:20000 });
  assert.equal(migration.status,0,'Migração apenas do SQLite fictício: '+migration.stderr);
  return {temp,dbPath,uploads};
}
async function freePort() {
  const server=net.createServer();
  await new Promise((resolve,reject)=>{
    server.once('error',reject); server.listen(0,'127.0.0.1',resolve);
  });
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function start(f) {
  const port=await freePort();
  const origin='http://127.0.0.1:'+port;
  let logs='';
  const p=spawn(process.execPath,['server.js'],{
    cwd:root,
    env:{
      PATH:process.env.PATH,HOME:process.env.HOME,
      NODE_ENV:'test',PORT:String(port),
      MURAL_DB_PATH:f.dbPath,MURAL_UPLOAD_DIR:f.uploads,
      ADMIN_PUBLIC_ORIGIN:origin,ADMIN_BOOTSTRAP_ENABLED:'false'
    },stdio:['ignore','pipe','pipe']
  });
  p.stdout.on('data',chunk=>{logs+=chunk.toString();});
  p.stderr.on('data',chunk=>{logs+=chunk.toString();});
  for(let i=0;i<100;i++){
    if(p.exitCode!==null||p.signalCode!==null)throw new Error('Express saiu: '+logs.slice(-1000));
    try {
      const r=await fetch(origin+'/api/admin/auth/status',{signal:AbortSignal.timeout(750)});
      if(r.status===200)return {p,origin};
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,60));
  }
  p.kill('SIGKILL');
  throw new Error('Express fictício não respondeu: '+logs.slice(-1000));
}
async function stop(s) {
  if(!s || s.p.exitCode!==null || s.p.signalCode!==null)return;
  const exited=new Promise(resolve=>s.p.once('exit',resolve));
  s.p.kill('SIGTERM');
  const result=await Promise.race([exited,new Promise(resolve=>setTimeout(()=>resolve('timeout'),3000))]);
  if(result==='timeout'){s.p.kill('SIGKILL');await exited;}
}
async function openPage(browser,origin,width,token='') {
  const context=await browser.newContext({viewport:{width,height:780},serviceWorkers:'block'});
  const page=await context.newPage();
  // CI não depende de CDN; HTML, CSS interno e pix.js são os ARQUIVOS reais.
  await page.route('https://cdn.tailwindcss.com/**',route=>route.abort());
  const res=await page.goto(origin+'/'+token,{waitUntil:'load',timeout:15000});
  assert.equal(res.status(),200,'HTML real servido pelo Express');
  await page.addStyleTag({content:'.hidden{display:none!important}.max-w-md{max-width:28rem}.mx-auto{margin-left:auto;margin-right:auto}.px-4{padding-left:1rem;padding-right:1rem}.w-full{width:100%}'});
  const scriptResponse=await page.request.get(origin+'/pix.js');
  assert.equal(scriptResponse.status(),200,'pix.js real servido pelo Express');
  await page.locator('#tab-apoie').click();
  assert.equal(await page.locator('#sec-apoie').isVisible(),true);
  return {context,page};
}

test('PIX página real: 320/375/430, beneficiário, chave exata, Apoie sem login e clipboard Chromium',
  {timeout:90000},async t=>{
    const fixtureData=await fixture(t);
    let server, browser;
    try {
      server=await start(fixtureData);
      browser=await chromium.launch({headless:true});
      for(const width of [320,375,430]){
        const {context,page}=await openPage(browser,server.origin,width);
        try {
          const text=await page.locator('#sec-apoie').innerText();
          assert.ok(text.includes(officialName),'Beneficiário literal e visível');
          assert.equal((await page.locator('#pix-chave').innerText()).trim(),officialKey);
          assert.equal(await page.locator('#btn-copiar-pix').isVisible(),true);
          assert.equal(await page.locator('#btn-selecionar-pix').isVisible(),true);
          const dims=await page.evaluate(()=>({
            sw:document.documentElement.scrollWidth,
            iw:window.innerWidth,
            pix:document.querySelector('#pix-chave').getBoundingClientRect().width
          }));
          assert.ok(dims.sw<=dims.iw+1,'Sem overflow horizontal a '+width+'px: '+JSON.stringify(dims));
          assert.ok(dims.pix>0);
          await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:server.origin});
          await page.locator('#btn-copiar-pix').click();
          await page.locator('#pix-notificacao[data-estado="sucesso"]').waitFor({state:'visible'});
          assert.equal(await page.locator('#pix-aviso-mensagem').innerText(),
            'Chave PIX copiada com sucesso!');
          assert.equal(await page.locator('#pix-notificacao').getAttribute('role'),'status');
          assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),officialKey,
            'Clipboard nativo Chromium deve receber somente a chave exata');
          assert.equal(await page.locator('#sec-apoie canvas').count(),0,
            'Nenhum QR PIX foi criado');
          // Também sem token ou login o mural Apoie deve ser público.
          assert.equal(await page.locator('#auth-login').count(),0);
        }finally{await context.close();}
      }
    } finally {if(browser)await browser.close();await stop(server);}
  });

test('PIX página real: falha de Clipboard, teclado/fallback manual e token inválido',
  {timeout:90000},async t=>{
    const f=await fixture(t);
    let server,browser;
    try{
      server=await start(f);
      browser=await chromium.launch({headless:true});
      const {context,page}=await openPage(browser,server.origin,375,'?token=token-invalido');
      try{
        assert.equal(await page.locator('#sec-apoie').isVisible(),true);
        // Injeta falha APENAS da permissão Clipboard; markup/eventos são reais.
        await page.evaluate(()=>{
          Object.defineProperty(navigator,'clipboard',{
            configurable:true,value:{writeText:()=>Promise.reject(new Error('Negado no ensaio'))}
          });
        });
        await page.locator('#btn-copiar-pix').click();
        await page.locator('#pix-notificacao[data-estado="erro"]').waitFor({state:'visible'});
        assert.equal(await page.locator('#pix-notificacao').getAttribute('role'),'alert');
        assert.match(await page.locator('#pix-aviso-mensagem').innerText(),/copie manualmente/);
        assert.equal(await page.locator('#pix-ajuda-manual').isVisible(),true);
        assert.equal(await page.evaluate(()=>window.getSelection()?.toString().trim()),
          officialKey,'Fallback seleciona a chave real');
        assert.equal(await page.locator('#pix-notificacao[data-estado="sucesso"]').count(),0);
        await page.locator('#pix-aviso-fechar').click();
        assert.equal(await page.locator('#pix-notificacao').isVisible(),false,
          'Aviso pode ser fechado');
        await page.locator('#btn-selecionar-pix').focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(()=>window.getSelection()?.toString().trim()),
          officialKey,'Seleção manual funciona via teclado');
      }finally{await context.close();}
    }finally{if(browser)await browser.close();await stop(server);}
  });
