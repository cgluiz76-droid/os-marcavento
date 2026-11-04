// blingDb.js - Persistência da integração Moskit -> Bling
//
// SEGURANÇA DOS DADOS EXISTENTES:
// - Este módulo usa a MESMA conexão SQLite do db.js, mas só cria tabelas NOVAS
//   (prefixo "bling_") com CREATE TABLE IF NOT EXISTS.
// - Nenhuma tabela existente (service_orders, order_items, settings, ...) é
//   alterada, lida para escrita ou apagada aqui.
// - Credenciais e tokens do Bling ficam em "bling_config", que NÃO é exposta
//   pela rota GET /api/settings (ela lê apenas a tabela "settings").

const { db } = require('./db');

function initBlingTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bling_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bling_field_mappings (
      bling_field TEXT PRIMARY KEY,
      moskit_source TEXT NOT NULL,
      fallback_value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bling_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      moskit_deal_id INTEGER UNIQUE NOT NULL,
      deal_name TEXT,
      deal_value REAL,
      origem TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      bling_pedido_id TEXT,
      bling_pedido_numero TEXT,
      bling_contato_id TEXT,
      last_error TEXT,
      request_json TEXT,
      response_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS bling_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      moskit_deal_id INTEGER,
      acao TEXT,
      detalhe TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Valores padrão (só inseridos se ainda não existirem)
  const defaults = {
    situacao_id: '6',            // "Em aberto" (confirmado na conta Bling)
    prazo_dias: '30',            // vencimento da parcela = data do pedido + N dias (igual ao Pluga)
    forma_pagamento_id: '',      // opcional
    categoria_id: '',            // opcional
    vendedor_id: '',             // opcional
    loja_id: '',                 // opcional
    numero_loja_prefixo: 'MOSKIT-',
    auto_enfileirar: 'true',     // webhook "Ganhou" coloca o negócio na fila de conferência
    moskit_webhook_token: ''     // vazio = webhook funciona como hoje (sem exigir token)
  };
  const check = db.prepare('SELECT key FROM bling_config WHERE key = ?');
  const ins = db.prepare('INSERT INTO bling_config (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) {
    if (!check.get(k)) ins.run(k, v);
  }

  // Mapeamento padrão ORIGEM (Moskit) -> DESTINO (Bling)
  const defaultMappings = [
    { bling_field: 'contato.numeroDocumento', moskit_source: 'company.cnpj || contact.cpf', fallback_value: '' },
    { bling_field: 'contato.nome', moskit_source: 'company.legalName || company.name || contact.name', fallback_value: '' },
    { bling_field: 'contato.fantasia', moskit_source: 'company.name', fallback_value: '' },
    { bling_field: 'contato.email', moskit_source: 'contact.emails[0].address || company.email', fallback_value: '' },
    { bling_field: 'contato.telefone', moskit_source: 'contact.phones[0].number || company.phone', fallback_value: '' },
    { bling_field: 'contato.endereco', moskit_source: 'company.address', fallback_value: '' },
    { bling_field: 'contato.municipio', moskit_source: 'company.city', fallback_value: '' },
    { bling_field: 'contato.uf', moskit_source: 'company.state', fallback_value: '' },
    { bling_field: 'pedido.data', moskit_source: 'deal.closeDate', fallback_value: '' },
    { bling_field: 'pedido.dataPrevista', moskit_source: 'customFields.data_entrega', fallback_value: '' },
    { bling_field: 'pedido.observacoes', moskit_source: '', fallback_value: '' },
    { bling_field: 'pedido.numeroPedidoCompra', moskit_source: '', fallback_value: '' },
    { bling_field: 'item.codigo', moskit_source: 'dealProduct.product.sku || dealProduct.sku || dealProduct.product.code', fallback_value: '' },
    { bling_field: 'item.quantidade', moskit_source: 'dealProduct.quantity', fallback_value: '1' },
    { bling_field: 'item.valor', moskit_source: 'dealProduct.price || dealProduct.unitaryValue', fallback_value: '0' }
  ];
  const mCheck = db.prepare('SELECT bling_field FROM bling_field_mappings WHERE bling_field = ?');
  const mIns = db.prepare('INSERT INTO bling_field_mappings (bling_field, moskit_source, fallback_value) VALUES (?, ?, ?)');
  for (const m of defaultMappings) {
    if (!mCheck.get(m.bling_field)) mIns.run(m.bling_field, m.moskit_source, m.fallback_value);
  }
}

initBlingTables();

// ---------- Configuração ----------
function getConfig(key, def = '') {
  const row = db.prepare('SELECT value FROM bling_config WHERE key = ?').get(key);
  return row && row.value !== null ? row.value : def;
}

function setConfig(key, value) {
  db.prepare(`
    INSERT INTO bling_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value === null || value === undefined ? '' : String(value));
}

// Chaves que nunca saem do servidor
const SECRET_KEYS = new Set(['client_secret', 'access_token', 'refresh_token', 'oauth_state', 'moskit_webhook_token']);

function getPublicConfig() {
  const rows = db.prepare('SELECT key, value FROM bling_config').all();
  const out = {};
  for (const r of rows) {
    if (SECRET_KEYS.has(r.key)) continue;
    out[r.key] = r.value;
  }
  return out;
}

// ---------- Mapeamentos ----------
function getMappings() {
  return db.prepare('SELECT bling_field, moskit_source, fallback_value FROM bling_field_mappings ORDER BY bling_field').all();
}

function saveMappings(list) {
  const known = new Set(getMappings().map(m => m.bling_field));
  const up = db.prepare(`
    UPDATE bling_field_mappings SET moskit_source = ?, fallback_value = ?, updated_at = CURRENT_TIMESTAMP
    WHERE bling_field = ?
  `);
  for (const m of list || []) {
    // Só atualiza destinos conhecidos (evita criar campos que o código não usa)
    if (!m || !known.has(m.bling_field)) continue;
    up.run(String(m.moskit_source || ''), String(m.fallback_value || ''), m.bling_field);
  }
  return getMappings();
}

// ---------- Fila de pedidos ----------
function getOrderByDeal(dealId) {
  return db.prepare('SELECT * FROM bling_orders WHERE moskit_deal_id = ?').get(Number(dealId)) || null;
}

function listOrders(status = '') {
  const cols = `id, moskit_deal_id, deal_name, deal_value, origem, status, bling_pedido_id,
                bling_pedido_numero, last_error, created_at, updated_at, sent_at`;
  if (status && status !== 'todos') {
    return db.prepare(`SELECT ${cols} FROM bling_orders WHERE status = ? ORDER BY id DESC LIMIT 200`).all(status);
  }
  return db.prepare(`SELECT ${cols} FROM bling_orders ORDER BY id DESC LIMIT 200`).all();
}

// Insere na fila sem sobrescrever registros existentes (nunca "reabre" um enviado)
function enqueue(dealId, dealName, dealValue, origem) {
  db.prepare(`
    INSERT OR IGNORE INTO bling_orders (moskit_deal_id, deal_name, deal_value, origem, status)
    VALUES (?, ?, ?, ?, 'pendente')
  `).run(Number(dealId), dealName || '', Number(dealValue) || 0, origem || 'manual');
  // Atualiza apenas nome/valor de quem ainda não foi enviado
  db.prepare(`
    UPDATE bling_orders SET deal_name = ?, deal_value = ?, updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ? AND status IN ('pendente', 'erro')
  `).run(dealName || '', Number(dealValue) || 0, Number(dealId));
  return getOrderByDeal(dealId);
}

// Trava atômica: só um envio por vez e nunca reenviar um pedido já enviado
function tryLockForSending(dealId) {
  const r = db.prepare(`
    UPDATE bling_orders SET status = 'enviando', updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ? AND status IN ('pendente', 'erro')
  `).run(Number(dealId));
  return r.changes === 1;
}

// Se o processo cair no meio de um envio, o registro fica "enviando".
// Ao iniciar, devolvemos esses casos para "erro" (o reenvio checa o Bling antes de criar).
function releaseStaleLocks() {
  db.prepare(`
    UPDATE bling_orders SET status = 'erro',
      last_error = 'Envio interrompido (servidor reiniciado). Confira no Bling antes de reenviar; o sistema verifica duplicidade automaticamente.',
      updated_at = CURRENT_TIMESTAMP
    WHERE status = 'enviando'
  `).run();
}

function markSent(dealId, { pedidoId, pedidoNumero, contatoId, request, response }) {
  db.prepare(`
    UPDATE bling_orders SET status = 'enviado', bling_pedido_id = ?, bling_pedido_numero = ?,
      bling_contato_id = ?, last_error = NULL, request_json = ?, response_json = ?,
      sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ?
  `).run(
    pedidoId ? String(pedidoId) : null,
    pedidoNumero ? String(pedidoNumero) : null,
    contatoId ? String(contatoId) : null,
    request ? JSON.stringify(request) : null,
    response ? JSON.stringify(response) : null,
    Number(dealId)
  );
}

function markError(dealId, message, request, response) {
  db.prepare(`
    UPDATE bling_orders SET status = 'erro', last_error = ?, request_json = ?, response_json = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ?
  `).run(
    String(message || 'Erro desconhecido').slice(0, 4000),
    request ? JSON.stringify(request) : null,
    response ? JSON.stringify(response) : null,
    Number(dealId)
  );
}

function setStatus(dealId, status) {
  const allowed = ['pendente', 'ignorado'];
  if (!allowed.includes(status)) throw new Error('Status inválido.');
  // Pedido já enviado nunca muda de status por aqui
  const r = db.prepare(`
    UPDATE bling_orders SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ? AND status IN ('pendente', 'erro', 'ignorado')
  `).run(status, Number(dealId));
  return r.changes === 1;
}

function log(dealId, acao, detalhe) {
  try {
    db.prepare('INSERT INTO bling_log (moskit_deal_id, acao, detalhe) VALUES (?, ?, ?)')
      .run(dealId ? Number(dealId) : null, acao, typeof detalhe === 'string' ? detalhe.slice(0, 4000) : JSON.stringify(detalhe).slice(0, 4000));
  } catch (e) { /* log nunca derruba o fluxo */ }
}

function getLog(dealId) {
  return db.prepare('SELECT acao, detalhe, created_at FROM bling_log WHERE moskit_deal_id = ? ORDER BY id DESC LIMIT 50').all(Number(dealId));
}

module.exports = {
  getConfig,
  setConfig,
  getPublicConfig,
  getMappings,
  saveMappings,
  getOrderByDeal,
  listOrders,
  enqueue,
  tryLockForSending,
  releaseStaleLocks,
  markSent,
  markError,
  setStatus,
  log,
  getLog
};
