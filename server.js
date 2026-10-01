const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const moskitService = require('./moskitService');
const pdfService = require('./pdfService');
const skuDictionary = require('./skuDictionary');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/templates', express.static(path.join(__dirname, 'templates')));

// Configure Multer for photo uploads
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `os_photo_${req.params.id}_${Date.now()}${ext}`;
    cb(null, uniqueName);
  }
});
const uploadPhoto = multer({
  storage: photoStorage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
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
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `company_logo_${Date.now()}${ext}`);
  }
});
const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 8 * 1024 * 1024 }
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
      const prevPath = path.join(__dirname, 'uploads', previous);
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
      const prevPath = path.join(__dirname, 'uploads', previous);
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
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Webhook listener for Moskit CRM
app.post('/api/webhook/moskit', async (req, res) => {
  console.log('[Webhook Moskit Recebido]:', JSON.stringify(req.body).substring(0, 300));
  try {
    const payload = req.body;
    let dealData = null;

    // Moskit webhooks might send the deal directly or nested in "deal" or "data"
    if (payload.deal) {
      dealData = payload.deal;
    } else if (payload.data && (payload.data.id || payload.data.deal)) {
      dealData = payload.data.deal || payload.data;
    } else if (payload.id && (payload.name || payload.status)) {
      dealData = payload;
    }

    if (!dealData) {
      console.warn('[Webhook] Payload não contém informações identificáveis de negócio');
      return res.status(200).json({ received: true, ignored: 'Sem dados de deal' });
    }

    // Check status: only process won / Ganhou deals or stage change to won
    const status = String(dealData.status || '').toUpperCase();
    const isWon = status === 'WON' || status === 'GANHOU' || dealData.won === true ||
                  (payload.event && payload.event.includes('WON'));

    if (isWon) {
      console.log(`[Webhook] Negócio GANHOU detectado! ID: ${dealData.id} - ${dealData.name}`);
      // Fetch full details to ensure products and contacts are complete
      let fullDeal = dealData;
      if (db.getSetting('moskit_api_key', '')) {
        try {
          fullDeal = await moskitService.fetchFullDeal(dealData.id);
        } catch (e) {
          console.warn('[Webhook] Aviso ao buscar dados completos:', e.message);
        }
      }

      const result = await moskitService.importDeal(fullDeal);
      return res.status(200).json({ success: true, action: result.action, orderId: result.order.id });
    } else {
      console.log(`[Webhook] Negócio ID ${dealData.id} ignorado pois status é "${dealData.status}" (não é Ganhou)`);
      return res.status(200).json({ received: true, ignored: `Status ${dealData.status} não é Ganhou` });
    }
  } catch (err) {
    console.error('[Webhook Erro]:', err);
    // Always return 200 to webhook caller to prevent retries storm, but log error
    res.status(200).json({ received: true, error: err.message });
  }
});

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

// Start server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  SISTEMA O.S. MARCA VENTO - MOSKIT CRM INTEGRATION`);
  console.log(`  Servidor rodando em: http://localhost:${PORT}`);
  console.log(`  Webhook URL: http://localhost:${PORT}/api/webhook/moskit`);
  console.log(`=======================================================`);
});
