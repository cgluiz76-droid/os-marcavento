const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'os_marcavento.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Initialize Tables
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS pdf_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      field_positions TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS field_mappings (
      os_field TEXT PRIMARY KEY,
      moskit_source TEXT NOT NULL,
      fallback_value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS service_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      moskit_deal_id INTEGER UNIQUE,
      orcamento_numero TEXT NOT NULL,
      data_os TEXT NOT NULL,
      nome_fantasia TEXT,
      razao_social TEXT,
      cnpj_cpf TEXT,
      contato_nome TEXT,
      contato_telefone TEXT,
      contato_email TEXT,
      data_entrega TEXT,
      forma_pagamento TEXT,
      prazo_pagamento TEXT,
      frete TEXT,
      photo_filename TEXT,
      observacoes TEXT,
      template_id INTEGER,
      status TEXT DEFAULT 'won',
      raw_deal_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      qtde TEXT,
      prod TEXT,
      modelo TEXT,
      dimensao TEXT,
      posicao TEXT,
      base TEXT,
      preco_unitario REAL DEFAULT 0,
      ordem INTEGER DEFAULT 0,
      sku TEXT
    );

    CREATE TABLE IF NOT EXISTS product_skus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE NOT NULL,
      prod TEXT,
      modelo TEXT,
      dimensao TEXT,
      posicao TEXT,
      base TEXT,
      descricao TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Ensure sku column exists in order_items if previously created
  try { db.exec('ALTER TABLE order_items ADD COLUMN sku TEXT;'); } catch (e) {}

  // Seed default settings if not existing
  const defaultSettings = [
    { key: 'moskit_api_key', value: '' },
    { key: 'orcamento_proximo_numero', value: '1' },
    { key: 'orcamento_auto_increment', value: 'true' },
    { key: 'orcamento_formato', value: '{NUM}/26' },
    { key: 'orcamento_padding', value: '4' },
    { key: 'default_prazo_pagamento', value: 'À Vista' },
    { key: 'default_forma_pagamento', value: 'PIX / Boleto' },
    { key: 'default_frete', value: 'Incluso' }
  ];

  const checkStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const insertStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');

  for (const s of defaultSettings) {
    const row = checkStmt.get(s.key);
    if (!row) {
      insertStmt.run(s.key, s.value);
    }
  }

  // Seed default PDF template
  const tmplCheck = db.prepare('SELECT id FROM pdf_templates WHERE filename = ?').get('default_os_marcavento.pdf');
  if (!tmplCheck) {
    db.prepare(`
      INSERT INTO pdf_templates (name, filename, is_default, field_positions)
      VALUES (?, ?, 1, ?)
    `).run('OS Marca Vento (Padrão)', 'default_os_marcavento.pdf', JSON.stringify({
      version: 1,
      name: 'OS MARCAVENTO Oficial'
    }));
  }

  // Seed default field mappings
  const defaultMappings = [
    { os_field: 'nome_fantasia', moskit_source: 'company.name || deal.name', fallback_value: '' },
    { os_field: 'razao_social', moskit_source: 'company.legalName || company.name', fallback_value: '' },
    { os_field: 'cnpj_cpf', moskit_source: 'company.cnpj || contact.cpf', fallback_value: '' },
    { os_field: 'contato_nome', moskit_source: 'contact.name', fallback_value: '' },
    { os_field: 'contato_telefone', moskit_source: 'contact.phones[0].number || company.phone', fallback_value: '' },
    { os_field: 'contato_email', moskit_source: 'contact.emails[0].address', fallback_value: '' },
    { os_field: 'data_entrega', moskit_source: 'deal.closeDate || customFields.data_entrega', fallback_value: '' },
    { os_field: 'forma_pagamento', moskit_source: 'customFields.forma_pagamento', fallback_value: 'PIX' },
    { os_field: 'prazo_pagamento', moskit_source: 'customFields.prazo_pagamento', fallback_value: 'À Vista' },
    { os_field: 'frete', moskit_source: 'customFields.frete', fallback_value: 'Incluso' },
    { os_field: 'item_qtde', moskit_source: 'dealProduct.quantity', fallback_value: '1' },
    { os_field: 'item_prod', moskit_source: 'dealProduct.product.name', fallback_value: '' },
    { os_field: 'item_modelo', moskit_source: 'dealProduct.customFields.modelo || dealProduct.product.model', fallback_value: '' },
    { os_field: 'item_dimensao', moskit_source: 'dealProduct.customFields.dimensao', fallback_value: '' },
    { os_field: 'item_posicao', moskit_source: 'dealProduct.customFields.posicao', fallback_value: '' },
    { os_field: 'item_base', moskit_source: 'dealProduct.customFields.base', fallback_value: '' }
  ];

  const mapCheck = db.prepare('SELECT os_field FROM field_mappings WHERE os_field = ?');
  const mapInsert = db.prepare('INSERT INTO field_mappings (os_field, moskit_source, fallback_value) VALUES (?, ?, ?)');

  for (const m of defaultMappings) {
    if (!mapCheck.get(m.os_field)) {
      mapInsert.run(m.os_field, m.moskit_source, m.fallback_value);
    }
  }

  // Seed initial SKUs dictionary
  const countSkus = db.prepare('SELECT COUNT(*) as count FROM product_skus').get();
  if (!countSkus || countSkus.count === 0) {
    const defaultSkus = [
      { sku: 'WBB200FDSO', prod: 'Wind Banner', modelo: 'Box', dimensao: '2,00', posicao: 'Face Dupla', base: 'Solo', descricao: 'WIND BANNER BOX 2,00M FACE DUPLA BASE SOLO' },
      { sku: 'WBB200FDPL', prod: 'Wind Banner', modelo: 'Box', dimensao: '2,00', posicao: 'Face Dupla', base: 'Plástica', descricao: 'WIND BANNER BOX 2,00M FACE DUPLA BASE PLASTICA' },
      { sku: 'WBP200FDPL', prod: 'Wind Banner', modelo: 'Pena', dimensao: '2,00', posicao: 'Face Dupla', base: 'Plástica', descricao: 'WIND BANNER PENA 2,00M FACE DUPLA BASE PLASTICA' },
      { sku: 'WBV200FDPL', prod: 'Wind Banner', modelo: 'Vela', dimensao: '2,00', posicao: 'Face Dupla', base: 'Plástica', descricao: 'WIND BANNER VELA 2,00M FACE DUPLA BASE PLASTICA' },
      { sku: 'WBB250FDPL', prod: 'Wind Banner', modelo: 'Box', dimensao: '2,50', posicao: 'Face Dupla', base: 'Plástica', descricao: 'WIND BANNER BOX 2,50M FACE DUPLA BASE PLASTICA' },
      { sku: 'BD300X200', prod: 'Backdrop', modelo: 'Padrão', dimensao: '3,00 x 2,00', posicao: 'Face Simples', base: 'Estrutura', descricao: 'BACKDROP 300 X 200' },
      { sku: 'BD200X160', prod: 'Backdrop', modelo: 'Padrão', dimensao: '2,00 x 1,60', posicao: 'Face Simples', base: 'Estrutura', descricao: 'BACKDROP 200 X 160' },
      { sku: 'BD200X200', prod: 'Backdrop', modelo: 'Padrão', dimensao: '2,00 x 2,00', posicao: 'Face Simples', base: 'Estrutura', descricao: 'BACKDROP 200 X 200' },
      { sku: 'BD200X80', prod: 'Backdrop', modelo: 'Padrão', dimensao: '2,00 x 0,80', posicao: 'Face Simples', base: 'Estrutura', descricao: 'BACKDROP 200 X 80' },
      { sku: 'BD250X80', prod: 'Backdrop', modelo: 'Padrão', dimensao: '2,50 x 0,80', posicao: 'Face Simples', base: 'Estrutura', descricao: 'BACKDROP 250 X 80' },
      { sku: 'RWBB200FD', prod: 'Refil Wind Banner', modelo: 'Box', dimensao: '2,00', posicao: 'Face Dupla', base: 'Sem Base', descricao: 'REFIL WIND BANNER BOX 2,00M FACE DUPLA' },
      { sku: 'RWBD200FD', prod: 'Refil Wind Banner', modelo: 'Diagonal', dimensao: '2,00', posicao: 'Face Dupla', base: 'Sem Base', descricao: 'REFIL WIND BANNER DIAGONAL 2,00M FACE DUPLA' }
    ];
    const insSku = db.prepare(`
      INSERT INTO product_skus (sku, prod, modelo, dimensao, posicao, base, descricao)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    defaultSkus.forEach(s => insSku.run(s.sku, s.prod, s.modelo, s.dimensao, s.posicao, s.base, s.descricao));
  }
}

initDatabase();

// --- Settings Helpers ---
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) {
    settings[r.key] = r.value;
  }
  return settings;
}

function getSetting(key, defaultValue = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
  if (exists) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), key);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  }
}

function saveSettings(settingsObj) {
  for (const [key, value] of Object.entries(settingsObj)) {
    setSetting(key, value);
  }
  return getSettings();
}

// --- Sequential Budget Number (Orçamento Nº) ---
function getNextOrcamentoNumero(increment = true) {
  const currentNumStr = getSetting('orcamento_proximo_numero', '1');
  const autoIncrement = getSetting('orcamento_auto_increment', 'true') === 'true';
  const formato = getSetting('orcamento_formato', '{NUM}/26');
  const padding = parseInt(getSetting('orcamento_padding', '4'), 10) || 4;

  const currentNum = parseInt(currentNumStr, 10) || 1;
  const numPadded = String(currentNum).padStart(padding, '0');

  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const yyyy = String(now.getFullYear());

  let formatted = formato
    .replace('{NUM}', numPadded)
    .replace('{NUM_RAW}', String(currentNum))
    .replace('{YY}', yy)
    .replace('{YYYY}', yyyy);

  if (increment && autoIncrement) {
    setSetting('orcamento_proximo_numero', String(currentNum + 1));
  }

  return {
    numero: formatted,
    rawNumber: currentNum,
    nextRawNumber: currentNum + 1
  };
}

// --- Field Mappings ---
function getFieldMappings() {
  return db.prepare('SELECT os_field, moskit_source, fallback_value FROM field_mappings').all();
}

function saveFieldMappings(mappingsList) {
  const upsertStmt = db.prepare(`
    INSERT INTO field_mappings (os_field, moskit_source, fallback_value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(os_field) DO UPDATE SET
      moskit_source = excluded.moskit_source,
      fallback_value = excluded.fallback_value,
      updated_at = CURRENT_TIMESTAMP
  `);

  for (const m of mappingsList) {
    if (m.os_field && m.moskit_source !== undefined) {
      upsertStmt.run(m.os_field, m.moskit_source, m.fallback_value || '');
    }
  }
  return getFieldMappings();
}

// --- PDF Templates ---
function getTemplates() {
  return db.prepare('SELECT * FROM pdf_templates ORDER BY is_default DESC, id ASC').all();
}

function getDefaultTemplate() {
  const tmpl = db.prepare('SELECT * FROM pdf_templates WHERE is_default = 1').get();
  if (tmpl) return tmpl;
  return db.prepare('SELECT * FROM pdf_templates ORDER BY id ASC LIMIT 1').get();
}

function addTemplate(name, filename, isDefault = 0, fieldPositions = null) {
  if (isDefault) {
    db.prepare('UPDATE pdf_templates SET is_default = 0').run();
  }
  const result = db.prepare(`
    INSERT INTO pdf_templates (name, filename, is_default, field_positions)
    VALUES (?, ?, ?, ?)
  `).run(name, filename, isDefault ? 1 : 0, fieldPositions ? JSON.stringify(fieldPositions) : null);
  return { id: result.lastInsertRowid, name, filename, isDefault };
}

function setDefaultTemplate(id) {
  db.prepare('UPDATE pdf_templates SET is_default = 0').run();
  db.prepare('UPDATE pdf_templates SET is_default = 1 WHERE id = ?').run(id);
  return getTemplates();
}

function deleteTemplate(id) {
  const tmpl = db.prepare('SELECT * FROM pdf_templates WHERE id = ?').get(id);
  if (!tmpl) return false;
  if (tmpl.is_default) {
    throw new Error('Não é possível excluir o modelo padrão ativo.');
  }
  db.prepare('DELETE FROM pdf_templates WHERE id = ?').run(id);
  const filePath = path.join(__dirname, 'templates', tmpl.filename);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { console.error('Erro ao deletar arquivo do template:', e); }
  }
  return true;
}

function parseOrderDate(value) {
  if (!value) return null;
  const str = String(value).trim();
  const br = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) {
    return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]));
  }
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }
  const ts = Date.parse(str);
  return Number.isNaN(ts) ? null : new Date(ts);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function endOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

// --- Orders Management ---
function getOrders(search = '', status = '', options = {}) {
  const dateFrom = options.dateFrom || '';
  const dateTo = options.dateTo || '';
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(options.pageSize, 10) || 10));

  let query = 'SELECT * FROM service_orders WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }

  if (search && search.trim() !== '') {
    query += ` AND (
      orcamento_numero LIKE ? OR
      nome_fantasia LIKE ? OR
      razao_social LIKE ? OR
      cnpj_cpf LIKE ? OR
      contato_nome LIKE ?
    )`;
    const s = `%${search.trim()}%`;
    params.push(s, s, s, s, s);
  }

  query += ' ORDER BY id DESC';
  let orders = db.prepare(query).all(...params);

  const fromDate = dateFrom ? parseOrderDate(dateFrom) : null;
  const toDate = dateTo ? parseOrderDate(dateTo) : null;
  if (fromDate || toDate) {
    const fromTs = fromDate ? startOfDay(fromDate) : null;
    const toTs = toDate ? endOfDay(toDate) : null;
    orders = orders.filter((o) => {
      const d = parseOrderDate(o.data_os) || parseOrderDate(o.created_at);
      if (!d) return false;
      const t = d.getTime();
      if (fromTs !== null && t < fromTs) return false;
      if (toTs !== null && t > toTs) return false;
      return true;
    });
  }

  const stats = {
    total: orders.length,
    won: orders.filter((o) => o.status === 'won').length,
    withPhoto: orders.filter((o) => o.photo_filename).length
  };

  const total = orders.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;
  const pageOrders = orders.slice(offset, offset + pageSize);

  const countStmt = db.prepare('SELECT COUNT(*) as count FROM order_items WHERE order_id = ?');
  for (const o of pageOrders) {
    const row = countStmt.get(o.id);
    o.items_count = row ? row.count : 0;
  }

  return {
    orders: pageOrders,
    total,
    page: currentPage,
    pageSize,
    totalPages,
    stats
  };
}

function getOrderById(id) {
  const order = db.prepare('SELECT * FROM service_orders WHERE id = ?').get(id);
  if (!order) return null;

  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY ordem ASC, id ASC').all(id);
  return order;
}

function getOrderByMoskitId(moskitDealId) {
  const order = db.prepare('SELECT * FROM service_orders WHERE moskit_deal_id = ?').get(moskitDealId);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY ordem ASC, id ASC').all(order.id);
  return order;
}

function createOrder(orderData, items = []) {
  // If orcamento_numero not supplied, generate next sequential
  let orcamentoNumero = orderData.orcamento_numero;
  if (!orcamentoNumero || orcamentoNumero.trim() === '') {
    const seq = getNextOrcamentoNumero(true);
    orcamentoNumero = seq.numero;
  }

  const defaultTmpl = getDefaultTemplate();
  const templateId = orderData.template_id || (defaultTmpl ? defaultTmpl.id : null);

  const stmt = db.prepare(`
    INSERT INTO service_orders (
      moskit_deal_id, orcamento_numero, data_os, nome_fantasia, razao_social,
      cnpj_cpf, contato_nome, contato_telefone, contato_email, data_entrega,
      forma_pagamento, prazo_pagamento, frete, photo_filename, observacoes,
      template_id, status, raw_deal_data, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, CURRENT_TIMESTAMP
    )
  `);

  const result = stmt.run(
    orderData.moskit_deal_id || null,
    orcamentoNumero,
    orderData.data_os || new Date().toLocaleDateString('pt-BR'),
    orderData.nome_fantasia || '',
    orderData.razao_social || '',
    orderData.cnpj_cpf || '',
    orderData.contato_nome || '',
    orderData.contato_telefone || '',
    orderData.contato_email || '',
    orderData.data_entrega || '',
    orderData.forma_pagamento || getSetting('default_forma_pagamento', 'PIX'),
    orderData.prazo_pagamento || getSetting('default_prazo_pagamento', 'À Vista'),
    orderData.frete || getSetting('default_frete', 'Incluso'),
    orderData.photo_filename || null,
    orderData.observacoes || '',
    templateId,
    orderData.status || 'won',
    orderData.raw_deal_data ? (typeof orderData.raw_deal_data === 'string' ? orderData.raw_deal_data : JSON.stringify(orderData.raw_deal_data)) : null
  );

  const orderId = result.lastInsertRowid;

  // Insert items
  if (Array.isArray(items) && items.length > 0) {
    const itemStmt = db.prepare(`
      INSERT INTO order_items (order_id, qtde, prod, modelo, dimensao, posicao, base, preco_unitario, ordem, sku)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    items.forEach((item, idx) => {
      itemStmt.run(
        orderId,
        String(item.qtde || '1'),
        item.prod || '',
        item.modelo || '',
        item.dimensao || '',
        item.posicao || '',
        item.base || '',
        parseFloat(item.preco_unitario) || 0,
        item.ordem !== undefined ? item.ordem : idx,
        item.sku || null
      );
    });
  }

  return getOrderById(orderId);
}

function updateOrder(id, orderData, items = null) {
  const existing = getOrderById(id);
  if (!existing) return null;

  const stmt = db.prepare(`
    UPDATE service_orders SET
      orcamento_numero = ?,
      data_os = ?,
      nome_fantasia = ?,
      razao_social = ?,
      cnpj_cpf = ?,
      contato_nome = ?,
      contato_telefone = ?,
      contato_email = ?,
      data_entrega = ?,
      forma_pagamento = ?,
      prazo_pagamento = ?,
      frete = ?,
      observacoes = ?,
      template_id = ?,
      status = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  stmt.run(
    orderData.orcamento_numero !== undefined ? orderData.orcamento_numero : existing.orcamento_numero,
    orderData.data_os !== undefined ? orderData.data_os : existing.data_os,
    orderData.nome_fantasia !== undefined ? orderData.nome_fantasia : existing.nome_fantasia,
    orderData.razao_social !== undefined ? orderData.razao_social : existing.razao_social,
    orderData.cnpj_cpf !== undefined ? orderData.cnpj_cpf : existing.cnpj_cpf,
    orderData.contato_nome !== undefined ? orderData.contato_nome : existing.contato_nome,
    orderData.contato_telefone !== undefined ? orderData.contato_telefone : existing.contato_telefone,
    orderData.contato_email !== undefined ? orderData.contato_email : existing.contato_email,
    orderData.data_entrega !== undefined ? orderData.data_entrega : existing.data_entrega,
    orderData.forma_pagamento !== undefined ? orderData.forma_pagamento : existing.forma_pagamento,
    orderData.prazo_pagamento !== undefined ? orderData.prazo_pagamento : existing.prazo_pagamento,
    orderData.frete !== undefined ? orderData.frete : existing.frete,
    orderData.observacoes !== undefined ? orderData.observacoes : existing.observacoes,
    orderData.template_id !== undefined ? orderData.template_id : existing.template_id,
    orderData.status !== undefined ? orderData.status : existing.status,
    id
  );

  // If items array is provided, replace items
  if (items !== null && Array.isArray(items)) {
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);

    const itemStmt = db.prepare(`
      INSERT INTO order_items (order_id, qtde, prod, modelo, dimensao, posicao, base, preco_unitario, ordem, sku)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    items.forEach((item, idx) => {
      itemStmt.run(
        id,
        String(item.qtde || '1'),
        item.prod || '',
        item.modelo || '',
        item.dimensao || '',
        item.posicao || '',
        item.base || '',
        parseFloat(item.preco_unitario) || 0,
        item.ordem !== undefined ? item.ordem : idx,
        item.sku || null
      );
    });
  }

  return getOrderById(id);
}

function deleteOrder(id) {
  const order = getOrderById(id);
  if (!order) return false;

  // Remove photo if exists
  if (order.photo_filename) {
    const photoPath = path.join(__dirname, 'uploads', order.photo_filename);
    if (fs.existsSync(photoPath)) {
      try { fs.unlinkSync(photoPath); } catch (e) { console.error('Erro ao deletar foto:', e); }
    }
  }

  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
  db.prepare('DELETE FROM service_orders WHERE id = ?').run(id);
  return true;
}

function setOrderPhoto(id, photoFilename) {
  const existing = getOrderById(id);
  if (!existing) return null;

  // If previous photo exists and is different, remove old
  if (existing.photo_filename && existing.photo_filename !== photoFilename) {
    const oldPath = path.join(__dirname, 'uploads', existing.photo_filename);
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch (e) {}
    }
  }

  db.prepare('UPDATE service_orders SET photo_filename = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(photoFilename, id);
  return getOrderById(id);
}

function removeOrderPhoto(id) {
  const existing = getOrderById(id);
  if (!existing) return null;

  if (existing.photo_filename) {
    const oldPath = path.join(__dirname, 'uploads', existing.photo_filename);
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch (e) {}
    }
  }

  db.prepare('UPDATE service_orders SET photo_filename = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(id);
  return getOrderById(id);
}

// --- Product SKU Dictionary Helpers ---
function getProductSkus(search = '') {
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    return db.prepare(`
      SELECT * FROM product_skus 
      WHERE sku LIKE ? OR prod LIKE ? OR modelo LIKE ? OR descricao LIKE ?
      ORDER BY sku ASC
    `).all(q, q, q, q);
  }
  return db.prepare('SELECT * FROM product_skus ORDER BY sku ASC').all();
}

function getProductSkuById(id) {
  return db.prepare('SELECT * FROM product_skus WHERE id = ?').get(id);
}

function getProductSkuBySku(sku) {
  if (!sku) return null;
  const cleanSku = String(sku).trim().toUpperCase();
  return db.prepare('SELECT * FROM product_skus WHERE UPPER(TRIM(sku)) = ?').get(cleanSku);
}

function saveProductSku(skuData) {
  if (!skuData || !skuData.sku) throw new Error('O campo SKU é obrigatório');
  const cleanSku = String(skuData.sku).trim().toUpperCase();

  const stmt = db.prepare(`
    INSERT INTO product_skus (sku, prod, modelo, dimensao, posicao, base, descricao, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(sku) DO UPDATE SET
      prod = excluded.prod,
      modelo = excluded.modelo,
      dimensao = excluded.dimensao,
      posicao = excluded.posicao,
      base = excluded.base,
      descricao = excluded.descricao,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run(
    cleanSku,
    skuData.prod || '',
    skuData.modelo || '',
    skuData.dimensao || '',
    skuData.posicao || '',
    skuData.base || '',
    skuData.descricao || ''
  );

  return getProductSkuBySku(cleanSku);
}

function deleteProductSku(id) {
  return db.prepare('DELETE FROM product_skus WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  db,
  getSettings,
  getSetting,
  setSetting,
  saveSettings,
  getNextOrcamentoNumero,
  getFieldMappings,
  saveFieldMappings,
  getTemplates,
  getDefaultTemplate,
  addTemplate,
  setDefaultTemplate,
  deleteTemplate,
  getOrders,
  getOrderById,
  getOrderByMoskitId,
  createOrder,
  updateOrder,
  deleteOrder,
  setOrderPhoto,
  removeOrderPhoto,
  getProductSkus,
  getProductSkuById,
  getProductSkuBySku,
  saveProductSku,
  deleteProductSku
};
