# Autenticação administrativa — runbook de implantação futura e CI

> **Somente código/documentação de preparação.** A autorização vigente permite
> branches de desenvolvimento, testes descartáveis e PRs Draft para `V1`.
> NÃO autoriza bootstrap com segredo real, alteração de Oracle/DNS/HTTPS, migração
> de dados reais, merge, `main`, deploy ou acesso de famílias.
>
> Referência técnica: `MELHORIA-ADM-AUTH-001`, contrato normativo privado 1.0,
> `docs/ORACLE_OPERACAO_LOTE3.md` e scripts de operação existentes.
> O contrato e os registros de governança permanecem **somente no Drive privado**.

## 1. Dependências para entrar em operação

A aplicação legada em `V1` autentica por `Authorization: ADMIN_SECRET_KEY`.
O Backend deve substituir esse mecanismo (sem fallback) por cookie de sessão,
migrador SQLite offline e seis endpoints do contrato normativo; o Frontend deve
consumir a sessão e usar CSRF. **Este PR DevOps não implementa endpoints,
`trust proxy` Express, middleware, bind de host ou SQL de autenticação.**

Inventariar todas as rotas administrativas (incluindo upload antes de Multer),
garantir autenticação e CSRF em POST/PUT/DELETE, logout e mudança de senha.
Acesso público por `/?token=`, duas turmas isoladas, Geral/Turma, Apoie sem PIX
fictício, imagens legadas e PWA permanecem. Nenhuma sessão, senha ou token de
turma pode entrar no Cache Storage do service worker.

Antes de qualquer deploy, bloquear até que **todos** sejam verdadeiros:
Backend+Frontend em revisão compatível, migrador offline idempotente entregue,
Code Review favorável, CI combinado sem skips, autorização separada do operador,
ambiente HTTPS e armazenamento externo conferidos. Não usar este arquivo para
abrir uma janela operacional sem essa autorização.

## 2. Bootstrap: negado por padrão

- A futura implementação deve exigir simultaneamente `AdminCredencial` ausente,
  flag de servidor habilitada, janela máxima de **15 minutos** medida no servidor,
  `ADMIN_BOOTSTRAP_TOKEN` de alta entropia provisionado por operador autorizado,
  `Origin` HTTPS exato, orçamento de tentativas e inserção singleton transacional.
  `status.configurado=false` **não** concede permissão.
- `.env.example` apresenta `ADMIN_BOOTSTRAP_ENABLED=false` e
  `ADMIN_BOOTSTRAP_UNTIL=<EPOCH_MILISSEGUNDOS>` como nomes confirmados no
  PR Backend #20. O Backend deve recusar deadline ausente, passado ou a mais de
  15 minutos do início do processo; a variável `false` no
  exemplo **não é controle de segurança sozinho**.
- **Nunca versionar ou comunicar** valor real de `ADMIN_BOOTSTRAP_TOKEN`;
  segredos são provisionados diretamente via console/SSH autorizado no arquivo
  `/etc/mural-creche/mural.env` com acesso restrito ao processo. Não passar
  senha/token em argumento de shell ou URL, nem imprimir nos journals.
- Em uma **janela futura explicitamente autorizada**, operador primeiro confirma
  migração, backup e HTTPS; habilita flag e expiração no servidor, disponibiliza
  token de uso único por canal administrativo, conclui cadastro inicial e verifica
  estado `configurado=true`. Bootstrap **não inicia sessão automaticamente**.
  Após sucesso, desliga a flag, remove token do ambiente e reinicia/recarrega
  serviço de modo controlado; segunda tentativa retorna 409.
- Em falha, encerrar janela, inspecionar estado no SQLite sem revelar segredo,
  não criar outro admin e não reabrir a janela sem autorização.

### Política inicial de tentativas (Backend deve implementar e testar)

| Operação | Por origem confiável | Global | Período |
|---|---:|---:|---|
| Login | 5 falhas | teto inicial 100 falhas | 15 min |
| Bootstrap | 3 falhas | teto inicial 10 falhas | 15 min |

Limiares iniciais requerem teste de NAT/DoS e revisão de Code Review. Usar
contadores de expiração finita e desaceleração global curta; **nunca ban
permanente** ou indisponibilidade ilimitada causada por terceiro. Origem é
obtida do proxy conhecido, não de `X-Forwarded-For` arbitrário. Resposta 429;
`Retry-After` só se houver duração efetiva conhecida. Nenhum IP bruto ou senha
em logs. Limitar também tamanho de payload.

## 3. Caddy, proxy confiável e cookie

`deploy/caddy/Caddyfile.example` é apenas modelo; hostname
`mural.example.invalid` **não representa domínio real**. O hostname aprovado
deve constar no allowlist de Origin do Backend ANTES do deploy. Caddy recebe
HTTPS (443, redireção 80→443) e repassa a Express local `127.0.0.1:3000`.
Headers forwarded são sobrescritos a partir da conexão Caddy, nunca aceitos do
cliente não confiável; não habilitar `trusted_proxies` amplo.

**Gate não atendido pelo arquivo de exemplo:** o `server.js` atual usa
`app.listen(PORT)` e não restringe interface. O Backend deve suportar bind
explícito a loopback ou o operador deve bloquear `:3000` externamente via
NSG/firewall e validar de fora. Sem isso, **NÃO ATIVAR** o serviço. Express deve
confiar exclusivamente no proxy real (não `trust proxy=true`). Não permitir
spoof de `X-Forwarded-Proto`, `X-Forwarded-Host` ou `X-Forwarded-For`;
recusar autenticação HTTP em produção.

Cookie `mural_admin_sid`: host-only (sem Domain), `HttpOnly`, `Secure`,
`SameSite=Strict`, `Path=/`. SID gerado com 32 bytes aleatórios ou mais;
SQLite armazena somente digest. Backend verifica sessão, revogação e geração
antes de derivar CSRF por HMAC-SHA256 keyed pelo SID e mensagem fixa
`mural-csrf-v1`. Frontend obtém CSRF por `GET /session` com
`Cache-Control: no-store` e o mantém somente em RAM. Duas abas na mesma
sessão recebem token estável; troca de senha invalida todas as sessões.

Proteger toda mutação admin com cookie, `Origin` presente/exato e
`X-CSRF-Token`, validando **ANTES** de gravar uploads com Multer.
Nenhum CORS admin aberto ou wildcard credenciado, inclusive `cors()` legado.
`Cache-Control: no-store` no HTML admin, APIs privadas e autenticação;
não cachear conteúdo por token nem as rotas admin no service worker.
Validar `Set-Cookie`, HTTPS, CORS, Origin, CSRF, firewall, logs mascarados,
restart e recursos Oracle apenas em homologação operacional autorizada.

## 4. Migração explícita de SQLite externo

O arquivo `MURAL_DB_PATH` deve ser absoluto, externo ao release, existente,
regular (sem symlink) e íntegro. A base externa **não é criada nem alterada
automaticamente** pelo startup. Não usar `--allow-new-db` como migrador ou
permissão para iniciar um banco vazio. É proibido executar DDL desta melhoria
em `banco.db` real neste gate.

**Dependência do Backend:** migrador offline versionado e idempotente, esquema
de `AdminCredencial` singleton e `AdminSessoes`, digest/índices/revogação,
rotina offline de recuperação e testes de migrar duas vezes. DevOps **não
define tabelas reais** neste runbook; usar o contrato aprovado e o arquivo
de migração produzido pelo Backend após Code Review.

Roteiro para futuro ensaio autorizado:

1. Confirmar operador/maintenance window e versões específicas de código/banco.
   Inventariar IDs, contagens de `Turmas`/`Publicacoes`, URLs das imagens e
   checksums/digests protegidos dos códigos de turma **sem imprimi-los**.
2. Parar aplicação e demais escritores, conferir `MURAL_DB_PATH`,
   `MURAL_UPLOAD_DIR`, owner e permissões (0700 diretórios; 0600 DB).
   Preparar backup consistente de SQLite + uploads durante janela `quiesced`.
3. Executar `python3 scripts/ops/mural_data.py backup --help`, depois
   `backup --db <ARQUIVO_SQLITE> --uploads <PASTA_IMAGENS>
   --output <SNAPSHOT_NOVO> --quiesced` **somente em ambiente autorizado**;
   verificar com `verify --snapshot <SNAPSHOT>` e cópia criptografada off-host.
   Backups contêm códigos de acesso, hash de senha e sessões.
4. Restaurar snapshot em **diretórios novos e isolados** por dry-run e, sob
   autorização, `restore --quiesced --apply`; jamais sobrescrever a fonte.
   Validar `PRAGMA integrity_check`, `foreign_key_check`, permissões,
   hashes das imagens e mesmas identidades/tokens/URLs.
5. Invocar o migrador Backend **somente contra a cópia descartável** nos
   testes desta melhoria; confirmar transação `BEGIN IMMEDIATE`, rollback
   integral em falha, idempotência em segunda execução e versão registrada.
   Validar schema auth sem modificar `Turmas`, `Publicacoes` ou seus IDs.
6. Planejar cutover de código Backend+Frontend+DB juntos. Depois da migração,
   falha de schema deve **bloquear o serviço**, não voltar a
   `Authorization: ADMIN_SECRET_KEY`. Retirar caminho legado na release nova.

### Recuperação offline e restauração antiga

Uma restauração de snapshot anterior **pode reintroduzir sessões ativas e
hash de senha antigo**. O backup/restore por si só não revoga sessões.
Antes de reabrir a rede, operador identificado, em manutenção, deverá executar
a **ferramenta offline do Backend** que revoga todas as sessões restauradas,
rotaciona a credencial e incrementa sua geração transacionalmente.
Não executar SQL ad hoc nem reabrir bootstrap público como reset.
Sem essa ferramenta entregue e ensaiada, **restauração não está aprovada
para uso operacional**. Testar que cookies anteriores retornam 401.

Rollback deve tratar **revisão de código e schema/banco compatíveis**,
preservar origem e snapshots, nunca apagar ou sobrescrever dados reais.
Documentar quem autoriza parada, restore e rotação; armazenar logs de ação
mínimos sem dados de acesso.

## 5. CI obrigatório, testes e dependências entre PRs

O workflow `.github/workflows/v1-integration-tests.yml` mantém, no mesmo
checkout Ubuntu Node22: `npm ci --no-audit --no-fund`, `npm test` (inclui
`tests/infra-auth-ops.test.js`), Playwright Chromium,
`tests/admin-browser.e2e.cjs`, `tests/lote2-integration.e2e.cjs`,
`tests/lote3-frontend-browser.e2e.cjs`, testes Backend de HTTP/auth e
E2E Auth Chromium de login/sessão.

O gate HTTP exige arquivos `tests/*auth*.test.js` (exceto
`tests/infra-*`). O gate Chromium aceita `tests/*auth*.e2e.cjs` como
suíte separada **ou** a suíte ampliada `tests/admin-browser.e2e.cjs`
produzida pelo Frontend, contendo bootstrap, login, CSRF e múltiplas sessões:
nesse segundo caso, ela **já é executada** no passo Chromium obrigatório
anterior, não é ignorada. Essas convenções foram alinhadas com os PRs
Backend #20 e Frontend #21; Code Review deve conferir todas as assertivas.
O gate é deliberadamente **vermelho** no PR DevOps isolado se essas suítes
ainda faltarem; não reportar CI verde como autenticação validada.
Não renomear ou pular testes só para atingir green. O CI combinado dos três
HEADs só é aprovado se todas as suítes estiverem presentes e passarem,
inclusive cenários negativos e migração/rollback.

A suíte DevOps isolada exercita apenas snapshots com credenciais/sessões
**fictícias**; não prova scrypt, cookies, revogação global, migração do Backend,
CORS/CSRF nem UI. Esses controles dependem de testes reais dos responsáveis.

A composição temporária (quando os PRs existirem) deve usar exatamente
os blobs alterados de Backend, Frontend e DevOps, preservar a base `V1`,
comparar hashes de origem e executar todas as suítes sobre o mesmo HEAD.
PR temporário de CI não pode ser mesclado. Registar job, SHA, contagens
pass/fail/skip, dependências e correções por proprietário.

## 6. Evidências e gates pendentes

**Somente nesta autorização:** exemplos GitHub, runbook, script/fixtures
descartáveis e CI; zero ações em VM ou dados reais.

Antes de operação futura: origem HTTPS verdadeira, bind e NSG/porta 3000,
Caddy/Express trust proxy e Set-Cookie Secure comprovados, origem/CSRF,
rate limit/DoS/NAT, migrador/backend+frontend compatível, Code Review,
snapshot/recovery e PWA instalada sob HTTPS em dispositivo.

Esforço DevOps planejado **2–4 horas humanas**, incluindo **1–2 horas
compartilhadas** de CI/testes; homologação de Oracle real, se aprovada
depois, **+1–3 h condicionais**, fora desta missão. Sem garantia de
infraestrutura gratuita fora de cotas Oracle Always Free e custos externos.

**Não afirmar conclusão da melhoria por testes de DevOps isolados.**
A autorização de merge em `V1`, `V1→main` e deploy/operar VM são
gates separados e não foram concedidos.
