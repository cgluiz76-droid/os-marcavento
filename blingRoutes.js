// blingRoutes.js - Rotas HTTP da integração Moskit -> Bling
// Todas as rotas ficam sob /api/bling/* e não alteram as rotas existentes da O.S.

const express = require('express');
const crypto = require('crypto');
const moskitService = require('./moskitService');
const blingDb = require('./blingDb');
const blingService = require('./blingService');
const emailService = require('./emailService');

const router = express.Router();

// Envios interrompidos por reinício do servidor voltam para "erro" (seguro reenviar:
// o envio confere no Bling antes de criar qualquer pedido).
blingDb.releaseStaleLocks();

function publicBaseUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sendError(res, err, status = 500) {
  res.status(status).json({ success: false, error: err.message || String(err) });
}

// ---------- Status, credenciais e conexão OAuth ----------

router.get('/api/bling/status', (req, res) => {
  try {
    const base = publicBaseUrl(req);
    const token = blingDb.getConfig('moskit_webhook_token', '');
    res.json({
      success: true,
      auth: blingService.getAuthStatus(),
      config: blingDb.getPublicConfig(),
      callbackUrl: `${base}/api/bling/callback`,
      webhook: {
        ultimo: (() => { try { return JSON.parse(blingDb.getConfig('ultimo_webhook', '') || 'null'); } catch (e) { return null; } })(),
        chegadas: (() => { try { return JSON.parse(blingDb.getConfig('webhook_chegadas', '[]')); } catch (e) { return []; } })(),
        formatos: (() => { try { return JSON.parse(blingDb.getConfig('webhook_formatos', '[]')); } catch (e) { return []; } })(),
        protegido: Boolean(token),
        tokenMoskitConfigurado: Boolean(blingDb.getConfig('moskit_token_origem', '')),
        url: token ? `${base}/api/webhook/moskit?token=${token}` : `${base}/api/webhook/moskit`
      },
      email: {
        senhaConfigurada: Boolean(blingDb.getConfig('smtp_senha', ''))
      }
    });
  } catch (err) { sendError(res, err); }
});

router.post('/api/bling/credenciais', (req, res) => {
  try {
    if (process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET) {
      return sendError(res, new Error('As credenciais estão definidas nas variáveis de ambiente do servidor e não podem ser alteradas pela tela.'), 400);
    }
    const clientId = String((req.body && req.body.clientId) || '').trim();
    const clientSecret = String((req.body && req.body.clientSecret) || '').trim();
    if (!clientId) return sendError(res, new Error('Informe o Client ID.'), 400);
    blingDb.setConfig('client_id', clientId);
    // Secret em branco = manter o atual (a tela nunca recebe o secret de volta)
    if (clientSecret) blingDb.setConfig('client_secret', clientSecret);
    res.json({ success: true, auth: blingService.getAuthStatus() });
  } catch (err) { sendError(res, err); }
});

// Abre a tela de autorização do Bling (navegação do navegador, não fetch)
router.get('/api/bling/conectar', (req, res) => {
  try {
    res.redirect(blingService.startAuthorization());
  } catch (err) {
    res.status(400).send(`<p style="font-family:sans-serif">${escapeHtml(err.message)}</p><p><a href="/">Voltar</a></p>`);
  }
});

router.get('/api/bling/callback', async (req, res) => {
  try {
    await blingService.handleCallback(req.query.code, req.query.state);
    res.redirect('/?bling=conectado');
  } catch (err) {
    res.status(400).send(`<div style="font-family:sans-serif;max-width:560px;margin:40px auto">
      <h2>Não foi possível conectar ao Bling</h2><p>${escapeHtml(err.message)}</p>
      <p><a href="/">Voltar ao sistema</a></p></div>`);
  }
});

// ---------- Configurações do pedido ----------

const CONFIG_KEYS = ['situacao_id', 'prazo_dias', 'forma_pagamento_id', 'categoria_id', 'vendedor_id', 'loja_id', 'auto_enfileirar', 'envio_automatico', 'envio_automatico_desde'];

router.post('/api/bling/config', (req, res) => {
  try {
    const body = req.body || {};
    for (const k of CONFIG_KEYS) {
      if (body[k] === undefined) continue;
      let v = String(body[k]).trim();
      if (k === 'auto_enfileirar' || k === 'envio_automatico') v = v === 'false' ? 'false' : 'true';
      else if (k === 'envio_automatico_desde') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return sendError(res, new Error('Data de corte inválida.'), 400);
      }
      else if (v !== '' && !/^\d+$/.test(v)) return sendError(res, new Error(`Valor inválido para ${k}: use apenas números.`), 400);
      if (k === 'situacao_id' && !v) v = '6';
      if (k === 'prazo_dias' && !v) v = '30';
      blingDb.setConfig(k, v);
    }
    res.json({ success: true, config: blingDb.getPublicConfig() });
  } catch (err) { sendError(res, err); }
});

// Listas do Bling para facilitar a configuração (cada uma é opcional)
router.get('/api/bling/opcoes', async (req, res) => {
  const out = { situacoes: [], formasPagamento: [], vendedores: [], erros: [] };
  const tasks = [
    ['situacoes', blingService.listSituacoesVendas],
    ['formasPagamento', blingService.listFormasPagamento],
    ['vendedores', blingService.listVendedores]
  ];
  for (const [key, fn] of tasks) {
    try { out[key] = await fn(); } catch (e) { out.erros.push(`${key}: ${e.message}`); }
  }
  res.json({ success: true, ...out });
});

// Diagnóstico de permissões (somente leitura no Bling)
router.get('/api/bling/diagnostico', async (req, res) => {
  try {
    res.json({ success: true, permissoes: await blingService.diagnosticarPermissoes() });
  } catch (err) { sendError(res, err); }
});

// ---------- Alertas por e-mail ----------
router.post('/api/bling/email-config', (req, res) => {
  try {
    const b = req.body || {};
    if (b.ativo !== undefined) blingDb.setConfig('alerta_email_ativo', b.ativo === true || b.ativo === 'true' ? 'true' : 'false');
    if (b.host !== undefined) blingDb.setConfig('smtp_host', String(b.host).trim());
    if (b.porta !== undefined) {
      const porta = String(b.porta).trim();
      if (porta && !/^\d{2,5}$/.test(porta)) return sendError(res, new Error('Porta inválida.'), 400);
      blingDb.setConfig('smtp_porta', porta || '465');
    }
    if (b.usuario !== undefined) blingDb.setConfig('smtp_usuario', String(b.usuario).trim());
    if (b.senha) blingDb.setConfig('smtp_senha', String(b.senha).replace(/\s+/g, '')); // em branco = manter
    if (b.remetente !== undefined) blingDb.setConfig('email_remetente', String(b.remetente).trim());
    if (b.destinatarios !== undefined) blingDb.setConfig('email_destinatarios', String(b.destinatarios).trim());
    res.json({ success: true, config: blingDb.getPublicConfig(), senhaConfigurada: Boolean(blingDb.getConfig('smtp_senha', '')) });
  } catch (err) { sendError(res, err); }
});

router.post('/api/bling/email-teste', async (req, res) => {
  try {
    const r = await emailService.enviarTeste();
    res.status(r.ok ? 200 : 400).json({ success: r.ok, ...r });
  } catch (err) { sendError(res, err, 400); }
});

// ---------- Histórico de importações ----------
router.get('/api/bling/historico', (req, res) => {
  try {
    const deal = String(req.query.negocio || '').replace(/\D/g, '');
    res.json({ success: true, historico: blingDb.listHistory({ dealId: deal || null, limite: req.query.limite }) });
  } catch (err) { sendError(res, err); }
});

router.get('/api/bling/historico/:id', (req, res) => {
  try {
    const item = blingDb.getHistoryEntry(req.params.id);
    if (!item) return sendError(res, new Error('Registro não encontrado.'), 404);
    res.json({ success: true, item });
  } catch (err) { sendError(res, err); }
});

// ---------- Alterações no Moskit depois do envio ----------
router.get('/api/bling/alteracao/:dealId', (req, res) => {
  try {
    const info = blingService.getPendingChange(req.params.dealId);
    if (!info) return sendError(res, new Error('Negócio não encontrado na fila.'), 404);
    res.json({ success: true, ...info });
  } catch (err) { sendError(res, err); }
});

router.post('/api/bling/alteracao/:dealId/autorizar', async (req, res) => {
  try {
    const r = await blingService.applyPendingChange(req.params.dealId);
    res.status(r.ok ? 200 : 409).json({ success: r.ok, ...r });
  } catch (err) { sendError(res, err); }
});

router.post('/api/bling/alteracao/:dealId/descartar', (req, res) => {
  try {
    const r = blingService.discardPendingChange(req.params.dealId);
    res.status(r.ok ? 200 : 409).json({ success: r.ok, ...r });
  } catch (err) { sendError(res, err); }
});

// Conferência de negócio que já gerou pedido: diferenças em relação ao pedido no Bling
router.get('/api/bling/substituir/:dealId', async (req, res) => {
  try { res.json({ success: true, ...(await blingService.prepareReplace(req.params.dealId)) }); }
  catch (err) { sendError(res, err); }
});

// Confirmação do usuário: substitui os dados do pedido no Bling pelos dados conferidos agora
router.post('/api/bling/substituir/:dealId', async (req, res) => {
  try {
    if (!req.body || req.body.confirmado !== true) return sendError(res, new Error('Confirme a substituição na tela de conferência.'), 400);
    const r = await blingService.replaceOrder(req.params.dealId);
    res.status(r.ok ? 200 : 409).json({ success: r.ok, ...r });
  } catch (err) { sendError(res, err); }
});

// Verifica manualmente se o negócio mudou no Moskit depois do envio
router.post('/api/bling/alteracao/:dealId/verificar', async (req, res) => {
  try {
    const r = await blingService.detectChange(Number(req.params.dealId), 'manual');
    res.json({ success: true, ...r });
  } catch (err) { sendError(res, err); }
});

// ---------- Segurança do webhook do Moskit ----------

// Token que o Moskit envia em cada aviso (copiado da tela de Webhooks do Moskit)
router.post('/api/bling/moskit-token', (req, res) => {
  try {
    const token = String((req.body && req.body.token) || '').trim();
    if (token && !/^[A-Za-z0-9._-]{8,200}$/.test(token)) return sendError(res, new Error('Token inválido.'), 400);
    blingDb.setConfig('moskit_token_origem', token);
    res.json({ success: true, configurado: Boolean(token) });
  } catch (err) { sendError(res, err); }
});

router.post('/api/bling/webhook-token', (req, res) => {
  try {
    const acao = req.body && req.body.acao;
    if (acao === 'gerar') {
      blingDb.setConfig('moskit_webhook_token', crypto.randomBytes(24).toString('hex'));
    } else if (acao === 'remover') {
      blingDb.setConfig('moskit_webhook_token', '');
    } else {
      return sendError(res, new Error('Ação inválida.'), 400);
    }
    const token = blingDb.getConfig('moskit_webhook_token', '');
    const base = publicBaseUrl(req);
    res.json({
      success: true,
      protegido: Boolean(token),
      url: token ? `${base}/api/webhook/moskit?token=${token}` : `${base}/api/webhook/moskit`
    });
  } catch (err) { sendError(res, err); }
});

// ---------- Mapeamento ORIGEM -> DESTINO ----------

router.get('/api/bling/mapeamentos', (req, res) => {
  try { res.json({ success: true, mappings: blingDb.getMappings() }); } catch (err) { sendError(res, err); }
});

router.post('/api/bling/mapeamentos', (req, res) => {
  try {
    const list = (req.body && req.body.mappings) || [];
    res.json({ success: true, mappings: blingDb.saveMappings(list) });
  } catch (err) { sendError(res, err); }
});

// ---------- Fila, conferência e envio ----------

router.get('/api/bling/fila', (req, res) => {
  try { res.json({ success: true, pedidos: blingDb.listOrders(req.query.status || '') }); } catch (err) { sendError(res, err); }
});

// Coloca um negócio na fila pelo número (sem enviar nada ao Bling)
router.post('/api/bling/fila/:dealId', async (req, res) => {
  try {
    const id = Number(req.params.dealId);
    if (!Number.isInteger(id) || id <= 0) return sendError(res, new Error('Número do negócio inválido.'), 400);
    const deal = await moskitService.fetchFullDeal(id);
    const row = blingDb.enqueue(id, deal.name, deal.price, 'manual');
    res.json({ success: true, pedido: row });
  } catch (err) { sendError(res, err); }
});

router.post('/api/bling/fila/:dealId/status', (req, res) => {
  try {
    const ok = blingDb.setStatus(req.params.dealId, req.body && req.body.status);
    if (!ok) return sendError(res, new Error('Não foi possível alterar o status (pedido já enviado ou inexistente).'), 400);
    res.json({ success: true, pedido: blingDb.getOrderByDeal(req.params.dealId) });
  } catch (err) { sendError(res, err, 400); }
});

router.get('/api/bling/fila/:dealId/log', (req, res) => {
  try {
    res.json({ success: true, pedido: blingDb.getOrderByDeal(req.params.dealId), log: blingDb.getLog(req.params.dealId) });
  } catch (err) { sendError(res, err); }
});

// Conferência: monta o pedido sem gravar nada no Bling
router.get('/api/bling/preview/:dealId', async (req, res) => {
  try {
    const preview = await blingService.buildPreview(req.params.dealId);
    res.json({ success: true, preview });
  } catch (err) { sendError(res, err); }
});

// Envio confirmado pelo usuário
router.post('/api/bling/enviar/:dealId', async (req, res) => {
  try {
    const result = await blingService.sendDeal(req.params.dealId, {
      confirmarAvisos: Boolean(req.body && req.body.confirmarAvisos === true),
      origem: 'manual'
    });
    // Pedido criado pela tela Bling: cria a O.S. junto (mesmo número), se ainda não existir
    if (result.ok) {
      try {
        const r = await blingService.createOsForDeal(Number(req.params.dealId), {
          preview: result.preview || null,
          numero: result.pedido && result.pedido.numero ? blingService.formatOsNumber(result.pedido.numero) : null,
          status: result.pedido && result.pedido.numero ? 'won' : blingService.OS_STATUS_AGUARDANDO,
          origem: 'manual'
        });
        if (r && r.criada) result.osCriada = r.os.orcamento_numero;
      } catch (e) { result.avisoOs = `Pedido criado, mas a O.S. não pôde ser criada: ${e.message}`; }
    }
    res.status(result.ok ? 200 : 409).json({ success: result.ok, ...result });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
