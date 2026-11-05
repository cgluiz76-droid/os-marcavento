// blingRoutes.js - Rotas HTTP da integração Moskit -> Bling
// Todas as rotas ficam sob /api/bling/* e não alteram as rotas existentes da O.S.

const express = require('express');
const crypto = require('crypto');
const moskitService = require('./moskitService');
const blingDb = require('./blingDb');
const blingService = require('./blingService');

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
        protegido: Boolean(token),
        url: token ? `${base}/api/webhook/moskit?token=${token}` : `${base}/api/webhook/moskit`
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

const CONFIG_KEYS = ['situacao_id', 'prazo_dias', 'forma_pagamento_id', 'categoria_id', 'vendedor_id', 'loja_id', 'auto_enfileirar'];

router.post('/api/bling/config', (req, res) => {
  try {
    const body = req.body || {};
    for (const k of CONFIG_KEYS) {
      if (body[k] === undefined) continue;
      let v = String(body[k]).trim();
      if (k === 'auto_enfileirar') v = v === 'false' ? 'false' : 'true';
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

// ---------- Segurança do webhook do Moskit ----------

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
    res.status(result.ok ? 200 : 409).json({ success: result.ok, ...result });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
