# Integração Moskit → Bling (substitui o Pluga)

Cria pedidos de venda no Bling, na situação **Em aberto**, a partir de negócios **Ganhou** do Moskit.
Nada é enviado ao Bling sem conferência e confirmação na tela.

## Como funciona

1. **Entrada na fila.** Quando um negócio vai para "Ganhou", o webhook que já existe cria a O.S. (igual a hoje) e coloca o negócio na fila do Bling. Também dá para digitar o número do negócio manualmente.
2. **Conferência.** O botão **📦 Bling** abre a fila. Em **Conferir**, o sistema lê o negócio no Moskit e consulta o Bling **somente em leitura**. A tela mostra cada campo em três colunas: **ORIGEM (Moskit) → VALOR → DESTINO (Bling)**.
3. **Envio.** Só acontece pelo botão **Confirmar envio ao Bling**. Se o cliente não existir no Bling, ele é cadastrado. Em seguida o pedido é criado com `numeroLoja = MOSKIT-<nº do negócio>`.

### Travas de segurança

| Situação | O que acontece |
|---|---|
| SKU do Moskit não existe no Bling | Envio bloqueado |
| Negócio sem CPF/CNPJ | Envio bloqueado |
| Negócio já enviado (`MOSKIT-<id>` já existe no Bling) | Envio bloqueado |
| Pedido do mesmo cliente com o mesmo total nos últimos 10 dias (ex.: criado pelo Pluga) | Aviso; exige confirmação |
| Cliente novo, item inativo ou valor zerado, soma dos itens ≠ valor do negócio | Aviso; exige confirmação |
| Dois cliques ou duas pessoas enviando ao mesmo tempo | Só um envio é aceito (trava no banco) |
| Conexão cai depois que o Bling criou o pedido | O sistema confere pelo `numeroLoja` e registra, sem duplicar |
| Servidor reinicia no meio de um envio | O registro volta para "erro"; o reenvio confere o Bling antes de criar |
| Token do Bling expira (a cada 6 h) | Renovado automaticamente na próxima chamada |

## O que mudou no código

**Arquivos novos**
- `blingDb.js`
- `blingService.js`
- `blingRoutes.js`
- `public/js/bling.js`
- `public/css/bling.css`
- este documento

**Arquivos existentes, só com acréscimos**
- `server.js`
  - monta as rotas `/api/bling/*`;
  - valida o token do webhook (**só se você ativar**);
  - coloca o negócio na fila, num bloco isolado que nunca impede a criação da O.S.
- `moskitService.js`: exporta a função `resolvePath`, que já existia.
- `public/index.html`: botão **📦 Bling**, a janela da integração e os links para o CSS e o JS novos.

**Banco de dados**

Foram criadas 4 tabelas novas: `bling_config`, `bling_field_mappings`, `bling_orders` e `bling_log`. **Nenhuma tabela existente é alterada.**

As credenciais e os tokens do Bling ficam em `bling_config`. Eles **não** aparecem em `GET /api/settings`.

**Testes realizados** (em cópia do banco, com Moskit e Bling simulados)
- As 6 tabelas existentes ficaram idênticas, conferidas por hash, depois que a versão nova abriu o banco.
- 55 testes de ponta a ponta passaram, cobrindo as funções antigas, o webhook, o OAuth, a conferência, o envio, a concorrência, a queda de rede, o token expirado e a proteção do webhook.
- **Rollback:** a versão anterior abre normalmente o banco já migrado, porque simplesmente ignora as tabelas novas.

## Implantação, passo a passo

1. **Revise e aprove o Pull Request.** Ao fazer o merge na `main`, o GitHub Actions publica no Fly.io e tira um snapshot do volume de dados antes do deploy (isso já existia no workflow).
2. **Crie o aplicativo no Bling** em *Central de Extensões → Área do Integrador → Criar aplicativo* (tipo privado/uso próprio):
   - **Link de redirecionamento:** `https://os-marcavento.fly.dev/api/bling/callback`. É o valor exibido em **📦 Bling → Configuração**; use exatamente o que aparecer ali.
   - **Escopos:** Contatos, Produtos, Pedidos de Venda, Situações, Formas de Pagamento e Vendedores. Situações, Formas de Pagamento e Vendedores são usados só para preencher as listas da configuração.
3. **Informe as credenciais** do aplicativo de uma destas formas:
   - pela tela **📦 Bling → Configuração** (Client ID e Client Secret); ou, de forma mais segura,
   - pelos segredos do Fly: `fly secrets set BLING_CLIENT_ID=... BLING_CLIENT_SECRET=... -a os-marcavento`.
4. Clique em **Conectar ao Bling** e autorize o acesso.
5. Em **Configuração**, clique em **Carregar listas do Bling**, confira a situação (**Em aberto**), o prazo da parcela (padrão de 30 dias, igual ao Pluga) e a forma de pagamento. Depois clique em **Salvar**.
6. **Teste com um negócio real** que ainda não esteja no Bling. Confira e envie. Depois abra o pedido no Bling e compare com um pedido criado pelo Pluga.
7. **Desative o Pluga** só depois de validar. Enquanto os dois estiverem ativos, o sistema avisa sobre possíveis duplicidades, mas a decisão de enviar é sua.
8. **Opcional e recomendado:** em **Configuração → Segurança do Webhook**, clique em **Ativar proteção** e **troque imediatamente** a URL do webhook no Moskit pela nova URL exibida, que contém o token.

## Mapeamento padrão (editável em 📦 Bling → Mapeamento)

| DESTINO (Bling) | ORIGEM (Moskit) |
|---|---|
| Cliente: CPF/CNPJ | `company.cnpj \|\| contact.cpf` |
| Cliente: Nome / Razão Social | `company.legalName \|\| company.name \|\| contact.name` |
| Cliente: Fantasia / E-mail / Telefone / Endereço / Município / UF | `company.*` e `contact.*` (usados só ao cadastrar um cliente novo) |
| Pedido: Data | `deal.closeDate` (se vazio, usa a data de hoje) |
| Pedido: Data prevista | `customFields.data_entrega` |
| Item: Código | `dealProduct.product.sku` (precisa existir no Bling com o mesmo código) |
| Item: Quantidade | `dealProduct.quantity` |
| Item: Valor unitário | `dealProduct.price` |
| Situação | Configuração (padrão 6 = Em aberto) |
| Parcela | Total do pedido, com vencimento em data + N dias (configuração) |
| Nº na loja | `MOSKIT-<id do negócio>` (controle de duplicidade) |

## Como desfazer

Reverta o merge no GitHub. O deploy automático volta à versão anterior.

As tabelas `bling_*` permanecem no banco, mas são ignoradas, e nenhum dado das O.S. é afetado. Se você tiver ativado a proteção do webhook, volte a URL do webhook no Moskit para a URL sem token.
