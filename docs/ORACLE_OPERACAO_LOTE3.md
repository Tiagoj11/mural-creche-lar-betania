# Operação planejada — Oracle Cloud Always Free / Mural Creche (Lote 3)

**Estado: preparação offline; NENHUMA VM, domínio, DNS, HTTPS, banco real ou deploy foram acessados.** Este guia acompanha `deploy/systemd/mural-creche.service`, `deploy/caddy/Caddyfile.example`, `scripts/ops/{preflight,mural_data}.py` e `.env.example`. Não é autorização de publicação ou de provisionamento pago.

## 1. Pré-requisitos e limites externos

- Confirmar autorização específica do responsável, região *home* da tenancy e marca **Always Free-eligible** para todos os recursos antes de provisionar. A documentação atual da Oracle descreve `VM.Standard.A1.Flex` (Arm) com franquia de **1.500 horas de OCPU e 9.000 GB-horas/mês**, equivalente a até **2 OCPU/12 GB RAM** nas condições Always Free descritas, e **200 GB de volume de inicialização + bloco combinados**. A capacidade depende da região/tenancy; não presumir existência ou disponibilidade. Ultrapassar limites e criar recursos fora da região home pode gerar custos.
- Referência oficial: https://docs.oracle.com/pt-br/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm (revalidar limites na console da tenancy antes de qualquer ação).
- Requerem confirmação **ainda pendente**: conta/tenancy autorizada, quota, forma e arquitetura `aarch64`, VM Linux/versão e usuário SSH, VCN/subnet e NSG, IP público, domínio aprovado/DNS, firewall UFW/iptables, política de backup e volume durável, identidade do usuário `mural`, proprietário dos arquivos legados, localização do banco, chave/QR PIX oficiais (DEC-003), e aprovação de produção. **Não fornecer senhas ou chaves em chat/PR.**
- Em ARM, executar Node.js 22 compatível e `npm ci` dentro do host aprovado; o módulo SQLite nativo deve compilar/carregar para ARM. O checkout de origem é `V1` após Code Review e autorização; `main` não é linha de deploy nesta etapa.

## 2. Layout proposto — somente sob autorização futura

```text
/opt/mural-creche/releases/<SHA>/    # código somente-leitura
/opt/mural-creche/current -> releases/<SHA>   # link da revisão ativa
/srv/mural-creche/state/banco.db      # SQLite persistente fora do checkout
/srv/mural-creche/uploads/           # imagens persistentes fora do checkout
/srv/mural-creche/backups/           # cópias privadas, fora do webroot
/etc/mural-creche/mural.env          # segredo de produção fora do Git
/etc/systemd/system/mural-creche.service
/etc/caddy/Caddyfile
```

Criar diretórios sob propriedade de `mural:mural` com modo `0700` para state/uploads/backups e SQLite com `0600`; `/etc/mural-creche/mural.env` propriedade `root:mural` com `0640` ou root `0600` conforme permissão de leitura pelo systemd. A pasta de upload permanece externa mesmo após troca da revisão `current`; não usar `/`, `public/uploads` para uploads novos nem pastas do release. **Não copiar secrets, DB nem uploads para GitHub Actions.**

> **GATE:** em `V1` atual, `database.js` ainda usa `path.resolve(__dirname, 'banco.db')`. O Backend do Lote 3 deve implementar `MURAL_DB_PATH` absoluto sem criar banco vazio em caminho errado. Não iniciar o serviço acima com arquivos reais até Code Review e teste conjunto da nova interface. `server.js` já suporta `MURAL_UPLOAD_DIR` externo, mas a checagem lexical de saída do checkout não substitui `realpath`/bloqueio de symlinks; correção pertence ao Backend.

## 3. Operação futura com autorização (comandos-modelo, NÃO executados)

1. Provisionamento controlado: confirmar quota Always Free, arquitetura da imagem, espaço em volume persistente, rede e disponibilidade; negar tráfego público exceto `80/tcp`, `443/tcp` e SSH `22/tcp` **restrito à origem administrativa autorizada**. Não permitir `3000/tcp` na NSG nem no firewall host. O Express atual pode escutar em interfaces públicas; mesmo atrás do proxy, o bloqueio de `3000/tcp` é obrigatório. Qualquer ajuste de bind local em `server.js` deve ser requisitado ao Backend.
2. Criar `mural` como conta de sistema sem login interativo e pastas acima; **não** executar Node como root. O operador instala Node.js 22 ARM e Caddy do repositório oficial, confere versões, e monta um release novo sem dados. Não usar `npm install` destravado: `npm ci --omit=dev --no-audit --no-fund` no release (lockfile inspecionado).
3. Configurar `/etc/mural-creche/mural.env` (fora do Git, acesso restrito) com `ADMIN_SECRET_KEY` nova e forte, `MURAL_DB_PATH=/srv/mural-creche/state/banco.db`, `MURAL_UPLOAD_DIR=/srv/mural-creche/uploads`, `PORT=3000`. Nunca reutilizar segredo dos testes nem imprimir variável em log. Não abrir `/admin.html` a terceiros até revisar política de acesso ao painel.
4. Quando a nova lógica Backend suportar caminhos externos e o banco tiver sido preparado/verificado, executar **como usuário `mural`**:
   ```sh
   python3 /opt/mural-creche/current/scripts/ops/preflight.py \
     --checkout /opt/mural-creche/current \
     --db /srv/mural-creche/state/banco.db \
     --uploads /srv/mural-creche/uploads
   ```
   Para base de instalação **nova e aprovada**, existe `--allow-new-db`; **nunca** usá-lo se houver banco legado ou incerteza sobre dados existentes.
5. Validar unit antes de ativação: `systemd-analyze verify /etc/systemd/system/mural-creche.service`; instalar unit a partir do modelo, conferir caminhos, depois `systemctl daemon-reload`, `systemctl enable --now mural-creche` somente na janela autorizada. `systemctl status mural-creche`, `journalctl -u mural-creche -n 50 --no-pager` (sem copiar logs com tokens para serviços externos). Reboot/persistência são testes futuros, não realizados nesta entrega.
6. Copiar `Caddyfile.example` para `/etc/caddy/Caddyfile` substituindo `mural.example.invalid` pelo domínio real com DNS aprovado; `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`. Abrir portas 80/443 em NSG e firewall host, confirmar domínio e tráfego antes de iniciar. Caddy obtém/renova TLS automático quando domínio e portas são válidos. Documentação: https://caddyserver.com/docs/quick-starts/https e https://caddyserver.com/docs/caddyfile/directives/reverse_proxy . **Não criar DNS/certificados públicos nesta missão.**
7. Smoke test autorizado depois de ativação: GET `/` sem token exibe Apoie sem PIX fictício, GET `/?token=<ficticio>` em banco descartável testa mural; sem senha admin GET `/api/turmas` e `/api/admin/publicacoes` → `401`; conteúdo geral e da turma por token correto; `/uploads/<nome>` de arquivo publicado retorna imagem; traversal não deve expor arquivos; verificar service worker/PWA só com HTTPS real e dispositivo quando Frontend entregar. Registrar capturas sem tokens ou dados pessoais.

**Atualização com rollback:** parar a aplicação antes de alterar dados, fazer snapshot consistente conforme seção 4, disponibilizar `releases/<novo_SHA>` sem tocar `state/` ou `uploads/`, conferir dependências e preflight, trocar symlink `current` de forma atômica e reiniciar `systemctl`. Verificar saúde, rotas e persistência; em falha, parar serviço, apontar `current` ao release anterior e reiniciar. **Rollback de código não reverte alterações de schema;** qualquer alteração incompatível do banco requer plano de restauração validado em manutenção, nunca exclusão automática de DB/imagens. Exemplo: `ln -sfn <novo_release> /opt/mural-creche/current.next && mv -Tf /opt/mural-creche/current.next /opt/mural-creche/current` apenas depois de conferir o diretório real de releases e permissões. Não rodar comandos-modelo fora de ambiente autorizado.

## 4. Backup consistente e restauração (script testado em sandbox, nunca em dados reais)

O utilitário `scripts/ops/mural_data.py` usa a API de backup SQLite da biblioteca padrão Python para snapshot consistente do banco e cópia verificada por SHA-256 das imagens **flat** em `MURAL_UPLOAD_DIR`. Exige `--quiesced`: **interrompa o serviço ou garanta janela sem qualquer alteração de banco/imagens** (incluindo outras instâncias e uploads) antes de obter cópia de ambos; SQLite backup isolado não é atomicamente consistente com o filesystem enquanto há gravações. É ferramenta de operação manual, sem publicação de arquivos de backup.

Exemplo com diretórios externos reais **somente após autorização**:

```sh
# Exemplo; servidor fora do ar, sob usuário autorizado que leia DB e imagens:
python3 scripts/ops/mural_data.py backup \
  --db /srv/mural-creche/state/banco.db \
  --uploads /srv/mural-creche/uploads \
  --output /srv/mural-creche/backups/snapshot-AAAA-MM-DD-001 \
  --quiesced
python3 scripts/ops/mural_data.py verify \
  --snapshot /srv/mural-creche/backups/snapshot-AAAA-MM-DD-001

# RESTORE É SEMPRE dry-run por padrão; só restaura em caminhos ainda inexistentes:
python3 scripts/ops/mural_data.py restore \
  --snapshot /srv/mural-creche/backups/snapshot-AAAA-MM-DD-001 \
  --db /srv/mural-creche/state/restore-teste.db \
  --uploads /srv/mural-creche/uploads-restore-teste

# Somente após manutenção autorizada / serviço parado / conferência do plano:
python3 scripts/ops/mural_data.py restore \
  --snapshot /srv/mural-creche/backups/snapshot-AAAA-MM-DD-001 \
  --db /srv/mural-creche/state/restore-teste.db \
  --uploads /srv/mural-creche/uploads-restore-teste \
  --quiesced --apply
```

- `verify` checa `PRAGMA integrity_check`, hashes SHA-256 e nomes/quantidade de imagens; `restore` não sobrescreve DB nem uploads existentes. O destino novo só é promovido ao serviço alterando `MURAL_DB_PATH`/`MURAL_UPLOAD_DIR` mediante autorização e manutenção; não alterar automaticamente variáveis em produção. Recomendação: cópia adicional **off-host** criptografada e com retenção definida pelo responsável; não presumir que o volume local protege de perda da VM.
- Verificar chaves/tokens/IDs no SQLite restaurado **sem imprimir dados reais**; preferir `SELECT COUNT(*)` e comparação de hashes. Não inserir snapshot em logs, artefatos CI ou repo; backups contêm tokens da turma e merecem o mesmo controle de acesso que dados reais.

### Migração/compatibilidade legada não destrutiva

1. Em ambiente autorizado e parado, inventariar SQLite em `./banco.db`, registros `Publicacoes.imagem_url`, uploads externos existentes e `public/uploads`. Conferir nomes/URLs e `SELECT COUNT(*)`, sem expor tokens; se houver arquivos legados não compatíveis com nomes seguros ou pastas aninhadas, interromper e tratar caso a caso com o Backend.
2. **Não migrar implicitamente**: efetuar `backup --quiesced` do banco legado **e da pasta de imagens existente** em caminho seguro; se a pasta de uploads do sistema legado for `public/uploads`, fornecê-la como `--uploads`, somente para leitura (backup). Verificar manifest e manter origem intacta.
3. Para migração do DB antigo a caminho externo, usar `restore --quiesced --apply` exclusivamente para um **novo arquivo** externo ausente, sem sobrescrever banco existente. Para preservar arquivos externos já existentes, migre imagens legadas separadamente para `MURAL_UPLOAD_DIR`:
   ```sh
   python3 scripts/ops/mural_data.py migrate-images \
     --source /opt/mural-creche/current/public/uploads \
     --target /srv/mural-creche/uploads
   # Sem --apply é somente dry-run e confere colisões de conteúdo.
   # Após inventário/backup e autorização, repetir com --apply.
   ```
4. `migrate-images` só copia arquivos flat regulares, rejeita symlinks e conflitos com mesmo nome e hash diferente, nunca apaga as fontes. Se uma imagem legada vinculada à publicação faltar, bloquear aceite e encaminhar ao Backend. A URL pública `/uploads/<nome>` pode continuar via arquivo migrado e rota protegida, mas a compatibilidade deve ser testada em HTTP com backend resultante.
5. Não eliminar fallback nem arquivos `public/uploads` originais antes de conferir inventário, URLs no banco, HTTP, checksums, backup/restauração, Code Review e decisão explícita. Não regenerar códigos de turma, não sobrescrever `banco.db` e não criar turma fictícia Geral.

## 5. Riscos e critérios de aceite do Lote 3

- **P0 antes de produção:** confirmar `MURAL_DB_PATH` implementado e `preflight` passando com permissões não-root; verificar proteção de symlinks/caminhos de upload real no Backend; garantir porta 3000 não exposta; escolher região/shape/volume sem cobrança; domínio DNS + HTTPS válidos; capacidade de backup/restauração e rollback; aprovar dados PIX oficiais apenas quando recebidos.
- **Validado nesta branch (local descartável):** testes de `mural_data.py` (backup, verify, restore e migração de imagens) e `preflight.py`, sem dados de famílias; `npm test` no GitHub Actions também executa testes `tests/infra-ops.test.js` sem alterar workflow.
- **Não validado nesta branch:** Oracle real, reboot real, domínio e TLS válido, instalação PWA HTTPS, upload físico em VM, dados de CEI ou disponibilidade pública. Essas verificações dependem de autorização e recursos externos.
- **Para Code Review/Orquestrador:** avaliar contrato do Backend Lote 3 e PWA do Frontend, observar que diretório externo usa permissões `0700` e banco `0600`, verificar a composição dos três PRs em checkout temporário com baseline 44/44 e testes novos; não fazer merge ou deploy automaticamente.
