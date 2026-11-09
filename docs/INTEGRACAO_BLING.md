# Integração Moskit → Bling: guia de uso e manutenção

Sistema OS Marca Vento (https://os-marcavento.fly.dev). Substitui o Pluga.

Quando um negócio é marcado como **Ganho** no Moskit, o sistema:

1. cria o **pedido de venda no Bling**, na situação **Em aberto**, cadastrando o cliente se ele ainda não existir;
2. cria, ao mesmo tempo, a **O.S.** com o **mesmo número do pedido** (ex.: pedido nº 5301 → O.S. 5301/26);
3. se o Bling falhar, cria a O.S. com status **Aguardando Bling** e número provisório, e **envia um alerta por e-mail**;
4. registra tudo no **Histórico**.

Somente o negócio **Ganho** no Moskit (ou o envio manual pela tela 📦 Bling) gera pedido no Bling. **O.S. criada manualmente, "🔍 Importar por ID" e "Sincronizar Moskit" geram apenas O.S.**

Tudo é feito pela tela **📦 Bling**, no cabeçalho do sistema.

---

## 1. Visão geral do fluxo

```
Moskit (negócio Ganho)
   │  webhook "Integraçao Moski-Bling - Claude" (validado pelo token do Moskit)
   ▼
Sistema OS Marca Vento
   ├─ confere o negócio (cliente, SKUs, valores, duplicidade)
   │     ├─ tudo certo   → cria o pedido no Bling (Em aberto)
   │     │                   → cria a O.S. com o nº do pedido (status Ganhou)
   │     └─ Bling falhou → O.S. "Aguardando Bling" com nº provisório (último + 1)
   │                         → alerta por e-mail (motivo + todos os dados do Moskit)
   │                         → negócio fica na Fila com o motivo
   │                         → ao enviar depois, a O.S. recebe o nº do pedido
   └─ registra cada etapa no Histórico
   (só cria a O.S. se ainda não existir; nunca duplica nem sobrescreve)
```

Depois que o pedido existe, se o negócio for **alterado no Moskit**, o sistema compara os dados com o pedido e coloca a alteração como **pendente da sua autorização**. Ele nunca atualiza o Bling sozinho.

---

## 2. Tela 📦 Bling

### 2.1 Fila de pedidos
Mostra os negócios que precisam de atenção. Filtros disponíveis: Pendentes, Alteração pendente, Com erro, Enviados, Ignorados e Todos.

| Status | Significado | O que fazer |
|---|---|---|
| **Pendente** | Aguardando conferência manual (por exemplo, por suspeita de duplicidade) | **🔎 Conferir** e enviar, ou **Ignorar** |
| **Erro** | Envio impedido por uma pendência (SKU, CPF/CNPJ) ou por falha do Bling | Corrigir no Moskit/Bling e **🔎 Conferir** de novo |
| **Alteração pendente** | O negócio mudou no Moskit depois do envio | **📝 Revisar alteração** e autorizar ou descartar |
| **Enviado** | Pedido criado no Bling | **🔎 Conferir** para comparar ou sobrescrever |
| **Ignorado** | Você decidiu não enviar | **Reativar** se mudar de ideia |

No campo **Nº do negócio no Moskit**, você confere e envia qualquer negócio manualmente, inclusive os ganhos antes da data de corte.

O número vermelho no botão **📦 Bling** indica quantos itens estão pendentes, com erro ou com alteração pendente.

### 2.2 Conferência
Mostra cada campo como **ORIGEM (Moskit) → VALOR → DESTINO (Bling)**, os itens com SKU e valores, os erros que impedem o envio e os avisos.

- **Negócio ainda não enviado:** botão **✅ Confirmar envio ao Bling**. Se houver avisos, é preciso marcar "Li os avisos…" antes de enviar.
- **Negócio que já gerou pedido no Bling:**
  - no topo aparece a faixa verde **"Este negócio já gerou o pedido nº X no Bling"**, com o botão **♻️ Sobrescrever dados no Bling**;
  - no final ficam a tabela de diferenças (**Bling hoje × Moskit agora**) e o mesmo botão.

### 2.3 Sobrescrever dados no Bling
Atualiza o **pedido** e o **cadastro do cliente** no Bling, e também a **O.S.**, com os dados conferidos no Moskit.

- **Pedido:** cliente, data, data prevista, observações, itens, valores e parcela.
- **Cliente:** nome, nome fantasia, e-mail, telefone, Inscrição Estadual, endereço, número, complemento, bairro, CEP, município e UF.
- **O.S.:** cliente, contato, data de entrega, pagamento, frete, observações e **itens** são substituídos. Número, data da O.S., status, foto e template são mantidos.
- **Confirmação:** ao clicar, uma janela mostra as diferenças, e só é gravado depois do **OK**.
- **Números mantidos:** o número do pedido no Bling e o número da O.S. **não mudam**.
- **Campos vazios no Moskit não apagam** o que existe no Bling.
- **Só funciona com o pedido Em aberto.** Se ele já estiver em outra situação (atendido, faturado etc.), o sistema recusa e você ajusta direto no Bling.
- **Se o Bling recusar o cadastro do cliente,** o pedido também não é alterado.
- **Os dados anteriores e os novos ficam no Histórico.**

Autorizar uma **Alteração pendente** (item 2.4) também atualiza a O.S. da mesma forma.

### 2.4 Alteração pendente (detectada automaticamente)
Quando o Moskit avisa uma edição em um negócio já enviado, o sistema compara itens, total, cliente, datas e observações:

- **Se houver diferença,** o status passa a **Alteração pendente**. Em **📝 Revisar alteração**, você vê o "antes × depois" e escolhe:
  - **✅ Autorizar e atualizar no Bling**, que atualiza o mesmo pedido; ou
  - **Descartar**, que mantém o Bling como está. Essa mesma alteração não volta a aparecer.
- **Se o Moskit voltar aos valores originais,** a pendência some sozinha.
- **Se o negócio mudar de status no Moskit** depois do envio (por exemplo, para Perdido), isso fica registrado no Histórico. O pedido no Bling não é alterado.

### 2.5 Histórico
Registra cada evento com data e hora:
- envios (automáticos e manuais);
- falhas de comunicação com o Bling e novas tentativas;
- bloqueios (com o motivo);
- alterações, autorizações e descartes;
- criação e renumeração da O.S.;
- alertas por e-mail (enviados ou com falha).

Você pode filtrar pelo número do negócio. Em **Detalhes**, aparecem os **dados enviados ao Bling**, a **resposta do Bling** e a tabela de diferenças.

### 2.6 Mapeamento
Define de qual campo do Moskit (**ORIGEM**) vem cada campo do Bling (**DESTINO**). Use `||` para alternativas, e o campo "Valor fixo" é usado quando a origem estiver vazia. Na conferência, **"Ver campos disponíveis neste negócio do Moskit"** lista os campos com valor, o que ajuda a montar o mapeamento.

Mapeamento atual (os dados de endereço vêm de campos personalizados da empresa no Moskit):

| Destino (Bling) | Origem (Moskit) |
|---|---|
| Cliente: CPF/CNPJ | `company.cnpj \|\| contact.cpf` |
| Cliente: Nome / Razão Social | `company.legalName \|\| company.name \|\| contact.name` |
| Cliente: Nome fantasia | `company.customFields.CF_0WGqopUKCxrzAMnP \|\| company.name` |
| Cliente: E-mail | `contact.emails[0].address \|\| company.email` |
| Cliente: Telefone | `contact.phones[0].number \|\| company.phones[0].number \|\| company.phone` |
| Cliente: Inscrição Estadual | `company.customFields.CF_2wpDloUnCanjzmvL` |
| Cliente: Endereço | `company.customFields.CF_dVKmQlU1C6vlAMWR \|\| company.address` |
| Cliente: Número | `company.customFields.CF_Rg7MnpULCdaxjDvd` |
| Cliente: Complemento | `company.customFields.CF_6rRmw4UvCJbllD4X` |
| Cliente: Bairro | `company.customFields.CF_VRAqd4UdCa5L3qbL` |
| Cliente: CEP | `company.customFields.CF_Lo1qjxU1C4wgJmer` |
| Cliente: Município | `company.customFields.CF_2ojMxGUPCoWlaqOE \|\| company.city` |
| Cliente: UF | `company.state`. Se vazia, é **deduzida pelo CEP** |
| Pedido: Data | `deal.closeDate` (se vazia, a data de hoje) |
| Pedido: Data prevista | `customFields.data_entrega` |
| Pedido: Observações | (não mapeado; opcional) |
| Item: Código (SKU) | `dealProduct.product.sku` (precisa existir no Bling com o mesmo código) |
| Item: Quantidade | `dealProduct.quantity` |
| Item: Valor unitário | `dealProduct.price`, que o Moskit envia **em centavos** e o sistema converte |

Os campos de Inscrição Estadual e Nome fantasia foram identificados pelo formato dos valores. Se algum estiver trocado, ajuste nesta tela.

### 2.7 Configuração
- **Conexão com o Bling:** Client ID, Client Secret e o botão **Conectar ao Bling**. A renovação do acesso é automática. **🩺 Testar permissões** mostra o que o aplicativo do Bling pode consultar.
- **Como o pedido é criado:**
  - **situação inicial:** Em aberto;
  - **vencimento da parcela:** 1 dia após o pedido;
  - **forma de pagamento, vendedor, categoria e loja:** opcionais.
- **Enviar automaticamente ao Bling:** ligado. Desligado, os negócios Ganho só entram na fila para conferência manual.
- **Considerar só negócios ganhos a partir de:** **06/11/2026**. Negócios ganhos antes disso, que o Pluga já tratou, são ignorados pelo webhook mesmo se forem editados no Moskit. Ainda é possível enviá-los manualmente pelo número.
- **✉️ Alerta por e-mail:** avisa quando o Bling não cria o pedido de um negócio Ganho. Veja como configurar no item 4.
- **Segurança do webhook:**
  - **Token do Moskit:** o webhook só aceita avisos que trazem o token que o Moskit envia, copiado em *Moskit → Marketplace → Webhooks → Copiar token*. **Se você clicar em "Renovar token" no Moskit, cole o novo token aqui**, senão os avisos serão recusados.
  - **Proteção por token na URL:** também ativa. O Moskit não mantém o `?token=` na URL, por isso a validação principal é o token do Moskit.

---

## 3. Regras importantes

**Proteções contra pedido duplicado**
- Cada pedido leva `numeroLoja = MOSKIT-<nº do negócio>`. Antes de criar, o sistema verifica se esse pedido já existe no Bling.
- Uma trava impede dois envios simultâneos do mesmo negócio, por exemplo num clique duplo.
- Se o Bling responder com erro mas tiver gravado o pedido, o sistema reconhece e não cria outro.
- Se já existir um pedido para o mesmo cliente com o mesmo total nos últimos 10 dias, o envio automático para e o negócio fica **Pendente** para conferência.

**O.S.**
- A O.S. é criada **junto com o pedido** e **só na primeira vez**. Edições no Moskit **não mudam a O.S. sozinhas**: ela só é atualizada quando você usa **♻️ Sobrescrever** ou autoriza uma alteração pendente.
- Se o Bling falhar, a O.S. nasce **Aguardando Bling** com número provisório (maior número existente + 1). Quando o pedido for criado, ela recebe o número do pedido e passa para **Ganhou**. Use o filtro **Aguardando Bling** na lista de O.S. para encontrá-las.
- Enviar um negócio manualmente pela tela 📦 Bling também cria a O.S., caso ela ainda não exista.
- O botão **Sincronizar Moskit** cria O.S. em lote e **sobrescreve O.S. existentes**. Por isso ele exige marcar uma caixa e digitar **SINCRONIZAR**. Para trazer um negócio específico, prefira **🔍 Importar por ID**.

**Falhas de comunicação**
- Se o Bling estiver fora do ar ou recusar por limite de requisições, o sistema tenta de novo após **1 minuto** e após **5 minutos**. Se ainda falhar, o negócio fica com **Erro** na fila, o **alerta por e-mail** é enviado, e basta **Conferir** e enviar depois.
- Recusas definitivas (SKU inexistente, cliente sem CPF/CNPJ etc.) geram o alerta na hora. O mesmo motivo não gera e-mail repetido.

**Pedido criado**
- Situação **Em aberto**, com parcela única no valor total e vencimento conforme a configuração.
- Em **Observações internas**: "Criado via Automação Moskit-Bling em <data/hora> (negócio Moskit #<id>)". Em cada atualização é acrescentada a linha "Atualizado via Automação Moskit-Bling em <data/hora>".

**Avisos recebidos de outros sistemas:** avisos do Bling enviados ao endereço do webhook são ignorados, porque não são usados.

---

## 4. Configurações externas

**Moskit** (*Marketplace → Webhooks*, webhook "Integraçao Moski-Bling - Claude"):
- **URL:** `https://os-marcavento.fly.dev/api/webhook/moskit` (com ou sem `?token=`);
- **Ações:** incluir **Criação de negócio** e **Edição de negócio**. Avisos de contato e empresa são ignorados;
- **Integração:** ativada.

**E-mail de alerta** (*📦 Bling → Configuração → ✉️ Alerta por e-mail*), usando Gmail:
1. Na conta Google que vai enviar, ative a **verificação em duas etapas**.
2. Acesse https://myaccount.google.com/apppasswords, crie uma **senha de app** (nome: "OS Marca Vento") e copie os 16 caracteres.
3. No sistema, preencha: **Servidor** `smtp.gmail.com`, **Porta** `465`, **Usuário** = o e-mail do Gmail, **Senha** = a senha de app, **Destinatários** = quem recebe (separados por vírgula). Marque **Ativo** e clique em **Salvar**.
4. Clique em **Enviar e-mail de teste** e confira a caixa de entrada (e o spam).

O e-mail traz: o motivo do erro, o número provisório da O.S., os dados do negócio, do cliente, do pedido e dos itens, todos os campos recebidos do Moskit e um anexo JSON com os dados completos. A senha fica guardada no servidor e nunca volta para a tela.

**Bling** (*Central de Extensões → Área do Integrador*, aplicativo "Integracao Moskit"):
- **Link de redirecionamento:** `https://os-marcavento.fly.dev/api/bling/callback`;
- **Escopos:** Contatos (consultar, incluir, alterar), Produtos (consultar), Pedidos de Venda (consultar, incluir, alterar, alterar situação), Situações, Formas de Pagamento e Vendedores;
- **Depois de alterar escopos ou o aplicativo:** clicar em **Conectar ao Bling** de novo no sistema e rodar **🩺 Testar permissões**;
- **Webhooks do aplicativo:** não são necessários.

---

## 5. Solução de problemas

| Sintoma | Causa provável | Como resolver |
|---|---|---|
| Negócio Ganho não aparece no sistema | Webhook não chegou ou foi recusado | Ver o último aviso recebido em *Configuração* (ou me pedir). Token do Moskit renovado? Cole o novo |
| Fila com **Erro**: "SKU … não existe no Bling" | Produto sem o mesmo código nos dois sistemas | Cadastrar o SKU no Bling (ou corrigir no Moskit) e **Conferir** de novo |
| Fila com **Erro**: "sem CPF/CNPJ" | Empresa/contato do Moskit sem documento | Preencher no Moskit e **Conferir** de novo |
| **Pendente**: "POSSÍVEL DUPLICIDADE" | Já existe pedido parecido no Bling | Conferir no Bling. Se for outro pedido, enviar; se for o mesmo, **Ignorar** |
| Bling: "pendências cadastrais para NF-e" (número, bairro, CEP, UF) | Cliente cadastrado antes de 06/11/2026 sem endereço completo, ou dados faltando no Moskit | Completar no Moskit e usar **♻️ Sobrescrever dados no Bling** |
| O.S. com status **Aguardando Bling** | O pedido não foi criado no Bling (motivo no e-mail de alerta e na Fila) | Corrigir a causa e **🔎 Conferir** / enviar. A O.S. é renumerada sozinha |
| Alerta por e-mail não chega | E-mail não configurado, senha de app errada ou mensagem no spam | Ver o Histórico (evento "alerta e-mail") e usar **Enviar e-mail de teste** |
| "A conexão com o Bling expirou ou foi revogada" | Aplicativo alterado ou autorização revogada no Bling | **Conectar ao Bling** novamente |
| "insufficient_scope" | Aplicativo do Bling sem alguma permissão | Marcar o escopo no Bling, reconectar e usar **🩺 Testar permissões** |
| Sobrescrever recusado: "não está mais na situação inicial" | Pedido já atendido/faturado no Bling | Ajustar diretamente no Bling |

---

## 6. Parte técnica (manutenção)

**Hospedagem e publicação:** Node.js + Express + SQLite no Fly.io (região GRU), volume persistente `os_data`. Cada push na `main` publica automaticamente pelo GitHub Actions, que tira um **snapshot do volume** antes do deploy.

**Arquivos da integração:**
- `blingService.js`: OAuth, regras de envio, conferência, alterações e substituição, criação e atualização da O.S. junto com o pedido;
- `emailService.js`: envio do alerta por e-mail (SMTP próprio, sem bibliotecas externas);
- `blingRoutes.js`: rotas `/api/bling/*`;
- `blingDb.js`: tabelas `bling_*`;
- `public/js/bling.js` e `public/css/bling.css`: tela.

O webhook fica em `server.js` (`/api/webhook/moskit`), e a leitura do Moskit em `moskitService.js`.

**Tabelas** (todas novas; as tabelas das O.S. não mudaram de estrutura):

| Tabela | Conteúdo |
|---|---|
| `bling_config` | Configurações, credenciais e tokens. Não aparecem em `/api/settings` |
| `bling_field_mappings` | Mapeamento ORIGEM → DESTINO |
| `bling_orders` | Situação de cada negócio na integração |
| `bling_historico` | Histórico de importações |
| `bling_log` | Log técnico |

**Formato do aviso do Moskit:** `{ metadata, before, after }`. O negócio vem em `after`, e o token dentro de `metadata`.

**Regras de chamada ao Bling:**
- O Moskit envia valores **em centavos**.
- A criação do pedido é feita **sem** a situação no corpo, porque o Bling grava em "Em aberto" e recusaria "mesma situação". Se a situação configurada for outra, ela é aplicada depois.
- Na atualização (PUT), o número do pedido é mantido.
- Limite de 3 requisições por segundo, respeitado pelo sistema.

**Diagnóstico:** `GET /api/bling/status` mostra:
- `webhook.chegadas`: as últimas chamadas, com horário, resposta e resultado, sem dados de clientes;
- `webhook.formatos`: a estrutura dos avisos;
- `webhook.ultimo`: o último aviso processado.

**Como desfazer uma versão:** reverter o merge no GitHub. A versão anterior volta sozinha, as tabelas `bling_*` são ignoradas por versões antigas e os dados das O.S. não são afetados.
