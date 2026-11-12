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
    { bling_field: 'contato.endereco', moskit_source: 'company.customFields.CF_dVKmQlU1C6vlAMWR || company.address || contact.customFields.CF_POEMyESeC56RZMdk', fallback_value: '' },
    { bling_field: 'contato.municipio', moskit_source: 'company.customFields.CF_2ojMxGUPCoWlaqOE || company.city || contact.customFields.CF_8P5q4aS2C4ObBMRJ', fallback_value: '' },
    { bling_field: 'contato.uf', moskit_source: 'company.customFields.CF_dVKmQlUbi6voQMWR || contact.customFields.CF_dVKmQASbi6voVmWR || company.state', fallback_value: '' },
    { bling_field: 'contato.numero', moskit_source: 'company.customFields.CF_Rg7MnpULCdaxjDvd || contact.customFields.CF_3LvDvKS4CLBQpq6a', fallback_value: '' },
    { bling_field: 'contato.complemento', moskit_source: 'company.customFields.CF_6rRmw4UvCJbllD4X || contact.customFields.CF_wGrqzySVCpj2ODLo', fallback_value: '' },
    { bling_field: 'contato.bairro', moskit_source: 'company.customFields.CF_VRAqd4UdCa5L3qbL || contact.customFields.CF_E79MrESoCejPjqZJ', fallback_value: '' },
    { bling_field: 'contato.cep', moskit_source: 'company.customFields.CF_Lo1qjxU1C4wgJmer || contact.customFields.CF_QJXmAjSjCydERD25', fallback_value: '' },
    { bling_field: 'contato.ie', moskit_source: '', fallback_value: '' },
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
  // 12/11/2026: UF (campo de escolha do Moskit, traduzido para a sigla) e endereço do contato como alternativa.
  // Só atualiza linhas ainda no valor configurado antes; personalizações diferentes são mantidas.
  const ajustes = [
    ['contato.uf', ['company.state'], 'company.customFields.CF_dVKmQlUbi6voQMWR || contact.customFields.CF_dVKmQASbi6voVmWR || company.state'],
    ['contato.endereco', ['company.customFields.CF_dVKmQlU1C6vlAMWR || company.address', 'company.address'], 'company.customFields.CF_dVKmQlU1C6vlAMWR || company.address || contact.customFields.CF_POEMyESeC56RZMdk'],
    ['contato.numero', ['company.customFields.CF_Rg7MnpULCdaxjDvd', 'company.number'], 'company.customFields.CF_Rg7MnpULCdaxjDvd || contact.customFields.CF_3LvDvKS4CLBQpq6a'],
    ['contato.complemento', ['company.customFields.CF_6rRmw4UvCJbllD4X', ''], 'company.customFields.CF_6rRmw4UvCJbllD4X || contact.customFields.CF_wGrqzySVCpj2ODLo'],
    ['contato.bairro', ['company.customFields.CF_VRAqd4UdCa5L3qbL', 'company.neighborhood'], 'company.customFields.CF_VRAqd4UdCa5L3qbL || contact.customFields.CF_E79MrESoCejPjqZJ'],
    ['contato.cep', ['company.customFields.CF_Lo1qjxU1C4wgJmer', 'company.zipCode'], 'company.customFields.CF_Lo1qjxU1C4wgJmer || contact.customFields.CF_QJXmAjSjCydERD25'],
    ['contato.municipio', ['company.customFields.CF_2ojMxGUPCoWlaqOE || company.city', 'company.city'], 'company.customFields.CF_2ojMxGUPCoWlaqOE || company.city || contact.customFields.CF_8P5q4aS2C4ObBMRJ']
  ];
  const mUpd = db.prepare('UPDATE bling_field_mappings SET moskit_source = ? WHERE bling_field = ? AND moskit_source = ?');
  for (const [campo, antigos, novo] of ajustes) for (const antigo of antigos) mUpd.run(novo, campo, antigo);
  for (const m of defaultMappings) {
    if (!mCheck.get(m.bling_field)) mIns.run(m.bling_field, m.moskit_source, m.fallback_value);
  }
}

initBlingTables();

// Histórico de importações e controle de alterações após o envio (aditivo)
db.exec(`
  CREATE TABLE IF NOT EXISTS bling_historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    moskit_deal_id INTEGER,
    origem TEXT,
    evento TEXT,
    resultado TEXT,
    mensagem TEXT,
    bling_pedido_id TEXT,
    bling_pedido_numero TEXT,
    payload_json TEXT,
    response_json TEXT,
    diff_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_bling_historico_deal ON bling_historico (moskit_deal_id, id);
`);
for (const col of ['pending_payload TEXT', 'pending_diff TEXT', 'pending_since DATETIME', 'discarded_signature TEXT', 'ultimo_status_moskit TEXT']) {
  try { db.exec(`ALTER TABLE bling_orders ADD COLUMN ${col};`); } catch (e) { /* já existe */ }
}
// Data de corte: só negócios ganhos a partir da ativação entram automaticamente
// (os anteriores já foram tratados pelo Pluga)
if (!db.prepare("SELECT key FROM bling_config WHERE key = 'envio_automatico_desde'").get()) {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  db.prepare("INSERT INTO bling_config (key, value) VALUES ('envio_automatico_desde', ?)").run(hoje);
}
if (!db.prepare("SELECT key FROM bling_config WHERE key = 'envio_automatico'").get()) {
  db.prepare("INSERT INTO bling_config (key, value) VALUES ('envio_automatico', 'true')").run();
}

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
const SECRET_KEYS = new Set(['client_secret', 'access_token', 'refresh_token', 'oauth_state', 'moskit_webhook_token', 'moskit_token_origem', 'smtp_senha']);

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
                bling_pedido_numero, last_error, created_at, updated_at, sent_at, pending_since`;
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
  db.prepare(`
    UPDATE bling_orders SET status = 'alteracao_pendente',
      last_error = 'Atualização interrompida (servidor reiniciado). Revise e autorize novamente.',
      updated_at = CURRENT_TIMESTAMP
    WHERE status = 'atualizando'
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

// ---------- Histórico ----------
function addHistory({ dealId, origem, evento, resultado, mensagem, pedidoId, pedidoNumero, payload, response, diff }) {
  try {
    const j = (v) => (v === undefined || v === null) ? null : JSON.stringify(v).slice(0, 200000);
    db.prepare(`
      INSERT INTO bling_historico (moskit_deal_id, origem, evento, resultado, mensagem, bling_pedido_id, bling_pedido_numero, payload_json, response_json, diff_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(dealId ? Number(dealId) : null, origem || null, evento || null, resultado || null,
      mensagem ? String(mensagem).slice(0, 4000) : null,
      pedidoId ? String(pedidoId) : null, pedidoNumero ? String(pedidoNumero) : null, j(payload), j(response), j(diff));
  } catch (e) { /* o histórico nunca derruba o fluxo */ }
}

function listHistory({ dealId, limite } = {}) {
  const lim = Math.min(500, Math.max(1, parseInt(limite, 10) || 200));
  const cols = 'id, moskit_deal_id, origem, evento, resultado, mensagem, bling_pedido_id, bling_pedido_numero, created_at, (payload_json IS NOT NULL OR response_json IS NOT NULL OR diff_json IS NOT NULL) AS tem_detalhes';
  if (dealId) return db.prepare(`SELECT ${cols} FROM bling_historico WHERE moskit_deal_id = ? ORDER BY id DESC LIMIT ?`).all(Number(dealId), lim);
  return db.prepare(`SELECT ${cols} FROM bling_historico ORDER BY id DESC LIMIT ?`).all(lim);
}

function getHistoryEntry(id) {
  const row = db.prepare('SELECT * FROM bling_historico WHERE id = ?').get(Number(id));
  if (!row) return null;
  for (const k of ['payload_json', 'response_json', 'diff_json']) {
    try { row[k] = row[k] ? JSON.parse(row[k]) : null; } catch (e) { /* mantém texto */ }
  }
  return row;
}

function lastHistoryFor(dealId) {
  return db.prepare('SELECT * FROM bling_historico WHERE moskit_deal_id = ? ORDER BY id DESC LIMIT 1').get(Number(dealId)) || null;
}

// ---------- Alterações depois do envio ----------
function setPendingChange(dealId, payload, diff) {
  db.prepare(`
    UPDATE bling_orders SET status = 'alteracao_pendente', pending_payload = ?, pending_diff = ?,
      pending_since = COALESCE(pending_since, CURRENT_TIMESTAMP), last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ? AND status IN ('enviado', 'alteracao_pendente')
  `).run(JSON.stringify(payload), JSON.stringify(diff), Number(dealId));
}

function clearPendingChange(dealId, { discardedSignature } = {}) {
  db.prepare(`
    UPDATE bling_orders SET status = 'enviado', pending_payload = NULL, pending_diff = NULL, pending_since = NULL,
      discarded_signature = COALESCE(?, discarded_signature), last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ? AND status IN ('alteracao_pendente', 'atualizando', 'enviado')
  `).run(discardedSignature || null, Number(dealId));
}

function tryLockForUpdate(dealId) {
  const r = db.prepare(`
    UPDATE bling_orders SET status = 'atualizando', updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ? AND status = 'alteracao_pendente'
  `).run(Number(dealId));
  return r.changes === 1;
}

function releaseUpdateLock(dealId, errorMessage) {
  db.prepare(`
    UPDATE bling_orders SET status = 'alteracao_pendente', last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ? AND status = 'atualizando'
  `).run(errorMessage ? String(errorMessage).slice(0, 4000) : null, Number(dealId));
}

function markUpdated(dealId, { contatoId, request, response }) {
  db.prepare(`
    UPDATE bling_orders SET status = 'enviado', request_json = ?, response_json = ?, bling_contato_id = COALESCE(?, bling_contato_id),
      pending_payload = NULL, pending_diff = NULL, pending_since = NULL, discarded_signature = NULL,
      last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ?
  `).run(JSON.stringify(request), response ? JSON.stringify(response) : null, contatoId ? String(contatoId) : null, Number(dealId));
}

function setBlocked(dealId, status, message) {
  // Usado pelo envio automático: negócio não enviado por pendência (fica na fila com o motivo)
  if (!['pendente', 'erro'].includes(status)) throw new Error('Status inválido.');
  db.prepare(`
    UPDATE bling_orders SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE moskit_deal_id = ? AND status IN ('pendente', 'erro')
  `).run(status, String(message || '').slice(0, 4000), Number(dealId));
}

function setMoskitStatus(dealId, status) {
  db.prepare('UPDATE bling_orders SET ultimo_status_moskit = ? WHERE moskit_deal_id = ?').run(status ? String(status) : null, Number(dealId));
}

module.exports = {
  addHistory,
  listHistory,
  getHistoryEntry,
  lastHistoryFor,
  setPendingChange,
  clearPendingChange,
  tryLockForUpdate,
  releaseUpdateLock,
  markUpdated,
  setBlocked,
  setMoskitStatus,
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
