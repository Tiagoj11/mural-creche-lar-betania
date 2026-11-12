'use strict';

/**
 * E2E Frontend: Chromium real + Express + SQLite DESCARTÁVEIS em integração.
 * A branch Frontend depende dos arquivos admin-auth.js e migrate-admin-auth.js
 * do PR Backend. Não executa sobre banco, servidor, segredo ou ambiente reais.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mural-auth-browser-'));
const checkout = path.join(fixtureDir, 'checkout');
const dataDir = path.join(fixtureDir, 'dados');
const dbPath = path.join(dataDir, 'mural.db');
const uploadDir = path.join(dataDir, 'uploads');
const bootstrapToken = crypto.randomBytes(32).toString('hex'); // fictício e temporário
const password = 'senha-ficticia-de-teste-2026';
const newPassword = 'nova-senha-ficticia-de-teste-2026';
const injection = '<img src=x onerror="window.__xss=true">';
let server, db, browser, context, otherContext, origin;
let processOutput = '';

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}
async function openDb(filename) {
    return await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(filename,
            err => err ? reject(err) : resolve(connection));
    });
}
async function freePort() {
    const netServer = net.createServer();
    await new Promise((resolve, reject) => {
        netServer.once('error', reject);
        netServer.listen(0, '127.0.0.1', resolve);
    });
    const port = netServer.address().port;
    await new Promise(resolve => netServer.close(resolve));
    return port;
}
async function startServer() {
    fs.mkdirSync(path.join(checkout, 'public'), { recursive:true });
    fs.mkdirSync(path.join(checkout, 'scripts'), { recursive:true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(uploadDir, { recursive: true });
    for (const file of ['server.js', 'database.js', 'admin-auth.js']) {
        const src = path.join(root, file);
        assert.ok(fs.existsSync(src), 'A composição exige o PR Backend: ' + file);
        fs.copyFileSync(src, path.join(checkout, file));
    }
    const migrate = path.join('scripts', 'migrate-admin-auth.js');
    assert.ok(fs.existsSync(path.join(root, migrate)),
        'A composição exige o migrador offline do PR Backend.');
    fs.copyFileSync(path.join(root, migrate), path.join(checkout, migrate));
    fs.copyFileSync(path.join(root, 'public', 'admin.html'),
        path.join(checkout, 'public', 'admin.html'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
    assert.notEqual(dbPath, path.join(root, 'banco.db'));

    db = await openDb(dbPath);
    await run(db, 'PRAGMA foreign_keys=ON');
    await run(db, 'CREATE TABLE Turmas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome_turma TEXT NOT NULL UNIQUE, codigo_acesso TEXT UNIQUE)');
    await run(db, 'CREATE TABLE Publicacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL, descricao TEXT, data TEXT NOT NULL, tipo TEXT NOT NULL, imagem_url TEXT, turma_id INTEGER, FOREIGN KEY(turma_id) REFERENCES Turmas(id) ON DELETE CASCADE)');
    await run(db, 'INSERT INTO Turmas(nome_turma,codigo_acesso) VALUES (?,?)', ['Turma Alfa','aaaaaa']);
    await run(db, 'INSERT INTO Turmas(nome_turma,codigo_acesso) VALUES (?,?)', ['Turma Beta','bbbbbb']);
    await run(db, 'INSERT INTO Publicacoes(titulo,descricao,data,tipo,imagem_url,turma_id) VALUES (?,?,?,?,?,?)',
        ['Evento para todos', 'Descrição de teste', '2026-11-11','Evento',null,null]);
    await run(db, 'INSERT INTO Publicacoes(titulo,descricao,data,tipo,imagem_url,turma_id) VALUES (?,?,?,?,?,?)',
        [injection, 'Descrição de teste', '2026-11-11','Evento',null,1]);
    await run(db, 'INSERT INTO Publicacoes(titulo,descricao,data,tipo,imagem_url,turma_id) VALUES (?,?,?,?,?,?)',
        ['Aviso da Beta', 'Conteúdo de teste', '2026-11-11','Evento',null,2]);
    await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
    db = null;
    const migrated = spawnSync(process.execPath,
        [migrate, '--db', dbPath], { cwd: checkout, encoding:'utf8', timeout:20000 });
    assert.equal(migrated.status,0,'Migração fictícia: '+migrated.stderr);
    origin = 'http://127.0.0.1:' + await freePort();
    server = spawn(process.execPath, ['server.js'], {
        cwd: checkout,
        env: { ...process.env,
            NODE_ENV:'test', PORT: new URL(origin).port,
            MURAL_DB_PATH: dbPath, MURAL_UPLOAD_DIR: uploadDir,
            ADMIN_PUBLIC_ORIGIN: origin,
            ADMIN_BOOTSTRAP_ENABLED:'true',
            ADMIN_BOOTSTRAP_UNTIL:String(Date.now()+10*60*1000),
            ADMIN_BOOTSTRAP_TOKEN:bootstrapToken
        },
        stdio:['ignore','pipe','pipe']
    });
    server.stdout.on('data', chunk => processOutput += chunk.toString().slice(0,800));
    server.stderr.on('data', chunk => processOutput += chunk.toString().slice(0,800));
    let ready=false;
    for(let attempt=0;attempt<100;attempt++){
        if(server.exitCode !== null) throw new Error('Servidor encerrou antes dos testes');
        try{
            const response=await fetch(origin+'/api/admin/auth/status',{signal:AbortSignal.timeout(500)});
            if(response.status===200){ready=true;break;}
        }catch{}
        await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(ready,'Express auth/SQLite descartável indisponível');
}
async function cleanup(){
    if(otherContext) await otherContext.close();
    if(context) await context.close();
    if(browser) await browser.close();
    if(db) await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
    if(server&&server.exitCode===null){
        server.kill('SIGTERM');
        await Promise.race([new Promise(r=>server.once('exit',r)),
            new Promise(r=>setTimeout(r,3000))]);
        if(server.exitCode===null) server.kill('SIGKILL');
    }
    fs.rmSync(fixtureDir,{recursive:true,force:true});
}
test('Sessão administrativa: Chromium real, Express e SQLite fictícios', {timeout:180000}, async t=>{
    try{
        await startServer();
        browser=await chromium.launch({headless:true});
        context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
        const page=await context.newPage();
        const requests=[],dialogs=[];
        page.on('request', r=>{
            const u=new URL(r.url());
            if(u.origin!==origin||!u.pathname.startsWith('/api/'))return;
            requests.push({path:u.pathname.replace(/\/token\/[^/]+/,'/token/[oculto]'),
                method:r.method(), auth:Boolean(r.headers().authorization),
                csrf:Boolean(r.headers()['x-csrf-token'])});
        });
        page.on('dialog',async dialog=>{dialogs.push(dialog.type());await dialog.accept();});
        await page.route('https://cdn.tailwindcss.com/**',route=>route.abort());
        const response=await page.goto(origin+'/admin.html',{waitUntil:'domcontentloaded'});
        assert.equal(response.status(),200);
        await page.addStyleTag({content:'.hidden{display:none!important}'});
        const $=selector=>page.locator(selector);
        const list=$('#lista-publicacoes');
        const row=text=>list.locator(':scope > div').filter({hasText:text});

        await t.test('bootstrap só após segredo de operador; não cria sessão', async()=>{
            await $('#auth-bootstrap').waitFor({state:'visible'});
            assert.equal(await $('#admin-panel').isHidden(),true);
            assert.equal(requests.some(r=>r.path==='/api/turmas'),false);
            await $('#token-inicial').fill('invalidado');
            await $('#bootstrap-senha').fill(password);
            await $('#bootstrap-confirmar').fill(password);
            await $('#btn-criar-senha').click();
            await page.waitForFunction(()=>document.querySelector('#notificacao-mensagem')
                .textContent.toLowerCase().includes('não autorizada'));
            assert.equal(await $('#admin-panel').isHidden(),true);
            await $('#token-inicial').fill(bootstrapToken);
            await $('#bootstrap-senha').fill(password);
            await $('#bootstrap-confirmar').fill(password);
            await $('#btn-criar-senha').click();
            await $('#auth-login').waitFor({state:'visible'});
            assert.equal(await $('#token-inicial').inputValue(),'');
            assert.equal(await $('#admin-panel').isHidden(),true);
        });
        await t.test('401 login inválido e login correto único campo, listagem automática',async()=>{
            await $('#login-senha').fill('senha-incorreta');
            await $('#btn-entrar').click();
            await page.waitForFunction(()=>!document.querySelector('#btn-entrar').disabled
                && document.querySelector('#notificacao-mensagem').textContent.includes('Credenciais inválidas'));
            assert.equal(await $('#login-senha').inputValue(),'');
            await $('#login-senha').fill(password);
            await $('#btn-entrar').click();
            await $('#admin-panel').waitFor({state:'visible'});
            await row('Evento para todos').waitFor();
            assert.equal(await $('#senha_admin').count(),0);
            assert.equal(await $('#nova-turma-senha').count(),0);
            assert.equal(await $('#turma_id option').count(),3);
            assert.match(await row('Evento para todos').innerText(),/Geral/);
            assert.match(await row('Aviso da Beta').innerText(),/Turma Beta/);
            for(const r of requests){assert.equal(r.auth,false,'Nunca Authorization: '+r.path);}
            assert.ok(requests.some(r=>r.path==='/api/turmas'&&r.method==='GET'));
            assert.ok(requests.some(r=>r.path==='/api/admin/publicacoes'&&r.method==='GET'));
        });
        await t.test('XSS, edição Geral↔Turma e upload sem senha repetida',async()=>{
            assert.equal(await row(injection).count(),1);
            assert.equal(await row(injection).locator('img').count(),0);
            assert.equal(await page.evaluate(()=>window.__xss===true),false);
            await row('Evento para todos').getByRole('button',{name:'Editar'}).click();
            assert.equal(await $('#publicacao-geral').isChecked(),true);
            assert.equal(await $('#turma_id').isDisabled(),true);
            await $('#publicacao-geral').uncheck();
            assert.equal(await $('#turma_id').inputValue(),'');
            await $('#turma_id').selectOption({label:'Turma Alfa'});
            await $('#titulo').fill('Evento transformado em específico');
            await $('#btn-submit').click();
            await row('Evento transformado em específico').waitFor();
            assert.match(await row('Evento transformado em específico').innerText(),/Turma Alfa/);
            await $('#publicacao-geral').check();
            assert.equal(await $('#turma_id').isDisabled(),true);
            await $('#titulo').fill('Publicação geral temporária');
            await $('#data').fill('2026-11-11');
            await $('#tipo').selectOption('Evento');
            await $('#imagem').setInputFiles({
                name: 'foto-ficticia.png', mimeType: 'image/png',
                buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/+VcAAAAASUVORK5CYII=', 'base64')
            });
            await $('#btn-submit').click();
            await row('Publicação geral temporária').waitFor();
            assert.match(await row('Publicação geral temporária').innerText(),/Geral/);
            assert.ok(requests.some(r=>r.path==='/api/publicacoes'&&r.method==='POST'&&r.csrf));
            assert.ok(requests.some(r=>/^\/api\/publicacoes\/\d+$/.test(r.path)&&r.method==='PUT'&&r.csrf));
        });
        await t.test('turmas, link individual, excluir com confirmação e CSRF',async()=>{
            await page.getByTitle('Cadastrar nova turma').click();
            await $('#nova-turma-nome').fill('Turma Nova');
            await page.getByRole('button',{name:'Cadastrar',exact:true}).click();
            await page.locator('#turma_id option',{hasText:'Turma Nova'}).waitFor();
            await page.getByTitle('Cadastrar nova turma').click();
            await $('#nova-turma-nome').fill('Turma Nova');
            await page.getByRole('button',{name:'Cadastrar',exact:true}).click();
            await page.waitForFunction(()=>document.querySelector('#notificacao-mensagem')
                .textContent.includes('já existe'));
            assert.equal(await $('#turma_id option').count(),4);
            await page.getByRole('button',{name:'Cancelar'}).click();
            await $('#turma_id').selectOption({label:'Turma Nova'});
            await page.getByRole('button',{name:'Copiar Link Mágico'}).click();
            const copied=new URL(await page.evaluate(()=>navigator.clipboard.readText()));
            assert.equal(copied.origin,origin);
            assert.deepEqual([...copied.searchParams.keys()],['token']);
            assert.match(copied.searchParams.get('token'),/^[0-9a-f]{6}$/);
            const ok=await fetch(origin+'/api/publicacoes/token/'+
                encodeURIComponent(copied.searchParams.get('token')));
            assert.equal(ok.status,200);
            assert.equal((await fetch(origin+'/api/publicacoes/token/invalido')).status,404);
            await row('Publicação geral temporária').getByRole('button',{name:'Excluir'}).click();
            await page.waitForFunction(()=>!document.querySelector('#lista-publicacoes')
                .textContent.includes('Publicação geral temporária'));
            assert.ok(dialogs.includes('confirm'));
            assert.ok(requests.some(r=>/^\/api\/publicacoes\/\d+$/.test(r.path)&&r.method==='DELETE'&&r.csrf));
        });
        await t.test('reload e duas abas com mesmo cookie mantêm sessão e CSRF',async()=>{
            const csrf1=await page.evaluate(()=>csrfToken);
            await page.reload({waitUntil:'domcontentloaded'});
            await $('#admin-panel').waitFor({state:'visible'});
            assert.equal(await page.evaluate(()=>csrfToken),csrf1);
            const another=await context.newPage();
            await another.route('https://cdn.tailwindcss.com/**',route=>route.abort());
            await another.goto(origin+'/admin.html',{waitUntil:'domcontentloaded'});
            await another.locator('#admin-panel').waitFor({state:'visible'});
            assert.equal(await another.evaluate(()=>csrfToken),csrf1);
            await another.close();
            for(const width of [320,375,430,1280]){
                await page.setViewportSize({width,height:800});
                assert.equal(await page.evaluate(()=>
                    document.documentElement.scrollWidth>window.innerWidth),false);
            }
        });
        await t.test('logout limpa UI e outra sessão independente continua',async()=>{
            otherContext=await browser.newContext();
            const independent=await otherContext.newPage();
            await independent.route('https://cdn.tailwindcss.com/**',route=>route.abort());
            await independent.goto(origin+'/admin.html');
            await independent.locator('#login-senha').fill(password);
            await independent.locator('#btn-entrar').click();
            await independent.locator('#admin-panel').waitFor({state:'visible'});
            const otherCsrf=await independent.evaluate(()=>csrfToken);
            assert.notEqual(otherCsrf,await page.evaluate(()=>csrfToken));
            await $('#btn-sair').click();
            await $('#auth-login').waitFor({state:'visible'});
            assert.equal(await $('#lista-publicacoes').textContent(),
                'Aguardando autenticação administrativa...');
            assert.equal(await $('#turma_id option').count(),1);
            assert.equal(await $('#admin-panel').isHidden(),true);
            await independent.reload();
            await independent.locator('#admin-panel').waitFor({state:'visible'});
            await $('#login-senha').fill(password);
            await $('#btn-entrar').click();
            await $('#admin-panel').waitFor({state:'visible'});
        });
        await t.test('troca exige senha anterior e revoga todas as sessões',async()=>{
            await $('#btn-alterar-senha').click();
            await $('#auth-change').waitFor({state:'visible'});
            await $('#senha-atual').fill('errada');
            await $('#senha-nova').fill(newPassword);
            await $('#senha-confirmar').fill(newPassword);
            await $('#btn-confirmar-troca').click();
            await page.waitForFunction(()=>document.querySelector('#notificacao-mensagem')
                .textContent.includes('Senha atual incorreta'));
            assert.equal(await $('#auth-change').isVisible(),true);
            await $('#senha-atual').fill(password);
            await $('#senha-nova').fill(newPassword);
            await $('#senha-confirmar').fill(newPassword);
            await $('#btn-confirmar-troca').click();
            await $('#auth-login').waitFor({state:'visible'});
            const independent=otherContext.pages()[0];
            await independent.reload();
            await independent.locator('#auth-login').waitFor({state:'visible'});
            await $('#login-senha').fill(newPassword);
            await $('#btn-entrar').click();
            await $('#admin-panel').waitFor({state:'visible'});
        });
    }finally{await cleanup();}
});
