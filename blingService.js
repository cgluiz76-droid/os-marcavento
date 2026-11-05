// blingService.js - Integração Moskit CRM -> Bling ERP (API v3)
//
// Fluxo:
//   1. buildPreview(dealId): lê o negócio no Moskit (mesma função usada pela O.S.),
//      aplica o mapeamento ORIGEM -> DESTINO e consulta o Bling (contato, produtos,
//      duplicidades). NÃO grava nada no Bling.
//   2. sendDeal(dealId): refaz o preview no servidor (nunca confia no navegador),
//      trava o registro, cria o contato se necessário e cria o pedido "Em aberto".
//
// Proteções contra pedido duplicado:
//   - bling_orders.moskit_deal_id é UNIQUE e a trava de envio é atômica;
//   - o pedido leva numeroLoja = "MOSKIT-<id>" e, antes de criar, o Bling é consultado
//     por esse número;
//   - alerta de possível duplicidade com pedidos do mesmo cliente e mesmo total
//     (ex.: pedido já criado pelo Pluga).

const crypto = require('crypto');
const moskitService = require('./moskitService');
const blingDb = require('./blingDb');

const BLING_API = process.env.BLING_API_URL || 'https://api.bling.com.br/Api/v3';
const BLING_AUTHORIZE_URL = process.env.BLING_AUTHORIZE_URL || 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL = process.env.BLING_TOKEN_URL || 'https://api.bling.com.br/Api/v3/oauth/token';

// ==========================================================
// Utilidades
// ==========================================================

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseNumber(v, def = 0) {
  if (v === null || v === undefined || v === '') return def;
  if (typeof v === 'number') return Number.isFinite(v) ? v : def;
  let s = String(v).trim().replace(/[^\d,.-]/g, '');
  // "1.234,56" -> "1234.56"; "4,5" -> "4.5"
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : def;
}

// Data de hoje no fuso de São Paulo (YYYY-MM-DD)
function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

// Converte "2026-11-04T13:00:00Z", "2026-11-04" ou "04/11/2026" para "2026-11-04"
function toIsoDate(value) {
  if (!value) return '';
  const s = String(value).trim();
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + (Number(days) || 0)));
  return dt.toISOString().slice(0, 10);
}

function formatBr(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate || '';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

// ==========================================================
// OAuth 2.0 (Bling API v3)
// ==========================================================

function getClientCredentials() {
  const clientId = process.env.BLING_CLIENT_ID || blingDb.getConfig('client_id', '');
  const clientSecret = process.env.BLING_CLIENT_SECRET || blingDb.getConfig('client_secret', '');
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

function getAuthStatus() {
  const { clientId, clientSecret } = getClientCredentials();
  const refresh = blingDb.getConfig('refresh_token', '');
  const expiresAt = Number(blingDb.getConfig('token_expires_at', '0')) || 0;
  return {
    credenciaisConfiguradas: Boolean(clientId && clientSecret),
    credenciaisViaAmbiente: Boolean(process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET),
    clientIdFinal: clientId ? clientId.slice(-4) : '',
    conectado: Boolean(refresh),
    accessTokenExpiraEm: expiresAt ? new Date(expiresAt).toISOString() : null,
    ultimaConexao: blingDb.getConfig('connected_at', '') || null,
    reconexaoNecessaria: blingDb.getConfig('reconnect_required', '') === 'true'
  };
}

function startAuthorization() {
  const { clientId, clientSecret } = getClientCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('Informe o Client ID e o Client Secret do aplicativo Bling antes de conectar.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  blingDb.setConfig('oauth_state', `${state}:${Date.now()}`);
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, state });
  return `${BLING_AUTHORIZE_URL}?${params.toString()}`;
}

async function tokenRequest(form) {
  const { clientId, clientSecret } = getClientCredentials();
  if (!clientId || !clientSecret) throw new Error('Credenciais do aplicativo Bling não configuradas.');

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch(BLING_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'enable-jwt': '1'
    },
    body: new URLSearchParams(form).toString()
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* resposta não-JSON */ }

  if (!resp.ok || !json || !json.access_token) {
    const msg = (json && json.error && (json.error.description || json.error.message)) || text.slice(0, 300) || resp.statusText;
    const err = new Error(`Bling recusou a autenticação (${resp.status}): ${msg}`);
    err.status = resp.status;
    throw err;
  }

  blingDb.setConfig('access_token', json.access_token);
  // O Bling devolve um novo refresh_token a cada renovação: sempre salvar o mais recente
  if (json.refresh_token) blingDb.setConfig('refresh_token', json.refresh_token);
  const expiresIn = Number(json.expires_in) || 21600;
  blingDb.setConfig('token_expires_at', String(Date.now() + expiresIn * 1000));
  blingDb.setConfig('reconnect_required', 'false');
  return json;
}

async function handleCallback(code, state) {
  const saved = blingDb.getConfig('oauth_state', '');
  const [savedState, savedAt] = saved.split(':');
  blingDb.setConfig('oauth_state', ''); // uso único
  if (!code) throw new Error('O Bling não retornou o código de autorização.');
  if (!state || !savedState || state !== savedState) {
    throw new Error('Retorno de autorização inválido (state não confere). Inicie a conexão novamente pelo sistema.');
  }
  if (Date.now() - Number(savedAt || 0) > 15 * 60 * 1000) {
    throw new Error('A autorização expirou (mais de 15 minutos). Inicie a conexão novamente.');
  }
  await tokenRequest({ grant_type: 'authorization_code', code });
  blingDb.setConfig('connected_at', new Date().toISOString());
  blingDb.log(null, 'oauth_conectado', 'Conta Bling conectada com sucesso.');
}

// Renovação sob demanda (funciona mesmo com a máquina do Fly.io "dormindo")
let refreshInFlight = null;

async function refreshAccessToken() {
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = blingDb.getConfig('refresh_token', '');
  if (!refreshToken) throw new Error('O sistema ainda não está conectado ao Bling. Clique em "Conectar ao Bling".');

  refreshInFlight = (async () => {
    try {
      const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
      return json.access_token;
    } catch (err) {
      if (err.status === 400 || err.status === 401) {
        blingDb.setConfig('reconnect_required', 'true');
        blingDb.log(null, 'oauth_erro', err.message);
        throw new Error('A conexão com o Bling expirou ou foi revogada. Clique em "Conectar ao Bling" novamente.');
      }
      throw err;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function getAccessToken() {
  const token = blingDb.getConfig('access_token', '');
  const expiresAt = Number(blingDb.getConfig('token_expires_at', '0')) || 0;
  if (token && expiresAt - Date.now() > 5 * 60 * 1000) return token;
  return refreshAccessToken();
}

// ==========================================================
// Cliente HTTP do Bling (limite: 3 requisições/segundo)
// ==========================================================

let lastCallAt = 0;
let throttleChain = Promise.resolve();

function throttle() {
  throttleChain = throttleChain.then(async () => {
    const wait = 400 - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  return throttleChain;
}

function formatBlingError(json, fallback) {
  if (!json || !json.error) return fallback;
  const e = json.error;
  const parts = [e.description || e.message || e.type || fallback];
  if (Array.isArray(e.fields)) {
    for (const f of e.fields) {
      const field = f.element || f.namespace || '';
      parts.push(`${field ? field + ': ' : ''}${f.msg || f.message || ''}`.trim());
    }
  }
  return parts.filter(Boolean).join(' | ');
}

// query: objeto; arrays viram "chave[]=a&chave[]=b"
async function blingFetch(method, endpoint, { query, body } = {}, attempt = 1) {
  await throttle();
  const token = await getAccessToken();

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach(x => qs.append(`${k}[]`, String(x)));
    else qs.append(k, String(v));
  }
  const url = `${BLING_API}${endpoint}${qs.toString() ? '?' + qs.toString() : ''}`;

  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'enable-jwt': '1'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
  } catch (netErr) {
    const err = new Error(`Falha de comunicação com o Bling: ${netErr.message}`);
    err.network = true;
    throw err;
  }

  if (resp.status === 401 && attempt === 1) {
    await refreshAccessToken();
    return blingFetch(method, endpoint, { query, body }, 2);
  }
  // Limite de requisições: apenas leituras são repetidas automaticamente.
  // Escritas (POST/PATCH) NUNCA são repetidas sozinhas, para não duplicar registros.
  if (resp.status === 429 && method === 'GET' && attempt <= 3) {
    await new Promise(r => setTimeout(r, 1200 * attempt));
    return blingFetch(method, endpoint, { query, body }, attempt + 1);
  }

  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = null; }

  if (!resp.ok) {
    const base = formatBlingError(json, text.slice(0, 300) || resp.statusText);
    const hint = resp.status === 403 ? ` [${method} ${endpoint}: o aplicativo do Bling não tem permissão para este recurso]` : '';
    const err = new Error(`Bling (${resp.status}): ${base}${hint}`);
    err.status = resp.status;
    err.response = json || text;
    throw err;
  }
  return json || {};
}

// ==========================================================
// Consultas no Bling (somente leitura)
// ==========================================================

async function findContactByDocument(docDigits) {
  if (!docDigits) return [];
  const res = await blingFetch('GET', '/contatos', { query: { numeroDocumento: docDigits, limite: 100 } });
  const list = Array.isArray(res.data) ? res.data : [];
  // Só aceita correspondência EXATA do documento (nunca usar um contato "parecido")
  return list.filter(c => onlyDigits(c.numeroDocumento) === docDigits);
}

async function findProductsByCodes(codes) {
  const unique = [...new Set(codes.filter(Boolean))];
  const map = {};
  if (!unique.length) return map;
  // Até 50 códigos por consulta
  for (let i = 0; i < unique.length; i += 50) {
    const slice = unique.slice(i, i + 50);
    const res = await blingFetch('GET', '/produtos', { query: { codigos: slice, criterio: 5, limite: 100 } });
    for (const p of (Array.isArray(res.data) ? res.data : [])) {
      const key = String(p.codigo || '').trim().toUpperCase();
      if (key && !map[key]) map[key] = p;
    }
  }
  return map;
}

async function findOrdersByNumeroLoja(numeroLoja) {
  const res = await blingFetch('GET', '/pedidos/vendas', { query: { numerosLojas: [numeroLoja], limite: 100 } });
  return (Array.isArray(res.data) ? res.data : []).filter(p => String(p.numeroLoja || '') === numeroLoja);
}

async function findRecentOrdersByContact(contactId, sinceIso) {
  const res = await blingFetch('GET', '/pedidos/vendas', { query: { idContato: contactId, dataInicial: sinceIso, limite: 100 } });
  return Array.isArray(res.data) ? res.data : [];
}

async function listSituacoesVendas() {
  const mods = await blingFetch('GET', '/situacoes/modulos');
  const vendas = (mods.data || []).find(m => String(m.nome).toLowerCase() === 'vendas');
  if (!vendas) return [];
  const res = await blingFetch('GET', `/situacoes/modulos/${vendas.id}`);
  return Array.isArray(res.data) ? res.data : [];
}

async function listFormasPagamento() {
  const res = await blingFetch('GET', '/formas-pagamentos', { query: { limite: 100 } });
  return Array.isArray(res.data) ? res.data : [];
}

async function listVendedores() {
  const res = await blingFetch('GET', '/vendedores', { query: { limite: 100, situacaoContato: 'A' } });
  return Array.isArray(res.data) ? res.data : [];
}

// ==========================================================
// Montagem do pedido (preview ORIGEM -> DESTINO)
// ==========================================================

function buildContext(deal) {
  // Mesma normalização de campos personalizados usada pela O.S.
  const flatCustomFields = {};
  if (Array.isArray(deal.customFields)) {
    for (const cf of deal.customFields) {
      const k = cf.customField ? (cf.customField.id || cf.customField.key || cf.customField.name) : (cf.id || cf.key);
      const val = cf.value !== undefined ? cf.value : (cf.textValue || cf.numericValue || cf.dateValue);
      if (k) flatCustomFields[k] = val;
    }
  } else if (deal.customFields && typeof deal.customFields === 'object') {
    Object.assign(flatCustomFields, deal.customFields);
  }
  return {
    deal,
    company: deal.company || {},
    contact: deal.contact || {},
    customFields: flatCustomFields
  };
}

const FIELD_LABELS = {
  'contato.numeroDocumento': 'Cliente: CPF/CNPJ',
  'contato.nome': 'Cliente: Nome / Razão Social',
  'contato.fantasia': 'Cliente: Nome Fantasia',
  'contato.email': 'Cliente: E-mail',
  'contato.telefone': 'Cliente: Telefone',
  'contato.endereco': 'Cliente: Endereço',
  'contato.municipio': 'Cliente: Município',
  'contato.uf': 'Cliente: UF',
  'pedido.data': 'Pedido: Data',
  'pedido.dataPrevista': 'Pedido: Data Prevista (entrega)',
  'pedido.observacoes': 'Pedido: Observações',
  'pedido.numeroPedidoCompra': 'Pedido: Nº Pedido de Compra',
  'item.codigo': 'Item: Código (SKU)',
  'item.quantidade': 'Item: Quantidade',
  'item.valor': 'Item: Valor Unitário'
};

async function buildPreview(dealId) {
  const id = Number(String(dealId).trim());
  if (!Number.isInteger(id) || id <= 0) throw new Error('Número do negócio inválido.');

  const erros = [];
  const avisos = [];
  const linhas = [];

  // 1) Moskit (leitura) - mesma função já usada pela O.S.
  const deal = await moskitService.fetchFullDeal(id);
  const ctx = buildContext(deal);
  const mappings = blingDb.getMappings();
  const mapBy = Object.fromEntries(mappings.map(m => [m.bling_field, m]));

  function val(field) {
    const m = mapBy[field];
    if (!m) return '';
    if (!m.moskit_source) return m.fallback_value || '';
    return moskitService.resolvePath(ctx, m.moskit_source, m.fallback_value || '');
  }
  function addLinha(grupo, field, valor, nivel = 'ok', nota = '') {
    const m = mapBy[field];
    linhas.push({
      grupo,
      destino: field,
      destinoLabel: FIELD_LABELS[field] || field,
      origem: m ? (m.moskit_source || (m.fallback_value ? `(valor fixo)` : '(não mapeado)')) : '(automático)',
      valor: valor === undefined || valor === null ? '' : String(valor),
      nivel,
      nota
    });
  }

  const status = String(deal.status || '').toUpperCase();
  if (status && status !== 'WON' && status !== 'GANHOU') {
    avisos.push(`O negócio está com status "${deal.status}" no Moskit (não está como Ganhou).`);
  }

  // 2) Cliente
  const docDigits = onlyDigits(val('contato.numeroDocumento'));
  const nome = val('contato.nome');
  const contatoInfo = { acao: null, id: null, nome: '', numeroDocumento: docDigits };

  if (!docDigits) {
    erros.push('Negócio sem CPF/CNPJ do cliente. Preencha no Moskit (empresa ou contato) para identificar o cliente no Bling.');
    addLinha('Cliente', 'contato.numeroDocumento', '', 'erro', 'Obrigatório');
  } else if (docDigits.length !== 11 && docDigits.length !== 14) {
    erros.push(`CPF/CNPJ "${docDigits}" com tamanho inválido (${docDigits.length} dígitos).`);
    addLinha('Cliente', 'contato.numeroDocumento', docDigits, 'erro', 'Tamanho inválido');
  } else {
    const found = await findContactByDocument(docDigits);
    if (found.length) {
      contatoInfo.acao = 'existente';
      contatoInfo.id = found[0].id;
      contatoInfo.nome = found[0].nome;
      addLinha('Cliente', 'contato.numeroDocumento', docDigits, 'ok', `Cliente já cadastrado no Bling: ${found[0].nome} (id ${found[0].id})`);
      if (found.length > 1) avisos.push(`Existem ${found.length} contatos no Bling com o documento ${docDigits}. Será usado: ${found[0].nome} (id ${found[0].id}).`);
    } else {
      contatoInfo.acao = 'criar';
      contatoInfo.nome = nome;
      addLinha('Cliente', 'contato.numeroDocumento', docDigits, 'aviso', 'Cliente NÃO encontrado no Bling: será cadastrado');
      avisos.push(`O cliente ${nome || docDigits} não existe no Bling e será cadastrado com os dados do Moskit. Revise endereço e Inscrição Estadual no Bling antes de emitir NF-e.`);
      if (!nome) erros.push('Cliente novo sem nome/razão social no Moskit.');
    }
  }

  const contatoPayload = contatoInfo.acao === 'criar' ? (() => {
    const p = {
      nome: nome,
      tipo: docDigits.length === 14 ? 'J' : 'F',
      situacao: 'A',
      numeroDocumento: docDigits
    };
    const fantasia = val('contato.fantasia');
    const email = val('contato.email');
    const telefone = val('contato.telefone');
    const endereco = val('contato.endereco');
    const municipio = val('contato.municipio');
    const uf = val('contato.uf');
    if (fantasia) p.fantasia = fantasia;
    if (email) p.email = email;
    if (telefone) p.telefone = telefone;
    if (endereco || municipio || uf) {
      p.endereco = { geral: {} };
      if (endereco) p.endereco.geral.endereco = endereco;
      if (municipio) p.endereco.geral.municipio = municipio;
      if (uf) p.endereco.geral.uf = String(uf).slice(0, 2).toUpperCase();
    }
    return p;
  })() : null;

  if (contatoInfo.acao === 'criar') {
    for (const f of ['contato.nome', 'contato.fantasia', 'contato.email', 'contato.telefone', 'contato.endereco', 'contato.municipio', 'contato.uf']) {
      addLinha('Cliente (cadastro novo)', f, val(f), val(f) || f !== 'contato.nome' ? 'ok' : 'erro');
    }
  } else {
    addLinha('Cliente', 'contato.nome', contatoInfo.nome || nome, 'ok', contatoInfo.acao === 'existente' ? 'Nome conforme cadastro do Bling' : '');
  }

  // 3) Itens
  const rawProducts = Array.isArray(deal.dealProducts) ? deal.dealProducts : (Array.isArray(deal.products) ? deal.products : []);
  if (!rawProducts.length) erros.push('O negócio não tem produtos no Moskit.');

  const itensPre = rawProducts.map((dp, idx) => {
    const pctx = { dealProduct: dp, product: dp.product || {}, customFields: dp.customFields || {} };
    const resolveItem = (field) => {
      const m = mapBy[field];
      if (!m) return '';
      if (!m.moskit_source) return m.fallback_value || '';
      return moskitService.resolvePath(pctx, m.moskit_source, m.fallback_value || '');
    };
    return {
      ordem: idx + 1,
      codigo: String(resolveItem('item.codigo') || '').trim().toUpperCase(),
      nomeMoskit: (dp.product && dp.product.name) || dp.name || '',
      quantidade: parseNumber(resolveItem('item.quantidade'), 1),
      valor: round2(parseNumber(resolveItem('item.valor'), 0))
    };
  });

  const productMap = await findProductsByCodes(itensPre.map(i => i.codigo));
  const itens = itensPre.map(i => {
    const p = i.codigo ? productMap[i.codigo] : null;
    const item = {
      ...i,
      subtotal: round2(i.quantidade * i.valor),
      blingProdutoId: p ? p.id : null,
      descricao: p ? p.nome : i.nomeMoskit,
      nivel: 'ok',
      nota: p ? `Produto Bling id ${p.id}` : ''
    };
    if (!i.codigo) {
      item.nivel = 'erro';
      item.nota = 'Produto sem SKU no Moskit';
      erros.push(`Item ${i.ordem} (${i.nomeMoskit || 'sem nome'}) não tem SKU no Moskit.`);
    } else if (!p) {
      item.nivel = 'erro';
      item.nota = 'SKU não encontrado no Bling';
      erros.push(`O SKU ${i.codigo} (item ${i.ordem}) não existe no cadastro de produtos do Bling.`);
    } else if (p.situacao && p.situacao !== 'A') {
      item.nivel = 'aviso';
      item.nota = `Produto no Bling com situação "${p.situacao}" (não ativo)`;
      avisos.push(`O produto ${i.codigo} está inativo no Bling.`);
    }
    if (!(i.quantidade > 0)) {
      item.nivel = 'erro';
      item.nota = 'Quantidade inválida';
      erros.push(`Item ${i.ordem} (${i.codigo}) com quantidade inválida.`);
    }
    if (!(i.valor > 0)) {
      if (item.nivel === 'ok') item.nivel = 'aviso';
      item.nota = (item.nota ? item.nota + ' · ' : '') + 'Valor zerado';
      avisos.push(`Item ${i.ordem} (${i.codigo}) está com valor R$ 0,00.`);
    }
    return item;
  });

  const total = round2(itens.reduce((s, i) => s + i.subtotal, 0));
  const dealPrice = round2(parseNumber(deal.price, 0));
  if (dealPrice > 0 && Math.abs(dealPrice - total) > 0.01) {
    avisos.push(`A soma dos itens (R$ ${total.toFixed(2)}) é diferente do valor do negócio no Moskit (R$ ${dealPrice.toFixed(2)}). Verifique descontos/frete.`);
  }

  // 4) Cabeçalho do pedido
  const dataPedido = toIsoDate(val('pedido.data')) || todayIso();
  const dataPrevista = toIsoDate(val('pedido.dataPrevista'));
  const prazoDias = parseInt(blingDb.getConfig('prazo_dias', '30'), 10);
  const prazo = Number.isFinite(prazoDias) && prazoDias >= 0 ? prazoDias : 30;
  const vencimento = addDays(dataPedido, prazo);
  const situacaoId = parseInt(blingDb.getConfig('situacao_id', '6'), 10) || 6;
  const prefixo = blingDb.getConfig('numero_loja_prefixo', 'MOSKIT-');
  const numeroLoja = `${prefixo}${id}`;
  const observacoes = val('pedido.observacoes');
  const numeroPedidoCompra = val('pedido.numeroPedidoCompra');

  addLinha('Pedido', 'pedido.data', formatBr(dataPedido), 'ok', val('pedido.data') ? '' : 'Sem data no Moskit: usando hoje');
  addLinha('Pedido', 'pedido.dataPrevista', formatBr(dataPrevista), 'ok', dataPrevista ? '' : 'Não informada');
  if (observacoes) addLinha('Pedido', 'pedido.observacoes', observacoes);
  if (numeroPedidoCompra) addLinha('Pedido', 'pedido.numeroPedidoCompra', numeroPedidoCompra);
  linhas.push({ grupo: 'Pedido', destino: 'numeroLoja', destinoLabel: 'Pedido: Nº na Loja (controle anti-duplicidade)', origem: 'deal.id', valor: numeroLoja, nivel: 'ok', nota: '' });
  linhas.push({ grupo: 'Pedido', destino: 'situacao.id', destinoLabel: 'Pedido: Situação', origem: '(configuração)', valor: situacaoId === 6 ? 'Em aberto (6)' : String(situacaoId), nivel: 'ok', nota: '' });
  linhas.push({ grupo: 'Pagamento', destino: 'parcelas[0]', destinoLabel: 'Parcela única', origem: '(configuração)', valor: `R$ ${total.toFixed(2)} · vencimento ${formatBr(vencimento)} (${prazo} dias)`, nivel: 'ok', nota: '' });

  // 5) Duplicidade
  let pedidoExistente = null;
  const existentes = await findOrdersByNumeroLoja(numeroLoja);
  if (existentes.length) {
    pedidoExistente = existentes[0];
    erros.push(`Este negócio JÁ foi enviado ao Bling: pedido nº ${existentes[0].numero} (id ${existentes[0].id}).`);
  }
  if (!pedidoExistente && contatoInfo.acao === 'existente' && total > 0) {
    const desde = addDays(dataPedido, -10);
    const recentes = await findRecentOrdersByContact(contatoInfo.id, desde);
    const parecidos = recentes.filter(p => Math.abs(round2(p.total) - total) <= 0.01);
    for (const p of parecidos) {
      avisos.push(`POSSÍVEL DUPLICIDADE: já existe o pedido nº ${p.numero} de ${formatBr(p.data)} para este cliente com o mesmo total (R$ ${total.toFixed(2)}). Pode ter sido criado pelo Pluga.`);
    }
  }

  // 6) Payload final (o contato.id é preenchido no envio caso o cliente seja novo)
  const payload = {
    numeroLoja,
    data: dataPedido,
    dataSaida: dataPedido,
    contato: { id: contatoInfo.id || 0 },
    situacao: { id: situacaoId },
    itens: itens.map(i => {
      const it = {
        codigo: i.codigo,
        descricao: i.descricao,
        quantidade: i.quantidade,
        valor: i.valor
      };
      if (i.blingProdutoId) it.produto = { id: i.blingProdutoId };
      return it;
    }),
    parcelas: [(() => {
      const p = { dataVencimento: vencimento, valor: total };
      const fp = parseInt(blingDb.getConfig('forma_pagamento_id', ''), 10);
      if (fp) p.formaPagamento = { id: fp };
      return p;
    })()],
    observacoesInternas: `Criado via OS Marca Vento a partir do negócio Moskit #${id}`
  };
  if (dataPrevista) payload.dataPrevista = dataPrevista;
  if (observacoes) payload.observacoes = observacoes;
  if (numeroPedidoCompra) payload.numeroPedidoCompra = numeroPedidoCompra;
  const vendedorId = parseInt(blingDb.getConfig('vendedor_id', ''), 10);
  if (vendedorId) payload.vendedor = { id: vendedorId };
  const categoriaId = parseInt(blingDb.getConfig('categoria_id', ''), 10);
  if (categoriaId) payload.categoria = { id: categoriaId };
  const lojaId = parseInt(blingDb.getConfig('loja_id', ''), 10);
  if (lojaId) payload.loja = { id: lojaId };

  return {
    deal: {
      id,
      nome: deal.name || '',
      valor: dealPrice,
      status: deal.status || '',
      responsavel: (deal.user && deal.user.name) || (deal.responsible && deal.responsible.name) || ''
    },
    contato: contatoInfo,
    contatoPayload,
    linhas,
    itens,
    total,
    erros,
    avisos,
    pedidoExistente,
    payload,
    fila: blingDb.getOrderByDeal(id)
  };
}

// ==========================================================
// Envio ao Bling
// ==========================================================

async function sendDeal(dealId, { confirmarAvisos = false, origem = 'manual' } = {}) {
  const id = Number(String(dealId).trim());
  const preview = await buildPreview(id);
  blingDb.enqueue(id, preview.deal.nome, preview.total || preview.deal.valor, origem);

  const fila = blingDb.getOrderByDeal(id);
  if (fila && fila.status === 'enviado') {
    return { ok: false, codigo: 'ja_enviado', mensagem: `Este negócio já foi enviado (pedido Bling nº ${fila.bling_pedido_numero || fila.bling_pedido_id}).`, preview };
  }
  // Pedido já existe no Bling (ex.: envio anterior interrompido): registra e não cria outro
  if (preview.pedidoExistente && blingDb.tryLockForSending(id)) {
    const pe = preview.pedidoExistente;
    blingDb.markSent(id, { pedidoId: pe.id, pedidoNumero: pe.numero, contatoId: preview.contato.id, request: null, response: { recuperado: pe } });
    blingDb.log(id, 'recuperado', `Pedido já existia no Bling (nº ${pe.numero}); registro marcado como enviado.`);
    return { ok: false, codigo: 'ja_enviado', mensagem: `Este negócio já tem pedido no Bling (nº ${pe.numero}). Nada foi criado.`, preview };
  }
  if (preview.erros.length) {
    return { ok: false, codigo: 'erros', mensagem: 'Há pendências que impedem o envio.', preview };
  }
  if (preview.avisos.length && !confirmarAvisos) {
    return { ok: false, codigo: 'confirmar_avisos', mensagem: 'Confirme os avisos antes de enviar.', preview };
  }

  if (!blingDb.tryLockForSending(id)) {
    const atual = blingDb.getOrderByDeal(id);
    return { ok: false, codigo: 'bloqueado', mensagem: `Não foi possível enviar: o registro está "${atual ? atual.status : 'desconhecido'}". Atualize a tela.`, preview };
  }

  const payload = JSON.parse(JSON.stringify(preview.payload));
  let contatoId = preview.contato.id;
  let createdContact = null;

  try {
    // Checagem final de duplicidade, já com a trava ativa
    const dup = await findOrdersByNumeroLoja(payload.numeroLoja);
    if (dup.length) {
      blingDb.markSent(id, { pedidoId: dup[0].id, pedidoNumero: dup[0].numero, contatoId, request: null, response: { recuperado: dup[0] } });
      blingDb.log(id, 'recuperado', `Pedido já existia no Bling (nº ${dup[0].numero}); registro marcado como enviado.`);
      return { ok: true, recuperado: true, pedido: { id: dup[0].id, numero: dup[0].numero } };
    }

    if (preview.contato.acao === 'criar') {
      // Revalida: o contato pode ter sido criado por outra pessoa nesse meio-tempo
      const again = await findContactByDocument(preview.contato.numeroDocumento);
      if (again.length) {
        contatoId = again[0].id;
      } else {
        const res = await blingFetch('POST', '/contatos', { body: preview.contatoPayload });
        contatoId = res.data && res.data.id;
        createdContact = res;
        if (!contatoId) throw new Error('O Bling não retornou o id do contato criado.');
        blingDb.log(id, 'contato_criado', `Contato ${preview.contatoPayload.nome} criado no Bling (id ${contatoId}).`);
      }
    }
    payload.contato = { id: contatoId };

    let res;
    try {
      res = await blingFetch('POST', '/pedidos/vendas', { body: payload });
    } catch (postErr) {
      // Em falha de rede não sabemos se o Bling criou o pedido: confere antes de devolver erro
      if (postErr.network) {
        const check = await findOrdersByNumeroLoja(payload.numeroLoja).catch(() => []);
        if (check.length) {
          blingDb.markSent(id, { pedidoId: check[0].id, pedidoNumero: check[0].numero, contatoId, request: payload, response: { recuperado: check[0] } });
          blingDb.log(id, 'enviado', `Pedido nº ${check[0].numero} confirmado após falha de rede.`);
          return { ok: true, pedido: { id: check[0].id, numero: check[0].numero } };
        }
      }
      throw postErr;
    }

    const pedidoId = res.data && res.data.id;
    if (!pedidoId) throw Object.assign(new Error('O Bling não retornou o id do pedido criado.'), { response: res });

    // Confirma o pedido criado (número e situação)
    let numero = null;
    try {
      const det = await blingFetch('GET', `/pedidos/vendas/${pedidoId}`);
      numero = det.data && det.data.numero;
      const sit = det.data && det.data.situacao && det.data.situacao.id;
      if (sit && Number(sit) !== Number(payload.situacao.id)) {
        await blingFetch('PATCH', `/pedidos/vendas/${pedidoId}/situacoes/${payload.situacao.id}`);
        blingDb.log(id, 'situacao_ajustada', `Situação ajustada de ${sit} para ${payload.situacao.id}.`);
      }
    } catch (e) {
      blingDb.log(id, 'aviso', `Pedido criado (id ${pedidoId}), mas a confirmação falhou: ${e.message}`);
    }

    blingDb.markSent(id, { pedidoId, pedidoNumero: numero, contatoId, request: payload, response: res });
    blingDb.log(id, 'enviado', `Pedido Bling nº ${numero || '?'} (id ${pedidoId}) criado.`);
    return { ok: true, pedido: { id: pedidoId, numero }, contatoCriado: Boolean(createdContact) };
  } catch (err) {
    blingDb.markError(id, err.message, payload, err.response || null);
    blingDb.log(id, 'erro', err.message);
    return { ok: false, codigo: 'falha_envio', mensagem: err.message, preview };
  }
}

// Testa, só com leituras, se o aplicativo tem permissão para cada recurso usado
async function diagnosticarPermissoes() {
  const testes = [
    { recurso: 'Contatos (consultar)', usado: 'Identificar o cliente pelo CPF/CNPJ', endpoint: '/contatos', query: { limite: 1 } },
    { recurso: 'Produtos (consultar)', usado: 'Encontrar os produtos pelo SKU', endpoint: '/produtos', query: { limite: 1 } },
    { recurso: 'Pedidos de Venda (consultar)', usado: 'Evitar pedidos duplicados', endpoint: '/pedidos/vendas', query: { limite: 1 } },
    { recurso: 'Situações (consultar)', usado: 'Listar as situações na Configuração (opcional)', endpoint: '/situacoes/modulos' },
    { recurso: 'Formas de Pagamento (consultar)', usado: 'Lista da Configuração (opcional)', endpoint: '/formas-pagamentos', query: { limite: 1 } },
    { recurso: 'Vendedores (consultar)', usado: 'Lista da Configuração (opcional)', endpoint: '/vendedores', query: { limite: 1 } }
  ];
  const resultados = [];
  for (const t of testes) {
    try {
      await blingFetch('GET', t.endpoint, { query: t.query });
      resultados.push({ recurso: t.recurso, usado: t.usado, ok: true });
    } catch (e) {
      resultados.push({ recurso: t.recurso, usado: t.usado, ok: false, status: e.status || null, erro: e.message });
    }
  }
  return resultados;
}

module.exports = {
  diagnosticarPermissoes,
  // OAuth
  getAuthStatus,
  startAuthorization,
  handleCallback,
  // Consultas auxiliares (telas de configuração)
  listSituacoesVendas,
  listFormasPagamento,
  listVendedores,
  // Fluxo principal
  buildPreview,
  sendDeal,
  // Exportado para testes
  _internals: { toIsoDate, parseNumber, addDays, onlyDigits, buildContext }
};
