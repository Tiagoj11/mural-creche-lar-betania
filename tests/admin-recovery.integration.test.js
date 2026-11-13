'use strict';
// REC-001: ensaio real HTTP/Express + SQLite em cópia de snapshot FICTÍCIO.
// Nenhum arquivo de banco/credencial/secret do ambiente real é lido.
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
const oldPassword = 'senha-ficticia-inicial-REC001';
const restoredPassword = 'senha-ficticia-recuperada-REC001';
const firstConcurrentPassword = 'nova-senha-ficticia-concorrente-A';
const secondConcurrentPassword = 'nova-senha-ficticia-concorrente-B';

function cmd(args, opts = {}) {
    return spawnSync(process.execPath, args, {
        ...opts, encoding:'utf8', timeout:20000
    });
}
function dbOpen(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file,
            sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
            err => err ? reject(err) : resolve(db));
    });
}
function dbClose(db) {
    return new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
}
function sql(db, query, params = [], mode = 'run') {
    return new Promise((resolve, reject) => db[mode](query, params,
        function(err, result) {
            if (err) reject(err);
            else resolve(mode === 'run' ? {changes:this.changes,lastID:this.lastID} : result);
        }));
}
async function query(file, statement, params = [], mode = 'all') {
    const db=await dbOpen(file);
    try { return await sql(db, statement, params, mode); }
    finally { await dbClose(db); }
}
async function portFree() {
    const server=net.createServer();
    await new Promise((r,e)=>{server.once('error',e);server.listen(0,'127.0.0.1',r);});
    const port=server.address().port;
    await new Promise(r=>server.close(r));
    return port;
}
async function createFixture(t) {
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mural-rec-001-'));
    t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
    const app=path.join(tmp,'checkout');
    const external=path.join(tmp,'outside-checkout');
    const uploads=path.join(tmp,'uploads-ficticios');
    fs.mkdirSync(app);fs.mkdirSync(external);fs.mkdirSync(uploads);
    fs.mkdirSync(path.join(app,'scripts'));
    fs.mkdirSync(path.join(app,'public'));
    fs.symlinkSync(path.join(root,'node_modules'),path.join(app,'node_modules'),'dir');
    for(const file of ['server.js','database.js','admin-auth.js'])
        fs.copyFileSync(path.join(root,file),path.join(app,file));
    for(const file of ['migrate-admin-auth.js','recover-admin-auth.js'])
        fs.copyFileSync(path.join(root,'scripts',file),path.join(app,'scripts',file));
    const dbFile=path.join(external,'mural.db');
    const db=await dbOpen(dbFile);
    try {
        await sql(db,'PRAGMA foreign_keys = ON');
        await sql(db,'CREATE TABLE Turmas (id INTEGER PRIMARY KEY AUTOINCREMENT,nome_turma TEXT NOT NULL UNIQUE,codigo_acesso TEXT UNIQUE)');
        await sql(db,'CREATE TABLE Publicacoes (id INTEGER PRIMARY KEY AUTOINCREMENT,titulo TEXT NOT NULL,descricao TEXT,data TEXT NOT NULL,tipo TEXT NOT NULL,imagem_url TEXT,turma_id INTEGER,FOREIGN KEY(turma_id) REFERENCES Turmas(id) ON DELETE CASCADE)');
        await sql(db,'INSERT INTO Turmas(id,nome_turma,codigo_acesso) VALUES (7,?,?)',
            ['Berçário fictício','abc123']);
        await sql(db,'INSERT INTO Turmas(id,nome_turma,codigo_acesso) VALUES (8,?,?)',
            ['Maternal fictício','def456']);
        await sql(db,'INSERT INTO Publicacoes(id,titulo,descricao,data,tipo,imagem_url,turma_id) VALUES (31,?,?,?,?,?,?)',
            ['Aviso geral','Texto sintético','2026-11-12','Evento',null,null]);
        await sql(db,'INSERT INTO Publicacoes(id,titulo,descricao,data,tipo,imagem_url,turma_id) VALUES (32,?,?,?,?,?,?)',
            ['Evento da turma','Texto sintético','2026-11-12','Evento','/uploads/imagem-ficticia.png',7]);
    } finally { await dbClose(db); }
    fs.writeFileSync(path.join(uploads,'imagem-ficticia.png'),Buffer.from('imagem unicamente sintetica'));
    const migrate=cmd(['scripts/migrate-admin-auth.js','--db',dbFile],{cwd:app});
    assert.equal(migrate.status,0,migrate.stderr);
    return {tmp,app,dbFile,external,uploads};
}
async function startApp(f, dbFile=f.dbFile) {
    const port=await portFree();
    const origin='http://127.0.0.1:'+port;
    const child=spawn(process.execPath,['server.js'],{
        cwd:f.app,
        env:{...process.env,NODE_ENV:'test',PORT:String(port),MURAL_DB_PATH:dbFile,
            ADMIN_PUBLIC_ORIGIN:origin,MURAL_UPLOAD_DIR:f.uploads,
            ADMIN_BOOTSTRAP_ENABLED:'true',
            ADMIN_BOOTSTRAP_UNTIL:String(Date.now()+600000),
            ADMIN_BOOTSTRAP_TOKEN:'token-ficticio-rec001-'+'d'.repeat(48)},
        stdio:['ignore','pipe','pipe']
    });
    let logs='';
    child.stdout.on('data',x=>{logs+=x.toString();});
    child.stderr.on('data',x=>{logs+=x.toString();});
    for(let i=0;i<90;i++){
        if(child.exitCode!==null)throw new Error('Express encerrou: '+logs);
        try{
            const r=await fetch(origin+'/api/admin/auth/status',{signal:AbortSignal.timeout(900)});
            if(r.status===200)return {child,origin,logs:()=>logs};
        }catch{}
        await new Promise(resolve=>setTimeout(resolve,75));
    }
    child.kill();
    throw new Error('Express indisponível: '+logs);
}
async function stopApp(s) {
    if(s.child.exitCode===null && s.child.signalCode===null){
        s.child.kill('SIGTERM');
        await Promise.race([new Promise(r=>s.child.once('exit',r)),
            new Promise(r=>setTimeout(r,3000))]);
        if(s.child.exitCode===null && s.child.signalCode===null)s.child.kill('SIGKILL');
    }
}
async function http(s,url,{method='GET',cookie,csrf,body,origin=s.origin}={}){
    const headers={};
    if(cookie)headers.Cookie=cookie;
    if(csrf)headers['X-CSRF-Token']=csrf;
    if(method!=='GET')headers.Origin=origin;
    if(body!==undefined)headers['Content-Type']='application/json';
    const r=await fetch(s.origin+url,{method,headers,
        body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(7000)});
    const text=await r.text();
    return {status:r.status,body:text?JSON.parse(text):null,
        cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function bootstrapAndLogin(s){
    const init=await http(s,'/api/admin/auth/bootstrap',{method:'POST',
        body:{token_inicial:'token-ficticio-rec001-'+'d'.repeat(48),
            nova_senha:oldPassword}});
    assert.equal(init.status,201,JSON.stringify(init.body));
    return login(s,oldPassword);
}
async function login(s,pass,cookie){
    const res=await http(s,'/api/admin/auth/login',{method:'POST',
        body:{senha:pass},cookie});
    return res;
}
function offline(f,args=[],input){
    return cmd(['scripts/recover-admin-auth.js','--db',f.dbFile,
        '--quiesced',...args],{cwd:f.app,input});
}
function snapshot(file){
    return {
        turmas:null,
        publicacoes:null,
        file
    };
}
async function domain(file) {
    return {
        turmas:await query(file,'SELECT id,nome_turma,codigo_acesso FROM Turmas ORDER BY id'),
        publicacoes:await query(file,'SELECT id,titulo,descricao,data,tipo,imagem_url,turma_id FROM Publicacoes ORDER BY id')
    };
}
async function credentialState(file) {
    const cred=(await query(file,'SELECT * FROM AdminCredencial'))[0];
    const sessions=await query(file,'SELECT sid_digest,admin_id,revogado_em,geracao_sessao FROM AdminSessoes ORDER BY hex(sid_digest)');
    return {hash:cred.senha_hash.toString('hex'),salt:cred.salt.toString('hex'),
        gen:cred.geracao_sessao,sessions:sessions.map(x=>({
            digest:x.sid_digest.toString('hex'),admin:x.admin_id,revoked:x.revogado_em,
            generation:x.geracao_sessao
        }))};
}
function concurrentRecovery(f,password){
    return new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,['scripts/recover-admin-auth.js',
            '--db',f.dbFile,'--quiesced','--expected-generation','1','--password-stdin'],
            {cwd:f.app,stdio:['pipe','pipe','pipe']});
        let stdout='',stderr='';
        child.stdout.on('data',x=>{stdout+=x.toString();});
        child.stderr.on('data',x=>{stderr+=x.toString();});
        child.once('error',reject);
        child.once('close',code=>resolve({code,stdout,stderr}));
        child.stdin.end(password+'\n');
    });
}

test('REC-001: recovery offline pós-restore com HTTP/SQLite real e rollback',async t=>{
    const f=await createFixture(t);
    let app=await startApp(f);
    let originalCookies;
    try{
        const first=await bootstrapAndLogin(app);
        assert.equal(first.status,200);
        const second=await login(app,oldPassword);
        assert.equal(second.status,200);
        originalCookies=[first.cookie,second.cookie];
        for(const cookie of originalCookies)
            assert.equal((await http(app,'/api/admin/auth/session',{cookie})).status,200);
        // O snapshot inclui exatamente duas sessões ainda válidas.
        await stopApp(app); app=null;
        const snapshotDb=path.join(f.external,'snapshot-ficticio.db');
        fs.copyFileSync(f.dbFile,snapshotDb);
        const restored=path.join(f.external,'restaurado-ficticio.db');
        fs.copyFileSync(snapshotDb,restored);
        f.dbFile=restored; // Não tocar o original, apenas cópia restaurada.
        const domainBefore=await domain(restored);
        const imageBefore=crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(f.uploads,'imagem-ficticia.png'))).digest('hex');
        const before=await credentialState(restored);
        assert.equal(before.gen,0);
        assert.equal(before.sessions.length,2);
        assert.ok(before.sessions.every(x=>x.revoked===null));
        assert.equal(offline(f,['--inspect']).status,0);
        const badArgs=offline(f,['--expected-generation','0','--password-stdin'],undefined);
        assert.notEqual(badArgs.status,0,'Sem senha não pode prosseguir');
        const refused=offline(f,['--expected-generation','0','--password-stdin'],
            'curta\n');
        assert.notEqual(refused.status,0);
        assert.deepEqual(await credentialState(restored),before);
        // Injeção ANTES do commit via API de teste, mantendo transação real.
        const recover=require('../scripts/recover-admin-auth').recover;
        await assert.rejects(()=>recover(restored,restoredPassword,{
            quiesced:true,expectedGeneration:0,
            beforeCommit:()=>{throw new Error('falha sintética antes do COMMIT');}
        }),/falha sintética/);
        assert.deepEqual(await credentialState(restored),before,'ROLLBACK integral');
        assert.deepEqual(await domain(restored),domainBefore);
        // Writer real mantém lock -> recuperação falha sem alterar banco.
        const locked=await dbOpen(restored);
        await sql(locked,'BEGIN IMMEDIATE');
        try{
            const result=offline(f,['--expected-generation','0','--password-stdin'],
                restoredPassword+'\n');
            assert.notEqual(result.status,0,'Recusa banco com escritor concorrente');
        } finally{
            await sql(locked,'ROLLBACK');
            await dbClose(locked);
        }
        assert.deepEqual(await credentialState(restored),before);
        // Recuperação efetiva, somente sobre fixture restaurada.
        const success=offline(f,['--expected-generation','0','--password-stdin'],
            restoredPassword+'\n');
        assert.equal(success.status,0,success.stderr);
        assert.doesNotMatch(success.stdout+success.stderr,
            /senha-ficticia|abc123|def456|token-ficticio/);
        const rotated=await credentialState(restored);
        assert.equal(rotated.gen,1);
        assert.notEqual(rotated.hash,before.hash);
        assert.notEqual(rotated.salt,before.salt);
        assert.ok(rotated.sessions.every(x=>x.revoked!==null));
        assert.deepEqual(await domain(restored),domainBefore);
        assert.equal(crypto.createHash('sha256').update(
            fs.readFileSync(path.join(f.uploads,'imagem-ficticia.png'))).digest('hex'),
            imageBefore);
        const retry=offline(f,['--expected-generation','0','--password-stdin'],
            restoredPassword+'\n');
        assert.notEqual(retry.status,0,'Geração usada recusa repetição');
        assert.deepEqual(await credentialState(restored),rotated);
        app=await startApp(f,restored);
        for(const cookie of originalCookies){
            const invalid=await http(app,'/api/admin/auth/session',{cookie});
            assert.equal(invalid.status,401,JSON.stringify(invalid.body));
        }
        assert.equal((await login(app,oldPassword)).status,401);
        const newLogin=await login(app,restoredPassword);
        assert.equal(newLogin.status,200);
        const newCookie=newLogin.cookie;
        const newSession=await http(app,'/api/admin/auth/session',{cookie:newCookie});
        assert.equal(newSession.status,200);
        assert.match(newSession.body.csrf_token,/^[0-9a-f]{64}$/);
        await stopApp(app);app=null;
        app=await startApp(f,restored);
        const persist=await http(app,'/api/admin/auth/session',{cookie:newCookie});
        assert.equal(persist.status,200,'Sessão nova sobrevive a restart real');
        assert.equal(persist.body.csrf_token,newSession.body.csrf_token);
        assert.equal((await http(app,'/api/publicacoes/token/abc123')).body.publicacoes.length,2);
        assert.equal((await http(app,'/api/publicacoes/token/def456')).body.publicacoes.length,1);
        assert.equal((await http(app,'/api/admin/auth/recover')).status,404,
            'Não existe rota pública de recuperação');
        await stopApp(app);app=null;

        // Dois processos off-line com MESMA geração preflight: um único commit.
        const concurrent=await Promise.all([
            concurrentRecovery(f,firstConcurrentPassword),
            concurrentRecovery(f,secondConcurrentPassword)
        ]);
        assert.deepEqual(concurrent.map(x=>x.code).sort(),[0,1]);
        assert.equal((await credentialState(restored)).gen,2);
        app=await startApp(f,restored);
        assert.equal((await http(app,'/api/admin/auth/session',{cookie:newCookie})).status,401);
        const allowedPass=concurrent[0].code===0?firstConcurrentPassword:secondConcurrentPassword;
        const deniedPass=concurrent[0].code===0?secondConcurrentPassword:firstConcurrentPassword;
        assert.equal((await login(app,allowedPass)).status,200);
        assert.equal((await login(app,deniedPass)).status,401);
        assert.deepEqual(await domain(restored),domainBefore);
    } finally { if(app) await stopApp(app); }
});

test('REC-001: esquema incompatível, flags e recuperação incompleta recusados',async t=>{
    const f=await createFixture(t);
    const before=await domain(f.dbFile);
    assert.notEqual(offline(f,['--expected-generation','0','--password-stdin'],
        restoredPassword+'\n').status,0,'Sem credencial singleton não aplica recovery');
    const refused=cmd(['scripts/recover-admin-auth.js','--db',f.dbFile,
        '--expected-generation','0','--password-stdin'],{
        cwd:f.app,input:restoredPassword+'\n'});
    assert.notEqual(refused.status,0,'--quiesced obrigatório');
    await query(f.dbFile,'PRAGMA user_version = 999',[],'run');
    const invalid=offline(f,['--inspect']);
    assert.notEqual(invalid.status,0);
    assert.deepEqual(await domain(f.dbFile),before);
    const relative=cmd(['scripts/recover-admin-auth.js','--db','banco.db','--quiesced',
        '--inspect'],{cwd:f.app});
    assert.notEqual(relative.status,0);
    const absent=cmd(['scripts/recover-admin-auth.js','--db',
        path.join(f.external,'nao-existe.db'),'--quiesced','--inspect'],{cwd:f.app});
    assert.notEqual(absent.status,0);
    assert.ok(!fs.existsSync(path.join(f.external,'nao-existe.db')));
});

test('REC-001: limiter NAT e tempo de recuperação são finitos em relógio controlado',()=>{
    const {createLimiter}=require('../admin-auth');
    let now=10000;
    const limiter=createLimiter(()=>now);
    const nat={ip:'192.0.2.12'};
    const another={ip:'198.51.100.23'};
    for(let i=0;i<5;i++)limiter.check('login',nat,5,100).fail();
    assert.equal(limiter.check('login',nat,5,100).blocked,true);
    assert.equal(limiter.check('login',another,5,100).blocked,false);
    now+=15*60*1000+1;
    assert.equal(limiter.check('login',nat,5,100).blocked,false);
    // 100 falhas de fontes distintas geram só cooldown global de 30s.
    for(let i=0;i<100;i++){
        const req={ip:'203.0.113.'+i};
        const decision=limiter.check('login',req,5,100);
        assert.equal(decision.blocked,false);
        decision.fail();
    }
    assert.equal(limiter.check('login',another,5,100).blocked,true);
    now+=31000;
    assert.equal(limiter.check('login',another,5,100).blocked,false);
});


test('REC-001: troca de senha isola transação de CRUD e falha sem sucesso parcial',async t=>{
    const f=await createFixture(t);
    const app=await startApp(f);
    try {
        const first=await bootstrapAndLogin(app);
        const second=await login(app,oldPassword);
        assert.equal(first.status,200);
        assert.equal(second.status,200);
        const s1=await http(app,'/api/admin/auth/session',{cookie:first.cookie});
        const s2=await http(app,'/api/admin/auth/session',{cookie:second.cookie});
        assert.equal(s1.status,200);
        assert.equal(s2.status,200);
        // Falha artificial do segundo UPDATE da transação. Somente fixture.
        await query(f.dbFile,
            "CREATE TRIGGER abort_revoke BEFORE UPDATE OF revogado_em ON AdminSessoes BEGIN SELECT RAISE(ABORT,'falha sintetica'); END",
            [],'run');
        const [failed,crud]=await Promise.all([
            http(app,'/api/admin/auth/change-password',{method:'POST',
                cookie:first.cookie,csrf:s1.body.csrf_token,
                body:{senha_atual:oldPassword,nova_senha:firstConcurrentPassword}}),
            http(app,'/api/turmas',{method:'POST',
                cookie:second.cookie,csrf:s2.body.csrf_token,
                body:{nome_turma:'Turma concorrente fictícia'}})
        ]);
        assert.equal(failed.status,500,JSON.stringify(failed.body));
        assert.equal(crud.status,201,'CRUD independente não pode ser incluído no rollback auth');
        assert.equal((await http(app,'/api/admin/auth/session',
            {cookie:first.cookie})).status,200);
        assert.equal((await http(app,'/api/admin/auth/session',
            {cookie:second.cookie})).status,200);
        assert.equal((await login(app,oldPassword)).status,200);
        assert.equal((await login(app,firstConcurrentPassword)).status,401);
        const unchanged=await credentialState(f.dbFile);
        assert.equal(unchanged.gen,0);
        assert.ok(unchanged.sessions.every(x=>x.revoked===null));
        assert.ok((await domain(f.dbFile)).turmas.some(x=>x.nome_turma==='Turma concorrente fictícia'));
        await query(f.dbFile,'DROP TRIGGER abort_revoke',[],'run');

        // Duas requisições de troca concorrentes: somente uma pode completar.
        const results=await Promise.all([
            http(app,'/api/admin/auth/change-password',{method:'POST',
                cookie:first.cookie,csrf:s1.body.csrf_token,
                body:{senha_atual:oldPassword,nova_senha:firstConcurrentPassword}}),
            http(app,'/api/admin/auth/change-password',{method:'POST',
                cookie:second.cookie,csrf:s2.body.csrf_token,
                body:{senha_atual:oldPassword,nova_senha:secondConcurrentPassword}})
        ]);
        assert.equal(results.filter(x=>x.status===204).length,1,
            'Somente um commit com troca simultânea');
        assert.ok(results.every(x=>[204,401,403].includes(x.status)),
            JSON.stringify(results.map(x=>x.status)));
        assert.equal((await credentialState(f.dbFile)).gen,1);
        assert.equal((await http(app,'/api/admin/auth/session',{cookie:first.cookie})).status,401);
        assert.equal((await http(app,'/api/admin/auth/session',{cookie:second.cookie})).status,401);
        const winner=results[0].status===204?firstConcurrentPassword:secondConcurrentPassword;
        const loser=results[0].status===204?secondConcurrentPassword:firstConcurrentPassword;
        assert.equal((await login(app,winner)).status,200);
        assert.equal((await login(app,loser)).status,401);
        assert.equal((await login(app,oldPassword)).status,401);
    }finally { await stopApp(app); }
});
