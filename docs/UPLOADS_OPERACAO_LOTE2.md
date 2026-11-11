# Armazenamento de imagens externas — guia operacional do Lote 2

> Preparação de configuração, não implantação. Não utilizar credenciais ou dados reais nos testes de CI.
> O código Backend é responsável por implementar e validar `MURAL_UPLOAD_DIR`; este documento **não comprova** suporte no servidor até o PR correspondente ser integrado.

## Contrato e localização

- Imagens novas ficam **fora do checkout** do projeto, em pasta exclusiva, via variável de ambiente `MURAL_UPLOAD_DIR` de caminho absoluto.
- Em ambiente local sem variável, o contrato aprovado prevê `$HOME/Downloads/Mural Creche` (em Node, `path.join(os.homedir(), 'Downloads', 'Mural Creche')`); caminhos reais dependem do usuário do processo.
- Em futura VM Oracle, um exemplo de volume dedicado seria `/srv/mural-creche/uploads`. É um **exemplo**, não um diretório já provisionado.
- O backend salva URLs públicas relativas `/uploads/<nome_aleatorio_seguro>`, nunca caminhos de disco. A rota só permite nomes de arquivos gerados pelo sistema. Impedir traversal e acesso a arquivos arbitrários.
- O limite de upload (10 MB), a lista de MIME permitidos e os nomes aleatórios continuam a cargo do Backend. Não habilitar Cloudinary nem sincronização automática entre local e VM.

## Preparação local (Linux/macOS)

```sh
# Caminho EXTERNO ao repositório; sem sudo. Aspas preservam o espaço.
mkdir -p "$HOME/Downloads/Mural Creche"
chmod 700 "$HOME/Downloads/Mural Creche"

# Configuração apenas da sessão; substitua a senha antes de qualquer uso local.
export MURAL_UPLOAD_DIR="$HOME/Downloads/Mural Creche"
# Configure ADMIN_SECRET_KEY em arquivo .env local, NÃO versionado.
npm ci --no-audit --no-fund
npm start
```

Em Windows, selecione pasta absoluta equivalente no perfil do usuário e conceda escrita somente à conta que executa o processo. Verifique o valor real de `MURAL_UPLOAD_DIR` e as permissões, sem registrar senhas em saída pública.

## Preparação futura da VM (não executar neste Lote)

Sob autorização separada de deploy, o operador criará pasta/volume persistente **dedicado**, fora do checkout, e ajustará o proprietário para a conta não-root do serviço. Exemplo ilustrativo:

```sh
# EXEMPLO; os nomes e IDs de usuário devem ser confirmados na VM.
sudo install -d -o mural -g mural -m 0700 /srv/mural-creche/uploads
# Variável MURAL_UPLOAD_DIR=/srv/mural-creche/uploads no ambiente do processo.
```

O operador deve confirmar que o volume sobrevive a reinícios e atualizações e que a pasta **não** está em `/` como diretório indiferenciado. Não colocar senhas em arquivos públicos, PRs, workflows ou logs.

## Preservação de arquivos legados

Antes de alterar o armazenamento ou remover código legado:

1. **Inventariar** entradas `Publicacoes.imagem_url` e arquivos de `public/uploads` (se houver), em ambiente autorizado.
2. Criar **backup consistente** do SQLite e cópia dos arquivos de imagens existentes; manter cópia intocada.
3. Confirmar as URLs públicas atualmente usadas. Se existirem URLs legadas apontando para `/uploads/<nome>`, mapear os arquivos correspondentes e garantir que o novo servidor ainda os entregue — por migração não destrutiva ou fallback restrito, definido pelo Backend.
4. Nunca apagar imagens nem sobrescrever arquivos com mesmo nome sem verificação prévia; validar nomes permitidos e rejeitar paths com `..`, barras ou escapes.
5. Verificar GET das imagens antes e depois da atualização e confirmar que nomes arbitrários/arquivos fora da pasta não são legíveis.
6. Somente depois da conferência e autorização considerar descontinuar armazenamento legado. Não executar migração destrutiva na CI.

## Backup e restauração

**Backup:** preparar destino restrito, obter snapshot consistente com API SQLite de backup ou `sqlite3 banco.db ".backup '<destino>/banco.db'"` (ajustar conforme DB em uso) e copiar a pasta externa preservando nomes e estrutura. Tratar SQLite WAL/SHM com mecanismo consistente, em vez de copiar o `banco.db` enquanto o processo escreve. Conferir permissão `0700` no backup e que os artefatos **não** vão ao GitHub Actions, Git, storage público ou logs.

**Restauração:** interromper o processo em manutenção autorizada, guardar cópia pré-restauração, restaurar SQLite consistente e diretório de imagens no caminho configurado, reatribuir propriedade/permissões e reiniciar. Comparar quantidade de publicações e URLs de imagem, fazer GET das imagens autorizadas e testar rejeição de traversal.

O banco atual em `database.js` utiliza `path.resolve(__dirname, 'banco.db')`. Como a tarefa DevOps não autoriza modificá-lo, qualquer necessidade de persistência do banco fora do checkout deve ser encaminhada ao Backend antes da configuração final de deploy.

## Testes integrados e isolamento

O teste `tests/lote2-integration.e2e.cjs` prepara cópia temporária de `server.js`, `database.js`, `public/`, SQLite e pasta `MURAL_UPLOAD_DIR` igualmente temporária; não utiliza dados nem arquivos reais. Ele verifica rotas públicas, segurança de token, gerais, imagens, comportamento admin/checkbox, notificações e DOM seguro em Chromium real.

- Até que Backend e Frontend sejam compostos, a suíte do Lote 2 **não deve** ser contabilizada como aprovada nem ser executada automaticamente contra a `V1` anterior.
- O workflow `v1-integration-tests.yml` permite acionamento manual com a opção `run_lote2`; usar somente em ref com **ambas** as implementações integradas em checkout temporário ou após aceitação de cada PR. A suíte anterior permanece sempre ativa.
- Um workflow executado em branch individual **não prova** integração entre branches. Code Review/Orquestrador deve fornecer composição temporária, sem merge direto para experimentar.
- Se uma validação exigir contratos ou seletores diferentes, o ajuste deve ocorrer no dono do arquivo ou no teste E2E, após inspeção do diff; nunca enfraquecer assertivas apenas para obter verde.
