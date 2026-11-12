const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const moskitService = require('./moskitService');
const pdfService = require('./pdfService');
const skuDictionary = require('./skuDictionary');
const crypto = require('crypto');
const blingDb = require('./blingDb');
const blingRoutes = require('./blingRoutes');
const blingService = require('./blingService');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
// Diagnóstico do webhook: registra TODA chamada recebida (só metadados, sem dados de cliente)
function registrarChegadaWebhook(req, extra = {}) {
  try {
    let lista = [];
    try { lista = JSON.parse(blingDb.getConfig('webhook_chegadas', '[]')) || []; } catch (e) { lista = []; }
    lista.unshift({
      em: new Date().toISOString(),
      metodo: req.method,
      tipo: String(req.get('content-type') || '').slice(0, 80),
      tamanho: Number(req.get('content-length') || 0),
      agente: String(req.get('user-agent') || '').slice(0, 80),
      ...extra
    });
    blingDb.setConfig('webhook_chegadas', JSON.stringify(lista.slice(0, 30)));
  } catch (e) { /* nunca derruba a requisição */ }
}
app.use('/api/webhook/moskit', (req, res, next) => {
  const inicio = Date.now();
  registrarChegadaWebhook(req, { caminho: req.originalUrl.split('?')[0], fase: 'chegou' });
  res.on('finish', () => {
    let resumo = '';
    try { resumo = res.locals.webhookResumo || ''; } catch (e) { resumo = ''; }
    registrarChegadaWebhook(req, { caminho: req.originalUrl.split('?')[0], fase: 'respondeu', resposta: res.statusCode, ms: Date.now() - inicio, resultado: String(resumo).slice(0, 200), ...(res.locals.webhookDiag ? { diagnostico: res.locals.webhookDiag } : {}) });
  });
  next();
});

// Estrutura do conteúdo recebido (apenas nomes e tipos dos campos, nunca os valores)
function formatoPayload(v, depth = 0, emMetadata = false) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > 2 ? 'array' : [v.length ? formatoPayload(v[0], depth + 1, emMetadata) : 'vazio'];
  if (typeof v === 'object') {
    if (depth > 2) return 'objeto';
    const out = {};
    for (const k of Object.keys(v).slice(0, 40)) out[k] = formatoPayload(v[k], depth + 1, emMetadata || (depth === 0 && k === 'metadata'));
    return out;
  }
  // Mostra só valores do tipo "código" (ex.: DEAL_UPDATED, WON); nunca nomes ou dados de cliente
  if (typeof v === 'string' && /^[A-Z_.]{2,40}$/.test(v) && (depth <= 1 || emMetadata)) return `texto:${v}`;
  if (typeof v === 'string' && emMetadata && /^[a-z_.]{2,30}$/.test(v)) return `texto:${v}`;
  return typeof v;
}
function registrarFormatoWebhook(body, extra = {}) {
  try {
    let lista = [];
    try { lista = JSON.parse(blingDb.getConfig('webhook_formatos', '[]')) || []; } catch (e) { lista = []; }
    lista.unshift({ em: new Date().toISOString(), formato: formatoPayload(body), ...extra });
    blingDb.setConfig('webhook_formatos', JSON.stringify(lista.slice(0, 10)));
  } catch (e) { /* nunca derruba a requisição */ }
}

app.use(express.json({ limit: '25mb' }));
// Aceita também corpo em texto (alguns serviços enviam JSON sem o Content-Type correto)
app.use('/api/webhook/moskit', express.text({ type: () => true, limit: '5mb' }), (req, res, next) => {
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); }
    catch (e) {
      try { req.body = Object.fromEntries(new URLSearchParams(req.body)); } catch (e2) { req.body = {}; }
    }
  }
  if (Array.isArray(req.body)) req.body = req.body[0] || {};
  next();
});
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(db.UPLOADS_DIR));
app.use('/uploads', express.static(db.LEGACY_UPLOADS_DIR));
app.use('/templates', express.static(path.join(__dirname, 'templates')));

// Configure Multer for photo uploads
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, db.UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `os_photo_${req.params.id}_${Date.now()}${ext}`;
    cb(null, uniqueName);
  }
});
// Only accept raster images (blocks .html/.svg uploads being served from /uploads)
const imageFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif'].includes(ext) && /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Apenas imagens JPG, PNG, WEBP ou GIF são permitidas.'));
  }
};

const uploadPhoto = multer({
  storage: photoStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: imageFileFilter
});

// Configure Multer for PDF template uploads
const templateStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmplDir = path.join(__dirname, 'templates');
    if (!fs.existsSync(tmplDir)) fs.mkdirSync(tmplDir, { recursive: true });
    cb(null, tmplDir);
  },
  filename: (req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueName = `template_${Date.now()}_${cleanName}`;
    cb(null, uniqueName);
  }
});
const uploadTemplate = multer({
  storage: templateStorage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos no formato .PDF são permitidos.'));
    }
  }
});

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, db.UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `company_logo_${Date.now()}${ext}`);
  }
});
const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: imageFileFilter
});

// ==========================================
// API ROUTES: SETTINGS & SEQUENTIAL NUMBER
// ==========================================

// Get settings
app.get('/api/settings', (req, res) => {
  try {
    const settings = db.getSettings();
    const nextSeq = db.getNextOrcamentoNumero(false);
    res.json({
      success: true,
      settings,
      nextOrcamento: nextSeq
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save settings
app.post('/api/settings', (req, res) => {
  try {
    const updated = db.saveSettings(req.body);
    const nextSeq = db.getNextOrcamentoNumero(false);
    res.json({ success: true, settings: updated, nextOrcamento: nextSeq });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings/logo', uploadLogo.single('logo'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Nenhuma imagem de logotipo foi enviada.' });
    }
    const previous = db.getSetting('company_logo', '');
    if (previous) {
      const prevPath = db.uploadPath(previous);
      if (fs.existsSync(prevPath) && previous !== req.file.filename) {
        try { fs.unlinkSync(prevPath); } catch (e) { /* ignore */ }
      }
    }
    db.setSetting('company_logo', req.file.filename);
    res.json({
      success: true,
      filename: req.file.filename,
      url: `/uploads/${req.file.filename}`,
      settings: db.getSettings()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/settings/logo', (req, res) => {
  try {
    const previous = db.getSetting('company_logo', '');
    if (previous) {
      const prevPath = db.uploadPath(previous);
      if (fs.existsSync(prevPath)) {
        try { fs.unlinkSync(prevPath); } catch (e) { /* ignore */ }
      }
    }
    db.setSetting('company_logo', '');
    res.json({ success: true, settings: db.getSettings() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get next sequential budget number
app.get('/api/next-orcamento', (req, res) => {
  try {
    const nextSeq = db.getNextOrcamentoNumero(false);
    res.json({ success: true, ...nextSeq });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// API ROUTES: MOSKIT CRM INTEGRATION
// ==========================================

// List available fields for mapping
app.get('/api/moskit/fields', async (req, res) => {
  try {
    const fields = await moskitService.getAvailableFields();
    res.json({ success: true, ...fields });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test Moskit connection
app.post('/api/moskit/test-connection', async (req, res) => {
  try {
    const { apiKey } = req.body;
    const result = await moskitService.testConnection(apiKey);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Sincronizar negócios "Ganhou"
app.post('/api/moskit/sync', async (req, res) => {
  // A sincronização cria O.S. em lote e SOBRESCREVE O.S. existentes com os dados do Moskit.
  // Só executa com confirmação explícita vinda da tela.
  if (!req.body || req.body.confirmado !== true) {
    return res.status(400).json({ success: false, error: 'Sincronização não confirmada. Use o botão "Sincronizar Moskit" e confirme o aviso.' });
  }
  try {
    const results = await moskitService.syncWonDeals();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Import deal by ID
app.post('/api/moskit/import-deal/:dealId', async (req, res) => {
  try {
    const dealId = req.params.dealId;
    const fullDeal = await moskitService.fetchFullDeal(dealId);
    const result = await moskitService.importDeal(fullDeal);
    // Se o pedido já existe no Bling, a O.S. recebe o mesmo número
    try { blingService.syncOsNumber(fullDeal.id || dealId, 'manual'); } catch (e) { /* isolado */ }
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Webhook listener for Moskit CRM
app.post('/api/webhook/moskit', async (req, res, next) => {
  const jsonOriginal = res.json.bind(res);
  res.json = (body) => { try { res.locals.webhookResumo = JSON.stringify(body); } catch (e) { /* ignora */ } return jsonOriginal(body); };
  return webhookMoskitHandler(req, res, next);
});

async function webhookMoskitHandler(req, res) {
  // Proteção opcional: só é exigida depois que um token for gerado na tela do Bling.
  // Sem token configurado, o webhook funciona exatamente como antes.
  // Avisos enviados pelo Bling não são usados neste endereço: confirma o recebimento e ignora
  if (/bling/i.test(String(req.get('user-agent') || ''))) {
    return res.status(200).json({ received: true, ignored: 'Aviso do Bling não é usado neste endereço' });
  }

  let expectedToken = '';
  let moskitToken = '';
  try {
    expectedToken = blingDb.getConfig('moskit_webhook_token', '');
    moskitToken = blingDb.getConfig('moskit_token_origem', '');
  } catch (e) { expectedToken = ''; moskitToken = ''; }
  if (expectedToken || moskitToken) {
    const igual = (x, y) => {
      if (!x || !y) return false;
      const a = Buffer.from(String(x)); const b = Buffer.from(String(y));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    };
    // 1) token do sistema na URL (?token=) ou no cabeçalho x-webhook-token
    let valido = igual(req.query.token, expectedToken) || igual(req.get('x-webhook-token'), expectedToken);
    // 2) token que o próprio Moskit envia em cada aviso (cabeçalho ou campo do corpo)
    if (!valido && moskitToken) {
      const candidatos = [];
      for (const v of Object.values(req.headers || {})) {
        for (const parte of String(v).split(/[\s,;]+/)) candidatos.push(parte.replace(/^(Bearer|Token)$/i, ''));
      }
      // procura em todos os campos de texto do corpo (até 3 níveis; o Moskit envia dentro de "metadata")
      const coletar = (obj, nivel) => {
        if (!obj || typeof obj !== 'object' || nivel > 3) return;
        for (const v of Object.values(obj)) {
          if (typeof v === 'string') candidatos.push(v);
          else if (v && typeof v === 'object' && !Array.isArray(v)) coletar(v, nivel + 1);
        }
      };
      coletar(req.body, 1);
      valido = candidatos.some(c => igual(c, moskitToken));
    }
    if (!valido) {
      console.warn('[Webhook] Chamada recusada: token ausente ou inválido.');
      res.locals.webhookDiag = {
        tokenNaUrl: Boolean(req.query.token),
        cabecalhos: Object.keys(req.headers || {}).filter(h => !/^(host|connection|content-length|accept-encoding|fly-|x-forwarded|via|x-request-start|cdn-loop)/i.test(h)).slice(0, 20),
        camposCorpo: Object.keys(req.body && typeof req.body === 'object' ? req.body : {}).slice(0, 20)
      };
      return res.status(401).json({ received: false, error: 'Token do webhook inválido.' });
    }
  }

  console.log('[Webhook Moskit Recebido]:', JSON.stringify(req.body).substring(0, 300));
  try {
    const payload = req.body;
    let dealData = null;

    // Formato real do Moskit: { metadata: {...}, before: {...}, after: {...} }
    if (payload && payload.after && typeof payload.after === 'object' && payload.after.id) {
      const meta = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
      const textos = Object.values(meta).filter(v => typeof v === 'string').join(' ');
      const naoNegocio = /(contact|contato|company|empresa|activit|atividade)/i.test(textos) && !/(deal|neg[oó]cio)/i.test(textos);
      if (naoNegocio) {
        registrarFormatoWebhook(payload, { acao: 'evento de contato/empresa/atividade: ignorado' });
        return res.status(200).json({ received: true, ignored: 'Evento não é de negócio' });
      }
      payload.deal = { ...payload.after };
    }

    // Moskit webhooks might send the deal directly or nested in "deal" or "data"
    if (payload.deal) {
      dealData = payload.deal;
    } else if (payload.data && (payload.data.id || payload.data.deal)) {
      dealData = payload.data.deal || payload.data;
    } else if (payload.id && (payload.name || payload.status)) {
      dealData = payload;
    } else if (payload.id) {
      dealData = { id: payload.id };
    }

    registrarFormatoWebhook(req.body, { acao: 'recebido' });

    // Registro do último webhook recebido (só tipo, id, status e ação; sem dados de cliente)
    const registrarWebhook = (acao) => {
      try {
        blingDb.setConfig('ultimo_webhook', JSON.stringify({
          recebidoEm: new Date().toISOString(),
          evento: String(payload.event || payload.type || payload.action || payload.eventType || '').slice(0, 60),
          chaves: Object.keys(payload || {}).slice(0, 15),
          negocioId: dealData && dealData.id ? dealData.id : null,
          status: dealData && dealData.status ? String(dealData.status) : null,
          acao
        }));
      } catch (e) { /* nunca derruba o webhook */ }
    };

    if (!dealData) {
      registrarFormatoWebhook(payload, { acao: 'sem dados de negócio reconhecíveis' });
      registrarWebhook('ignorado: sem dados de negócio');
      console.warn('[Webhook] Payload não contém informações identificáveis de negócio');
      return res.status(200).json({ received: true, ignored: 'Sem dados de deal' });
    }

    // Se o evento não trouxer o status, consulta o negócio no Moskit (somente leitura)
    let fetchedDeal = null;
    if (!dealData.status && dealData.id && db.getSetting('moskit_api_key', '')) {
      try {
        fetchedDeal = await moskitService.fetchFullDeal(dealData.id);
        dealData = { ...dealData, status: fetchedDeal.status, name: dealData.name || fetchedDeal.name, price: dealData.price || fetchedDeal.price };
      } catch (e) {
        registrarWebhook('ignorado: negócio não encontrado no Moskit');
        return res.status(200).json({ received: true, ignored: 'Negócio não encontrado no Moskit' });
      }
    }

    // Check status: only process won / Ganhou deals or stage change to won
    const status = String(dealData.status || '').toUpperCase();
    const isWon = status === 'WON' || status === 'GANHOU' || dealData.won === true ||
                  (typeof payload.event === 'string' && payload.event.toUpperCase().includes('WON'));

    if (isWon) {
      console.log(`[Webhook] Negócio GANHOU detectado! ID: ${dealData.id} - ${dealData.name}`);
      // Fetch full details to ensure products and contacts are complete
      let fullDeal = fetchedDeal || dealData;
      if (!fetchedDeal && db.getSetting('moskit_api_key', '')) {
        try {
          fullDeal = await moskitService.fetchFullDeal(dealData.id);
        } catch (e) {
          console.warn('[Webhook] Aviso ao buscar dados completos:', e.message);
        }
      }

      const blingDealId = fullDeal.id || dealData.id;

      // Negócio ganho ANTES da data de corte, sem O.S. e fora da integração: ignorado
      // (o Moskit avisa a cada edição, inclusive de negócios antigos)
      let recente = true;
      try { recente = blingService.isRecentWin(fullDeal.closeDate || dealData.closeDate); } catch (e) { recente = true; }
      if (!recente && !db.getOrderByMoskitId(blingDealId) && !blingDb.getOrderByDeal(blingDealId)) {
        registrarWebhook(`ignorado: ganho antes de ${blingDb.getConfig('envio_automatico_desde', '')} (negócio antigo)`);
        return res.status(200).json({ received: true, ignored: 'Negócio ganho antes da data de corte' });
      }

      // O Moskit dispara o webhook a cada EDIÇÃO do negócio. Se a O.S. já existe,
      // ela NÃO é sobrescrita (preserva data, itens e edições feitas à mão).
      const existente = db.getOrderByMoskitId(blingDealId);

      // Pedido no Bling + O.S. criados juntos, em segundo plano (mesma estrutura de dados).
      // Sem pedido criado, a O.S. nasce "Aguardando Bling" com número provisório.
      setImmediate(() => {
        blingService.processWebhookDeal(blingDealId, {
          won: true, criarOS: !existente,
          nome: fullDeal.name || dealData.name, valor: fullDeal.price || dealData.price, closeDate: fullDeal.closeDate || dealData.closeDate
        }).catch(e => console.warn('[Webhook] Bling:', e.message));
      });

      if (existente) {
        registrarWebhook(`O.S. ${existente.orcamento_numero} já existe: mantida sem alterações`);
        return res.status(200).json({ success: true, action: 'mantida', orderId: existente.id });
      }
      registrarWebhook('negócio Ganho recebido: criando pedido no Bling e O.S.');
      return res.status(200).json({ success: true, action: 'processando' });
    } else {
      registrarWebhook('ignorado: negócio não está como Ganhou');
      // Se o pedido já foi criado no Bling, registra no histórico a mudança de status no Moskit
      try {
        if (dealData.id && blingDb.getOrderByDeal(dealData.id)) {
          const st = dealData.status;
          setImmediate(() => blingService.processWebhookDeal(dealData.id, { won: false, status: st }).catch(() => {}));
        }
      } catch (e) { /* isolado */ }
      console.log(`[Webhook] Negócio ID ${dealData.id} ignorado pois status é "${dealData.status}" (não é Ganhou)`);
      return res.status(200).json({ received: true, ignored: `Status ${dealData.status} não é Ganhou` });
    }
  } catch (err) {
    console.error('[Webhook Erro]:', err);
    registrarFormatoWebhook(req.body, { erro: String(err.message || err).slice(0, 200) });
    // Always return 200 to webhook caller to prevent retries storm, but log error
    res.status(200).json({ received: true, error: err.message });
  }
}

// ==========================================
// API ROUTES: FIELD MAPPINGS
// ==========================================

app.get('/api/mappings', (req, res) => {
  try {
    const mappings = db.getFieldMappings();
    res.json({ success: true, mappings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mappings', (req, res) => {
  try {
    const mappingsList = req.body.mappings || req.body;
    const saved = db.saveFieldMappings(mappingsList);
    res.json({ success: true, mappings: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// API ROUTES: PRODUCT SKU DICTIONARY
// ==========================================

// List all SKUs in dictionary
app.get('/api/skus', (req, res) => {
  try {
    const skus = db.getProductSkus(req.query.search);
    res.json({ success: true, skus });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single SKU or parse it
app.get('/api/skus/:sku', (req, res) => {
  try {
    const skuCode = req.params.sku;
    let skuData = db.getProductSkuBySku(skuCode);
    if (!skuData) {
      const parsed = skuDictionary.parseSku(skuCode);
      skuData = { sku: skuCode, ...parsed, isAutoParsed: true };
    }
    res.json({ success: true, sku: skuData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save or update SKU mapping
app.post('/api/skus', (req, res) => {
  try {
    const saved = db.saveProductSku(req.body);
    res.json({ success: true, sku: saved });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete SKU mapping
app.delete('/api/skus/:id', (req, res) => {
  try {
    const ok = db.deleteProductSku(req.params.id);
    res.json({ success: ok });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Test / Parse SKU string
app.post('/api/skus/parse', (req, res) => {
  try {
    const { sku } = req.body;
    const parsed = skuDictionary.parseSku(sku);
    res.json({ success: true, parsed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync SKUs with Moskit CRM products catalog
app.post('/api/skus/sync-moskit', async (req, res) => {
  try {
    const result = await moskitService.syncMoskitSkus();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// API ROUTES: PDF TEMPLATES
// ==========================================

app.get('/api/templates', (req, res) => {
  try {
    const templates = db.getTemplates();
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/templates/upload', uploadTemplate.single('templateFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Nenhum arquivo PDF foi enviado.' });
    }

    const name = req.body.name || req.file.originalname.replace('.pdf', '');
    const isDefault = req.body.is_default === 'true' || req.body.is_default === '1' ? 1 : 0;

    const newTemplate = db.addTemplate(name, req.file.filename, isDefault);
    res.json({ success: true, template: newTemplate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/templates/:id/default', (req, res) => {
  try {
    const templates = db.setDefaultTemplate(req.params.id);
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/templates/:id', (req, res) => {
  try {
    db.deleteTemplate(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==========================================
// API ROUTES: SERVICE ORDERS (O.S.)
// ==========================================

// List orders
app.get('/api/orders', (req, res) => {
  try {
    const { search, status, dateFrom, dateTo, page, pageSize } = req.query;
    const result = db.getOrders(search, status, { dateFrom, dateTo, page, pageSize });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get order by ID
app.get('/api/orders/:id', (req, res) => {
  try {
    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'O.S. não encontrada' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create manual order
app.post('/api/orders', (req, res) => {
  try {
    const { orderData, items } = req.body;
    const newOrder = db.createOrder(orderData, items);
    res.json({ success: true, order: newOrder });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update order
app.put('/api/orders/:id', (req, res) => {
  try {
    const { orderData, items } = req.body;
    const updated = db.updateOrder(req.params.id, orderData, items);
    if (!updated) return res.status(404).json({ success: false, error: 'O.S. não encontrada' });
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete order
app.delete('/api/orders/:id', (req, res) => {
  try {
    const ok = db.deleteOrder(req.params.id);
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upload photo for order
app.post('/api/orders/:id/photo', uploadPhoto.single('photo'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Nenhum arquivo de imagem foi enviado.' });
    }
    const updated = db.setOrderPhoto(req.params.id, req.file.filename);
    res.json({ success: true, order: updated, photoUrl: `/uploads/${req.file.filename}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remove photo from order
app.delete('/api/orders/:id/photo', (req, res) => {
  try {
    const updated = db.removeOrderPhoto(req.params.id);
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Download / stream filled PDF
app.get('/api/orders/:id/pdf', async (req, res) => {
  try {
    const pdfBuffer = await pdfService.generateServiceOrderPdf(req.params.id);
    const order = db.getOrderById(req.params.id);
    const filename = `OS_${order.orcamento_numero.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Erro ao gerar PDF:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// INTEGRAÇÃO BLING (rotas /api/bling/*)
// ==========================================
app.use(blingRoutes);

// Diagnóstico de contatos Bling x Moskit (somente leitura)
const contatosService = require('./contatosService');
app.get('/api/contatos/diagnostico', (req, res) => {
  try { res.json({ success: true, ...contatosService.status() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post('/api/contatos/diagnostico', (req, res) => {
  try { res.json({ success: true, ...contatosService.iniciarDiagnostico() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Sincronização Bling -> Moskit: "preparar" só lê; "aplicar" grava apenas os itens confirmados
const contatosSync = require('./contatosSyncService');
app.get('/api/contatos/sync', (req, res) => {
  try { res.json({ success: true, ...contatosSync.status() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post('/api/contatos/sync/preparar', (req, res) => {
  try { res.json({ success: true, ...contatosSync.iniciarPreparo() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post('/api/contatos/sync/aplicar', (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Nenhum cadastro selecionado.' });
    const confirmacao = String((req.body && req.body.confirmacao) || '').trim().toUpperCase();
    if (ids.length > 1 && confirmacao !== 'SINCRONIZAR') return res.status(400).json({ success: false, error: 'Para gravar mais de um cadastro, digite SINCRONIZAR na confirmação.' });
    if (ids.length === 1 && req.body.confirmado !== true) return res.status(400).json({ success: false, error: 'Confirmação necessária.' });
    res.json({ success: true, ...contatosSync.iniciarAplicacao(ids) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post('/api/contatos/sync/reconferir', (req, res) => {
  try { res.json({ success: true, ...contatosSync.iniciarReconferencia() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post('/api/contatos/sync/recalcular', (req, res) => {
  try { res.json({ success: true, ...contatosSync.iniciarRecalculo() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post('/api/contatos/sync/parar', (req, res) => {
  res.json({ success: true, ...contatosSync.parar() });
});

// ==========================================
// TEST ENDPOINT: SIMULATE DEAL IMPORT
// ==========================================

// Allows testing without needing an active Moskit API key
app.post('/api/test/simulate-deal', async (req, res) => {
  try {
    const mockId = Math.floor(100000 + Math.random() * 900000);
    const mockDeal = {
      id: mockId,
      name: 'Kit Wind Banners - Drogaria São Paulo',
      price: 1850.00,
      status: 'WON',
      closeDate: new Date(Date.now() + 7 * 86400000).toISOString(),
      company: {
        id: 4521,
        name: 'Drogaria São Paulo',
        legalName: 'D.S.P. Farmácias e Drogarias LTDA',
        cnpj: '61.412.110/0001-55',
        phone: '(17) 3233-9090'
      },
      contact: {
        id: 7812,
        name: 'Carlos Alberto Mendes',
        cpf: '123.456.789-00',
        phones: [{ number: '(17) 99781-4422' }],
        emails: [{ address: 'compras@drogariasp.com.br' }]
      },
      customFields: {
        forma_pagamento: 'Boleto Bancário',
        prazo_pagamento: '28 dias',
        frete: 'FOB / Transportadora',
        data_entrega: '15/10/2026'
      },
      dealProducts: [
        {
          quantity: '4',
          product: { name: 'WIND BANNER BOX 2,00M FACE DUPLA BASE SOLO', sku: 'WBB200FDSO' },
          price: 320.00
        },
        {
          quantity: '2',
          product: { name: 'WIND BANNER PENA 2,00M FACE DUPLA BASE PLASTICA', sku: 'WBP200FDPL' },
          price: 190.00
        },
        {
          quantity: '1',
          product: { name: 'BACKDROP 300 X 200', sku: 'BD300X200' },
          price: 980.00
        }
      ]
    };

    const result = await moskitService.importDeal(mockDeal);
    res.json({
      success: true,
      message: 'Negócio de teste importado com sucesso!',
      order: result.order
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upload/validation errors (multer) must reach the frontend as JSON
app.use((err, req, res, next) => {
  if (req.originalUrl && req.originalUrl.startsWith('/api/webhook/moskit')) {
    registrarChegadaWebhook(req, { erro: String(err.message || err).slice(0, 200) });
  }
  const status = err instanceof multer.MulterError ? 400 : (err.status || 400);
  res.status(status).json({ success: false, error: err.message });
});

// Start server
// Conta de teste do Fly.io desliga a máquina a cada 5 min: salva o progresso das tarefas de contatos
// no aviso de desligamento e continua sozinho quando o servidor religa.
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.once(sinal, () => {
    try { contatosSync.salvarAoDesligar(); } catch (e) {}
    process.exit(0);
  });
}
setTimeout(() => { try { contatosSync.retomarAoIniciar(); } catch (e) { console.error('[contatos] retomada:', e.message); } }, 5000);

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  SISTEMA O.S. MARCA VENTO - MOSKIT CRM INTEGRATION`);
  console.log(`  Servidor rodando em: http://localhost:${PORT}`);
  console.log(`  Webhook URL: http://localhost:${PORT}/api/webhook/moskit`);
  console.log(`=======================================================`);
});
