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
const osDb = require('./db');
const emailService = require('./emailService');

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
  const isoPrefix = s.match(/^(\d{4}-\d{2}-\d{2})(?:$|T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?$)/);
  if (isoPrefix) return isoPrefix[1];
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

// UF pelo CEP (faixas dos Correios), usada quando o Moskit não informa a UF
const CEP_UF = [
  [1000, 19999, 'SP'], [20000, 28999, 'RJ'], [29000, 29999, 'ES'], [30000, 39999, 'MG'], [40000, 48999, 'BA'],
  [49000, 49999, 'SE'], [50000, 56999, 'PE'], [57000, 57999, 'AL'], [58000, 58999, 'PB'], [59000, 59999, 'RN'],
  [60000, 63999, 'CE'], [64000, 64999, 'PI'], [65000, 65999, 'MA'], [66000, 68899, 'PA'], [68900, 68999, 'AP'],
  [69000, 69299, 'AM'], [69300, 69399, 'RR'], [69400, 69899, 'AM'], [69900, 69999, 'AC'], [70000, 72799, 'DF'],
  [72800, 72999, 'GO'], [73000, 73699, 'DF'], [73700, 76799, 'GO'], [76800, 76999, 'RO'], [77000, 77999, 'TO'],
  [78000, 78899, 'MT'], [79000, 79999, 'MS'], [80000, 87999, 'PR'], [88000, 89999, 'SC'], [90000, 99999, 'RS']
];
function ufFromCep(cep) {
  const d = onlyDigits(cep);
  if (d.length !== 8) return '';
  const n = parseInt(d.slice(0, 5), 10);
  const f = CEP_UF.find(([a, b]) => n >= a && n <= b);
  return f ? f[2] : '';
}
function formatCep(cep) {
  const d = onlyDigits(cep);
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : String(cep || '').trim();
}
const UFS = new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);

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

function flattenCustomFields(list, target) {
  if (!Array.isArray(list)) return;
  for (const cf of list) {
    if (!cf || typeof cf !== 'object') continue;
    const def = cf.customField || cf.field || {};
    const keys = [def.id, def.key, def.name, cf.id, cf.key].filter(k => k !== undefined && k !== null && k !== '');
    let val = cf.value;
    if (val === undefined || val === null || val === '') val = cf.textValue ?? cf.numericValue ?? cf.dateValue ?? cf.options ?? '';
    if (Array.isArray(val)) val = val.map(v => (v && typeof v === 'object') ? (v.label || v.name || v.value || v.id) : v).join(', ');
    else if (val && typeof val === 'object') val = val.label || val.name || val.value || val.id || '';
    for (const k of keys) if (!(String(k) in target)) target[String(k)] = val;
  }
}

function buildContext(deal) {
  // Mesma normalização de campos personalizados usada pela O.S., mais o formato
  // real da API v2 do Moskit (entityCustomFields)
  const flatCustomFields = {};
  if (Array.isArray(deal.customFields)) {
    flattenCustomFields(deal.customFields, flatCustomFields);
  } else if (deal.customFields && typeof deal.customFields === 'object') {
    Object.assign(flatCustomFields, deal.customFields);
  }
  flattenCustomFields(deal.entityCustomFields, flatCustomFields);

  const company = deal.company || (Array.isArray(deal.companies) && deal.companies[0]) || {};
  const contact = deal.contact || (Array.isArray(deal.contacts) && deal.contacts[0]) || {};
  const companyCustom = {};
  const contactCustom = {};
  flattenCustomFields(company.entityCustomFields, companyCustom);
  flattenCustomFields(contact.entityCustomFields, contactCustom);
  return {
    deal,
    company: { ...company, customFields: companyCustom },
    contact: { ...contact, customFields: contactCustom },
    customFields: flatCustomFields
  };
}

// Campos de escolha do Moskit (ex.: UF) guardam o NÚMERO da opção (ex.: 783572), não o texto ("SP").
// Cada campo tem seus próprios números (o "SP" da empresa é diferente do "SP" do contato),
// então a tradução é feita campo a campo, consultando as opções no Moskit (somente leitura, com cache).
const opcoesCache = new Map();
async function opcoesDoCampo(cfId) {
  const c = opcoesCache.get(cfId);
  if (c && Date.now() - c.em < 60 * 60 * 1000) return c.mapa;
  const lista = await moskitService.moskitFetch(`/customFields/${cfId}/options?quantity=100`);
  const mapa = new Map((Array.isArray(lista) ? lista : []).map(o => [Number(o.id), String(o.label || '').replace(/"/g, '').trim()]));
  opcoesCache.set(cfId, { em: Date.now(), mapa });
  return mapa;
}
async function traduzirOpcoes(ent) {
  if (!ent || !Array.isArray(ent.entityCustomFields)) return;
  for (const cf of ent.entityCustomFields) {
    if (!cf || !cf.id || !Array.isArray(cf.options) || !cf.options.length) continue;
    if (cf.textValue !== undefined && cf.textValue !== null && cf.textValue !== '') continue;
    try {
      const mapa = await opcoesDoCampo(cf.id);
      const rotulos = cf.options.map(id => mapa.get(Number(id))).filter(Boolean);
      if (rotulos.length) cf.textValue = rotulos.join(', ');
    } catch (e) { /* sem tradução: a UF continua sendo deduzida pelo CEP */ }
  }
}

// A API v2 do Moskit devolve empresa/contato como lista resumida (só o id preenchido).
// Busca os cadastros completos para ler CNPJ/CPF, telefone etc. (somente leitura).
async function hydrateParties(deal) {
  const pick = (one, many) => one && one.id ? one : (Array.isArray(many) && many[0] && many[0].id ? many[0] : null);
  const comp = pick(deal.company, deal.companies);
  if (comp && !comp.cnpj && !comp.name) {
    try { deal.company = { ...comp, ...(await moskitService.moskitFetch(`/companies/${comp.id}`)) }; } catch (e) { /* segue sem */ }
  } else if (comp) deal.company = comp;
  const cont = pick(deal.contact, deal.contacts);
  if (cont && !cont.cpf && !cont.name) {
    try { deal.contact = { ...cont, ...(await moskitService.moskitFetch(`/contacts/${cont.id}`)) }; } catch (e) { /* segue sem */ }
  } else if (cont) deal.contact = cont;
  await traduzirOpcoes(deal.company);
  await traduzirOpcoes(deal.contact);

  // Produtos sem SKU no retorno do negócio: busca o cadastro do produto (sem sobrescrever com vazio)
  const prods = Array.isArray(deal.dealProducts) ? deal.dealProducts : [];
  for (const dp of prods) {
    if (!dp || !dp.product || !dp.product.id || dp.product.sku) continue;
    try {
      const full = await moskitService.fetchProductById(dp.product.id);
      if (full) {
        for (const [k, v] of Object.entries(full)) {
          if (v !== null && v !== undefined && v !== '' && (dp.product[k] === null || dp.product[k] === undefined || dp.product[k] === '')) dp.product[k] = v;
        }
      }
    } catch (e) { /* segue sem */ }
  }
  return deal;
}

// Lista os campos com valor vindos do Moskit (ajuda a montar o mapeamento)
function listAvailableFields(ctx) {
  const out = [];
  const add = (prefix, obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined || v === '' || typeof v === 'object') continue;
      out.push({ caminho: `${prefix}.${k}`, valor: String(v).slice(0, 120) });
    }
  };
  add('deal', ctx.deal);
  add('company', ctx.company);
  add('company.customFields', ctx.company.customFields);
  add('contact', ctx.contact);
  add('contact.customFields', ctx.contact.customFields);
  add('customFields', ctx.customFields);
  for (const [i, ph] of (ctx.contact.phones || []).entries()) add(`contact.phones[${i}]`, ph);
  for (const [i, em] of (ctx.contact.emails || []).entries()) add(`contact.emails[${i}]`, em);
  for (const [i, ph] of (ctx.company.phones || []).entries()) add(`company.phones[${i}]`, ph);
  for (const [i, em] of (ctx.company.emails || []).entries()) add(`company.emails[${i}]`, em);
  return out;
}

// O Moskit guarda valores em centavos (84700 = R$ 847,00)
function moskitMoney(v) {
  const n = parseNumber(v, 0);
  return blingDb.getConfig('moskit_valores_centavos', 'true') === 'false' ? n : n / 100;
}

const FIELD_LABELS = {
  'contato.numeroDocumento': 'Cliente: CPF/CNPJ',
  'contato.nome': 'Cliente: Nome / Razão Social',
  'contato.fantasia': 'Cliente: Nome Fantasia',
  'contato.email': 'Cliente: E-mail',
  'contato.telefone': 'Cliente: Telefone',
  'contato.endereco': 'Cliente: Endereço',
  'contato.municipio': 'Cliente: Município',
  'contato.uf': 'Cliente: UF (se vazio, deduzida pelo CEP)',
  'contato.numero': 'Cliente: Número',
  'contato.complemento': 'Cliente: Complemento',
  'contato.bairro': 'Cliente: Bairro',
  'contato.cep': 'Cliente: CEP',
  'contato.ie': 'Cliente: Inscrição Estadual',
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
  const deal = await hydrateParties(await moskitService.fetchFullDeal(id));
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

  const contatoDadosMoskit = docDigits ? (() => {
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
    const numero = val('contato.numero');
    const complemento = val('contato.complemento');
    const bairro = val('contato.bairro');
    const cep = val('contato.cep');
    const municipio = val('contato.municipio');
    // Só aceita a sigla exata (ex.: "ESCOLHA" não pode virar "ES"); senão deduz pelo CEP
    const ufInformada = String(val('contato.uf') || '').replace(/[^A-Za-z]/g, '').toUpperCase();
    const uf = UFS.has(ufInformada) ? ufInformada : ufFromCep(cep);
    const ie = val('contato.ie');
    if (fantasia) p.fantasia = fantasia;
    if (email && /@/.test(email)) p.email = email;
    if (telefone) p.telefone = telefone;
    if (ie && onlyDigits(ie)) { p.ie = String(ie).trim(); p.indicadorIe = '1'; }
    if (endereco || numero || bairro || cep || municipio || uf) {
      p.endereco = { geral: {} };
      if (endereco) p.endereco.geral.endereco = endereco;
      if (numero) p.endereco.geral.numero = String(numero);
      if (complemento) p.endereco.geral.complemento = complemento;
      if (bairro) p.endereco.geral.bairro = bairro;
      if (cep) p.endereco.geral.cep = formatCep(cep);
      if (municipio) p.endereco.geral.municipio = municipio;
      if (uf) p.endereco.geral.uf = uf;
    }
    return p;
  })() : null;
  const contatoPayload = contatoInfo.acao === 'criar' ? contatoDadosMoskit : null;

  if (contatoInfo.acao === 'criar') {
    for (const f of ['contato.nome', 'contato.fantasia', 'contato.email', 'contato.telefone', 'contato.ie', 'contato.endereco', 'contato.numero', 'contato.complemento', 'contato.bairro', 'contato.cep', 'contato.municipio', 'contato.uf']) {
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
      valor: round2(moskitMoney(resolveItem('item.valor')))
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
  const dealPrice = round2(moskitMoney(deal.price));
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
    observacoesInternas: `Criado via Automação Moskit-Bling em ${new Date().toISOString()} (negócio Moskit #${id})`
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
    contatoDadosMoskit,
    linhas,
    camposMoskit: listAvailableFields(ctx),
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
    syncOsNumber(id, origem);
    blingDb.log(id, 'recuperado', `Pedido já existia no Bling (nº ${pe.numero}); registro marcado como enviado.`);
    blingDb.addHistory({ dealId: id, origem, evento: 'envio', resultado: 'info', mensagem: `Pedido já existia no Bling (nº ${pe.numero}); nada foi criado.`, pedidoId: pe.id, pedidoNumero: pe.numero });
    return { ok: false, codigo: 'ja_enviado', mensagem: `Este negócio já tem pedido no Bling (nº ${pe.numero}). Nada foi criado.`, preview };
  }
  if (preview.erros.length) {
    if (origem !== 'automatico') blingDb.addHistory({ dealId: id, origem, evento: 'envio', resultado: 'bloqueado', mensagem: preview.erros.join(' | ') });
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
      syncOsNumber(id, origem);
      blingDb.log(id, 'recuperado', `Pedido já existia no Bling (nº ${dup[0].numero}); registro marcado como enviado.`);
      blingDb.addHistory({ dealId: id, origem, evento: 'envio', resultado: 'info', mensagem: `Pedido já existia no Bling (nº ${dup[0].numero}); nada foi criado.`, pedidoId: dup[0].id, pedidoNumero: dup[0].numero });
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
      // A situação é aplicada depois (PATCH), só se for diferente da situação padrão do Bling
      const { situacao: _sit, ...corpoPost } = payload;
      res = await blingFetch('POST', '/pedidos/vendas', { body: corpoPost });
    } catch (postErr) {
      // Em qualquer erro (rede ou validação), confere se o Bling criou o pedido mesmo assim
      const check = await findOrdersByNumeroLoja(payload.numeroLoja).catch(() => []);
      if (check.length) {
        blingDb.markSent(id, { pedidoId: check[0].id, pedidoNumero: check[0].numero, contatoId, request: payload, response: { recuperado: check[0], aviso: postErr.message } });
        syncOsNumber(id, origem);
        blingDb.log(id, 'enviado', `Pedido nº ${check[0].numero} confirmado após resposta de erro do Bling.`);
        blingDb.addHistory({ dealId: id, origem, evento: 'envio', resultado: 'sucesso',
          mensagem: `Pedido nº ${check[0].numero} criado (o Bling respondeu "${postErr.message.slice(0, 120)}", mas o pedido foi gravado).`,
          pedidoId: check[0].id, pedidoNumero: check[0].numero, payload, response: postErr.response || null });
        return { ok: true, pedido: { id: check[0].id, numero: check[0].numero } };
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

    syncOsNumber(id, origem);
    blingDb.log(id, 'enviado', `Pedido Bling nº ${numero || '?'} (id ${pedidoId}) criado.`);
    blingDb.addHistory({ dealId: id, origem, evento: 'envio', resultado: 'sucesso',
      mensagem: `Pedido Bling nº ${numero || '?'} criado na situação ${payload.situacao.id === 6 ? 'Em aberto' : payload.situacao.id}${createdContact ? '; cliente cadastrado no Bling' : ''}. Total R$ ${Number(preview.total).toFixed(2)}.`,
      pedidoId, pedidoNumero: numero, payload, response: res });
    return { ok: true, pedido: { id: pedidoId, numero }, contatoCriado: Boolean(createdContact) };
  } catch (err) {
    blingDb.markError(id, err.message, payload, err.response || null);
    blingDb.log(id, 'erro', err.message);
    const conexao = isRetryable(err);
    blingDb.addHistory({ dealId: id, origem, evento: 'envio', resultado: 'erro',
      mensagem: `${conexao ? 'Falha de comunicação com o Bling: ' : ''}${err.message}`, payload, response: err.response || null });
    return { ok: false, codigo: 'falha_envio', mensagem: err.message, preview, retryable: conexao };
  }
}

// ==========================================================
// Número da O.S. = número do pedido no Bling
// ==========================================================

// Monta o número no mesmo formato configurado para as O.S. (ex.: "{NUM}/26" -> "5301/26")
function formatOsNumber(pedidoNumero) {
  const formato = osDb.getSetting('orcamento_formato', '{NUM}/26');
  const padding = parseInt(osDb.getSetting('orcamento_padding', '4'), 10) || 4;
  const now = new Date();
  return formato
    .replace('{NUM}', String(pedidoNumero).padStart(padding, '0'))
    .replace('{NUM_RAW}', String(pedidoNumero))
    .replace('{YY}', String(now.getFullYear()).slice(-2))
    .replace('{YYYY}', String(now.getFullYear()));
}

// Ajusta somente o número da O.S. do negócio (nenhum outro campo é alterado)
function syncOsNumber(dealId, origem = 'automatico') {
  try {
    const row = blingDb.getOrderByDeal(dealId);
    if (!row || !row.bling_pedido_numero) return null;
    const os = osDb.getOrderByMoskitId(Number(dealId));
    if (!os) return null; // a O.S. ainda não existe: será ajustada quando for criada
    const novo = formatOsNumber(row.bling_pedido_numero);
    const aguardando = os.status === OS_STATUS_AGUARDANDO;
    if (!novo || (os.orcamento_numero === novo && !aguardando)) return null;
    const anterior = os.orcamento_numero;
    osDb.updateOrder(os.id, aguardando ? { orcamento_numero: novo, status: 'won' } : { orcamento_numero: novo }, null);
    if (anterior === novo) {
      blingDb.addHistory({ dealId, origem, evento: 'os', resultado: 'info', mensagem: `O.S. ${novo} saiu de "Aguardando Bling": pedido nº ${row.bling_pedido_numero} criado.`, pedidoId: row.bling_pedido_id, pedidoNumero: row.bling_pedido_numero });
      return { anterior, novo };
    }
    const repetidas = osDb.db.prepare('SELECT COUNT(*) AS n FROM service_orders WHERE orcamento_numero = ? AND id <> ?').get(novo, os.id).n;
    blingDb.addHistory({ dealId, origem, evento: 'os', resultado: 'info',
      mensagem: `O.S. renumerada de ${anterior} para ${novo} (mesmo número do pedido no Bling)${aguardando ? ' e saiu de "Aguardando Bling"' : ''}.${repetidas ? ` Atenção: já existe outra O.S. com o número ${novo}.` : ''}`,
      pedidoId: row.bling_pedido_id, pedidoNumero: row.bling_pedido_numero });
    return { anterior, novo };
  } catch (e) {
    blingDb.addHistory({ dealId, origem, evento: 'os', resultado: 'erro', mensagem: `Não foi possível ajustar o número da O.S.: ${e.message}` });
    return null;
  }
}

// ==========================================================
// O.S. criada junto com o pedido (mesma estrutura de dados)
// ==========================================================
const OS_STATUS_AGUARDANDO = 'aguardando_bling';

// Número provisório: último número de O.S. do sistema + 1 (no formato configurado)
function nextProvisionalOsNumber() {
  const rows = osDb.db.prepare('SELECT orcamento_numero FROM service_orders').all();
  let max = 0;
  for (const r of rows) {
    const n = parseInt((String(r.orcamento_numero || '').match(/\d+/) || ['0'])[0], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return formatOsNumber(max + 1);
}

// Monta a O.S. com os mesmos dados usados no pedido do Bling (cabeçalho pelo mapeamento
// da O.S., itens e valores pela conferência). Nunca cria duas O.S. para o mesmo negócio.
async function buildOsData(id, preview) {
  const deal = await hydrateParties(await moskitService.fetchFullDeal(id));
  const { orderData, items } = moskitService.mapDealToServiceOrder(deal);
  // Mantém o padrão atual do nome da O.S. (nome do negócio)
  if (deal.name) orderData.nome_fantasia = deal.name;
  // Valores dos itens iguais aos do pedido (o Moskit envia em centavos)
  const itensPv = (preview && preview.itens) || [];
  items.forEach((it, i) => {
    const pv = itensPv[i];
    it.preco_unitario = pv ? pv.valor : round2(moskitMoney(it.preco_unitario));
    if (pv && pv.codigo && !it.sku) it.sku = pv.codigo;
  });
  if (preview && preview.payload && preview.payload.dataPrevista && !orderData.data_entrega) {
    orderData.data_entrega = formatBr(preview.payload.dataPrevista);
  }
  orderData.raw_deal_data = deal;
  return { deal, orderData, items };
}

async function createOsForDeal(id, { preview = null, numero = null, status = 'won', origem = 'automatico' } = {}) {
  const existente = osDb.getOrderByMoskitId(Number(id));
  if (existente) return { os: existente, criada: false };
  const { orderData, items } = await buildOsData(id, preview);
  orderData.moskit_deal_id = Number(id);
  orderData.orcamento_numero = numero || nextProvisionalOsNumber();
  orderData.status = status;
  orderData.data_os = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const os = osDb.createOrder(orderData, items);
  blingDb.addHistory({ dealId: id, origem, evento: 'os', resultado: 'info',
    mensagem: status === OS_STATUS_AGUARDANDO
      ? `O.S. ${os.orcamento_numero} criada com status "Aguardando Bling" (número provisório; será trocado pelo número do pedido quando ele for criado no Bling).`
      : `O.S. ${os.orcamento_numero} criada junto com o pedido (mesmo número do pedido no Bling).` });
  return { os, criada: true };
}

// Sobrescreve a O.S. com os dados atuais (mantém número, data, foto, modelo de PDF e status)
async function overwriteOs(id, preview, origem = 'manual') {
  const os = osDb.getOrderByMoskitId(Number(id));
  if (!os) return null;
  const { orderData, items } = await buildOsData(id, preview);
  const campos = ['nome_fantasia', 'razao_social', 'cnpj_cpf', 'contato_nome', 'contato_telefone', 'contato_email',
    'data_entrega', 'forma_pagamento', 'prazo_pagamento', 'frete', 'observacoes'];
  const dados = {};
  for (const c of campos) if (orderData[c] !== undefined) dados[c] = orderData[c];
  osDb.updateOrder(os.id, dados, items);
  blingDb.addHistory({ dealId: id, origem, evento: 'os', resultado: 'info',
    mensagem: `O.S. ${os.orcamento_numero} sobrescrita com os dados atuais (itens e cliente); número, data, foto e status mantidos.` });
  return os;
}

// ==========================================================
// Envio automático, histórico e alterações depois do envio
// ==========================================================

// Erros em que vale tentar de novo: rede, limite de requisições ou instabilidade do Bling
function isRetryable(err) {
  if (!err) return false;
  if (err.network) return true;
  const st = Number(err.status) || 0;
  return st === 429 || st >= 500;
}

// Processa um negócio por vez (o Moskit pode disparar várias edições seguidas)
const dealChains = new Map();
function serialize(dealId, fn) {
  const key = String(dealId);
  const prev = dealChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  dealChains.set(key, next);
  next.finally(() => { if (dealChains.get(key) === next) dealChains.delete(key); }).catch(() => {});
  return next;
}

const JA_ENVIADO_PREFIX = 'Este negócio JÁ foi enviado';

// Retrato comparável do pedido (só o que vem do Moskit; configurações não contam)
function snapshotFromPayload(payload, contatoRef) {
  const p = payload || {};
  return {
    cliente: contatoRef || (p.contato && p.contato.id ? `id ${p.contato.id}` : ''),
    data: p.data || '',
    dataPrevista: p.dataPrevista || '',
    observacoes: p.observacoes || '',
    numeroPedidoCompra: p.numeroPedidoCompra || '',
    itens: (p.itens || []).map(i => `${i.codigo || '(sem SKU)'} · ${Number(i.quantidade)} × R$ ${Number(i.valor).toFixed(2)}`),
    total: Number((p.parcelas || []).reduce((t, x) => t + (Number(x.valor) || 0), 0)).toFixed(2)
  };
}

function contatoRefFromPreview(preview) {
  if (preview.contato && preview.contato.id) return `id ${preview.contato.id}`;
  if (preview.contato && preview.contato.numeroDocumento) return `novo: ${preview.contato.nome || ''} (${preview.contato.numeroDocumento})`.trim();
  return '';
}

const SNAP_LABELS = {
  cliente: 'Cliente', data: 'Data do pedido', dataPrevista: 'Data prevista', observacoes: 'Observações',
  numeroPedidoCompra: 'Nº pedido de compra', itens: 'Itens', total: 'Total'
};

function diffSnapshots(antes, depois) {
  const diff = [];
  for (const k of Object.keys(SNAP_LABELS)) {
    const a = Array.isArray(antes[k]) ? antes[k].join('\n') : String(antes[k] ?? '');
    const b = Array.isArray(depois[k]) ? depois[k].join('\n') : String(depois[k] ?? '');
    if (a !== b) diff.push({ campo: SNAP_LABELS[k], antes: a, depois: b });
  }
  return diff;
}

// Compara o pedido enviado com os dados atuais do Moskit
async function detectChange(id, origem) {
  const row = blingDb.getOrderByDeal(id);
  if (!row || !['enviado', 'alteracao_pendente'].includes(row.status)) return { ok: false, codigo: 'sem_envio' };
  let enviado = null;
  try { enviado = row.request_json ? JSON.parse(row.request_json) : null; } catch (e) { enviado = null; }
  if (!enviado) return { ok: false, codigo: 'sem_base' }; // pedido localizado no Bling sem os dados enviados

  const preview = await buildPreview(id);
  const antes = snapshotFromPayload(enviado, row.bling_contato_id ? `id ${row.bling_contato_id}` : '');
  const depois = snapshotFromPayload(preview.payload, contatoRefFromPreview(preview));
  const diff = diffSnapshots(antes, depois);
  const signature = JSON.stringify(depois);

  if (!diff.length) {
    if (row.status === 'alteracao_pendente') {
      blingDb.clearPendingChange(id);
      blingDb.addHistory({ dealId: id, origem, evento: 'alteracao', resultado: 'info', mensagem: 'Os dados no Moskit voltaram a ser iguais aos do pedido no Bling. Alteração pendente removida.', pedidoId: row.bling_pedido_id, pedidoNumero: row.bling_pedido_numero });
    }
    return { ok: true, mudou: false };
  }
  if (row.discarded_signature && row.discarded_signature === signature) return { ok: true, mudou: false, descartada: true };

  const anterior = row.pending_diff || '';
  blingDb.setPendingChange(id, { payload: preview.payload, contato: preview.contato, contatoPayload: preview.contatoPayload, signature, erros: preview.erros.filter(e => !e.startsWith(JA_ENVIADO_PREFIX)) }, diff);
  if (anterior !== JSON.stringify(diff)) {
    blingDb.addHistory({ dealId: id, origem, evento: 'alteracao', resultado: 'pendente',
      mensagem: `Negócio alterado no Moskit depois do envio (${diff.map(d => d.campo).join(', ')}). Aguardando autorização para atualizar o pedido nº ${row.bling_pedido_numero || row.bling_pedido_id}.`,
      pedidoId: row.bling_pedido_id, pedidoNumero: row.bling_pedido_numero, diff });
  }
  return { ok: true, mudou: true, diff };
}

function getPendingChange(dealId) {
  const row = blingDb.getOrderByDeal(dealId);
  if (!row) return null;
  let pend = null, diff = [];
  try { pend = row.pending_payload ? JSON.parse(row.pending_payload) : null; } catch (e) { pend = null; }
  try { diff = row.pending_diff ? JSON.parse(row.pending_diff) : []; } catch (e) { diff = []; }
  return {
    pedido: { moskit_deal_id: row.moskit_deal_id, deal_name: row.deal_name, status: row.status, bling_pedido_id: row.bling_pedido_id, bling_pedido_numero: row.bling_pedido_numero, pending_since: row.pending_since, last_error: row.last_error },
    diff,
    erros: pend && pend.erros ? pend.erros : []
  };
}

// Autorização do usuário: atualiza o pedido existente no Bling
async function applyPendingChange(dealId, { forcar = false } = {}) {
  const id = Number(dealId);
  return serialize(id, async () => {
    // Recalcula com os dados mais recentes do Moskit antes de gravar
    if (!forcar) {
      const det = await detectChange(id, 'manual');
      if (det.ok && !det.mudou) return { ok: false, codigo: 'sem_alteracao', mensagem: 'Não há mais diferença entre o Moskit e o pedido no Bling. Nada a atualizar.' };
    }
    const info = getPendingChange(id);
    if (!info || info.pedido.status !== 'alteracao_pendente') return { ok: false, codigo: 'sem_pendencia', mensagem: 'Não há alteração pendente para este negócio.' };
    if (info.erros.length) return { ok: false, codigo: 'erros', mensagem: `Corrija antes de atualizar: ${info.erros.join(' | ')}` };
    if (!blingDb.tryLockForUpdate(id)) return { ok: false, codigo: 'bloqueado', mensagem: 'Esta alteração já está sendo processada. Atualize a tela.' };

    const row = blingDb.getOrderByDeal(id);
    const pend = JSON.parse(row.pending_payload);
    const diff = JSON.parse(row.pending_diff || '[]');
    const payload = JSON.parse(JSON.stringify(pend.payload));
    try {
      // Só atualiza se o pedido ainda estiver na situação inicial (ex.: Em aberto)
      const atual = await blingFetch('GET', `/pedidos/vendas/${row.bling_pedido_id}`);
      const sitAtual = atual.data && atual.data.situacao && Number(atual.data.situacao.id);
      const sitInicial = Number(payload.situacao && payload.situacao.id);
      if (sitAtual && sitInicial && sitAtual !== sitInicial) {
        const msg = `O pedido nº ${row.bling_pedido_numero} não está mais na situação inicial no Bling (situação atual: ${sitAtual}). Atualize-o manualmente no Bling ou descarte a alteração.`;
        blingDb.releaseUpdateLock(id, msg);
        blingDb.addHistory({ dealId: id, origem: 'manual', evento: 'atualizacao', resultado: 'bloqueado', mensagem: msg, pedidoId: row.bling_pedido_id, pedidoNumero: row.bling_pedido_numero, diff });
        return { ok: false, codigo: 'situacao', mensagem: msg };
      }

      let contatoId = pend.contato && pend.contato.id;
      if (!contatoId && pend.contato && pend.contato.acao === 'criar') {
        const again = await findContactByDocument(pend.contato.numeroDocumento);
        if (again.length) contatoId = again[0].id;
        else {
          const resC = await blingFetch('POST', '/contatos', { body: pend.contatoPayload });
          contatoId = resC.data && resC.data.id;
          if (!contatoId) throw new Error('O Bling não retornou o id do contato criado.');
        }
      }
      payload.contato = { id: contatoId || Number(row.bling_contato_id) };

      // Sobrescrever também o cadastro do cliente com os dados preenchidos no Moskit
      let contatoAtualizado = false;
      if (pend.atualizarContato && pend.contatoDadosMoskit && payload.contato.id) {
        const atualC = await getBlingContato(payload.contato.id);
        if (atualC) {
          const corpoC = mergeContato(atualC, pend.contatoDadosMoskit);
          try {
            await blingFetch('PUT', `/contatos/${payload.contato.id}`, { body: corpoC });
            contatoAtualizado = true;
          } catch (errC) {
            throw Object.assign(new Error(`Não foi possível atualizar o cadastro do cliente no Bling: ${errC.message}. Nada foi alterado no pedido.`), { response: errC.response });
          }
        }
      }
      const orig = (atual.data && atual.data.observacoesInternas) || '';
      payload.observacoesInternas = `${orig ? orig + '\n' : ''}Atualizado via Automação Moskit-Bling em ${new Date().toISOString()}`;

      const { situacao: _sitPut, ...corpoPut } = payload;
      if (atual.data && atual.data.numero) corpoPut.numero = atual.data.numero; // número do pedido não muda
      const res = await blingFetch('PUT', `/pedidos/vendas/${row.bling_pedido_id}`, { body: corpoPut });
      blingDb.markUpdated(id, { contatoId: payload.contato.id, request: payload, response: res });
      // A O.S. do negócio também é sobrescrita (itens e cliente), mantendo número, foto e status
      let osAtualizada = null;
      try { osAtualizada = await overwriteOs(id, null, 'manual'); }
      catch (eOs) { blingDb.addHistory({ dealId: id, origem: 'manual', evento: 'os', resultado: 'erro', mensagem: `Pedido atualizado, mas a O.S. não pôde ser sobrescrita: ${eOs.message}` }); }
      blingDb.addHistory({ dealId: id, origem: 'manual', evento: 'atualizacao', resultado: 'sucesso',
        mensagem: `Pedido nº ${row.bling_pedido_numero} atualizado no Bling com os dados do Moskit (${diff.map(d => d.campo).join(', ')})${contatoAtualizado ? '; cadastro do cliente atualizado' : ''}.`,
        pedidoId: row.bling_pedido_id, pedidoNumero: row.bling_pedido_numero, payload, response: res, diff });
      return { ok: true, pedido: { id: row.bling_pedido_id, numero: row.bling_pedido_numero } };
    } catch (err) {
      blingDb.releaseUpdateLock(id, err.message);
      blingDb.addHistory({ dealId: id, origem: 'manual', evento: 'atualizacao', resultado: 'erro',
        mensagem: `${isRetryable(err) ? 'Falha de comunicação com o Bling: ' : ''}${err.message}`, pedidoId: row.bling_pedido_id, pedidoNumero: row.bling_pedido_numero, payload, response: err.response || null, diff });
      return { ok: false, codigo: 'falha', mensagem: err.message };
    }
  });
}

// Prepara a substituição do pedido existente pelos dados conferidos agora (sem gravar nada)
// Retrato do pedido como está HOJE no Bling (para comparar com o Moskit)
function snapshotFromBlingOrder(o) {
  const d = (v) => (!v || v === '0000-00-00') ? '' : v;
  return snapshotFromPayload({
    contato: o.contato, data: d(o.data), dataPrevista: d(o.dataPrevista), observacoes: o.observacoes || '',
    numeroPedidoCompra: o.numeroPedidoCompra || '',
    itens: (o.itens || []).map(i => ({ codigo: i.codigo, quantidade: i.quantidade, valor: i.valor })),
    parcelas: (o.parcelas && o.parcelas.length) ? o.parcelas : [{ valor: o.total }]
  }, o.contato && o.contato.id ? `id ${o.contato.id}` : '');
}

// Localiza o pedido da integração no Bling para o negócio (registro local ou numeroLoja MOSKIT-<id>)
async function findIntegrationOrder(id, row) {
  if (row && row.bling_pedido_id && ['enviado', 'alteracao_pendente'].includes(row.status)) {
    return { id: row.bling_pedido_id, numero: row.bling_pedido_numero, contatoId: row.bling_contato_id };
  }
  const prefixo = blingDb.getConfig('numero_loja_prefixo', 'MOSKIT-');
  const achados = await findOrdersByNumeroLoja(`${prefixo}${id}`);
  if (!achados.length) return null;
  return { id: achados[0].id, numero: achados[0].numero, contatoId: achados[0].contato && achados[0].contato.id, recuperar: true };
}

// ---------- Cliente: comparar e sobrescrever o cadastro no Bling ----------
const CLIENTE_CAMPOS = [
  ['nome', 'Cliente: Nome / Razão Social', (c) => c.nome],
  ['fantasia', 'Cliente: Nome fantasia', (c) => c.fantasia],
  ['email', 'Cliente: E-mail', (c) => c.email],
  ['telefone', 'Cliente: Telefone', (c) => c.telefone],
  ['ie', 'Cliente: Inscrição Estadual', (c) => c.ie],
  ['endereco', 'Cliente: Endereço', (c) => c.endereco && c.endereco.geral && c.endereco.geral.endereco],
  ['numero', 'Cliente: Número', (c) => c.endereco && c.endereco.geral && c.endereco.geral.numero],
  ['complemento', 'Cliente: Complemento', (c) => c.endereco && c.endereco.geral && c.endereco.geral.complemento],
  ['bairro', 'Cliente: Bairro', (c) => c.endereco && c.endereco.geral && c.endereco.geral.bairro],
  ['cep', 'Cliente: CEP', (c) => c.endereco && c.endereco.geral && c.endereco.geral.cep],
  ['municipio', 'Cliente: Município', (c) => c.endereco && c.endereco.geral && c.endereco.geral.municipio],
  ['uf', 'Cliente: UF', (c) => c.endereco && c.endereco.geral && c.endereco.geral.uf]
];
const normCampo = (k, v) => {
  const s = String(v ?? '').trim();
  if (k === 'cep' || k === 'ie' || k === 'telefone') return onlyDigits(s);
  return s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
};

// Só campos preenchidos no Moskit entram (nada do Bling é apagado por campo vazio)
function diffCliente(blingContato, moskit) {
  const diff = [];
  if (!blingContato || !moskit) return diff;
  for (const [k, rotulo, get] of CLIENTE_CAMPOS) {
    const novo = get(moskit);
    if (novo === undefined || novo === null || String(novo).trim() === '') continue;
    const atual = get(blingContato);
    if (normCampo(k, atual) !== normCampo(k, novo)) diff.push({ campo: rotulo, antes: String(atual ?? ''), depois: String(novo) });
  }
  return diff;
}

function mergeContato(blingContato, moskit) {
  const out = JSON.parse(JSON.stringify(blingContato || {}));
  delete out.id;
  for (const k of ['nome', 'fantasia', 'email', 'telefone', 'ie', 'indicadorIe']) {
    if (moskit[k] !== undefined && moskit[k] !== null && String(moskit[k]).trim() !== '') out[k] = moskit[k];
  }
  const g = (moskit.endereco && moskit.endereco.geral) || {};
  out.endereco = out.endereco || {};
  out.endereco.geral = out.endereco.geral || {};
  for (const [k, v] of Object.entries(g)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') out.endereco.geral[k] = v;
  }
  if (!out.situacao) out.situacao = 'A';
  if (!out.tipo) out.tipo = moskit.tipo;
  return limparVazios(out);
}

// Remove campos vazios/placeholder do Bling ("", "0000-00-00", {id:0}) para o PUT não ser recusado
function limparVazios(v) {
  if (Array.isArray(v)) return v.map(limparVazios).filter(x => x !== undefined);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === 'id' && !Number(v.id)) return undefined;
    const o = {};
    for (const k of keys) {
      const x = limparVazios(v[k]);
      if (x === undefined) continue;
      if (x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length) continue;
      o[k] = x;
    }
    return o;
  }
  if (v === '' || v === '0000-00-00' || v === null) return undefined;
  return v;
}

async function getBlingContato(id) {
  if (!id) return null;
  try { const r = await blingFetch('GET', `/contatos/${id}`); return r.data || null; } catch (e) { return null; }
}

// Prepara a substituição do pedido existente pelos dados conferidos agora (somente leitura)
async function prepareReplace(dealId) {
  const id = Number(dealId);
  return serialize(id, async () => {
    const row = blingDb.getOrderByDeal(id);
    const ped = await findIntegrationOrder(id, row);
    if (!ped) return { ok: false, codigo: 'sem_pedido', mensagem: 'Este negócio ainda não tem pedido criado no Bling pela integração.' };
    const preview = await buildPreview(id);
    const erros = preview.erros.filter(e => !e.startsWith(JA_ENVIADO_PREFIX));
    const atual = await blingFetch('GET', `/pedidos/vendas/${ped.id}`);
    const pedidoBling = atual.data || {};
    const depois = snapshotFromPayload(preview.payload, contatoRefFromPreview(preview));
    const diffPedido = diffSnapshots(snapshotFromBlingOrder(pedidoBling), depois);
    const contatoBlingId = (preview.contato && preview.contato.id) || (pedidoBling.contato && pedidoBling.contato.id) || ped.contatoId;
    const contatoBling = preview.contato && preview.contato.acao === 'criar' ? null : await getBlingContato(contatoBlingId);
    const diffContato = contatoBling ? diffCliente(contatoBling, preview.contatoDadosMoskit) : [];
    const diff = [...diffPedido, ...diffContato];
    const sitInicial = Number(blingDb.getConfig('situacao_id', '6')) || 6;
    const sitAtual = pedidoBling.situacao && Number(pedidoBling.situacao.id);
    return {
      ok: true, erros, diff,
      pedido: { id: ped.id, numero: pedidoBling.numero || ped.numero, situacaoInicial: !sitAtual || sitAtual === sitInicial },
      _interno: { ped, payload: preview.payload, contato: preview.contato, contatoPayload: preview.contatoPayload, contatoDadosMoskit: preview.contatoDadosMoskit, contatoBlingId, atualizarContato: diffContato.length > 0, signature: JSON.stringify(depois) }
    };
  });
}

// Substitui (sobrescreve) o pedido existente no Bling pelos dados atuais do Moskit, por decisão do usuário
async function replaceOrder(dealId) {
  const id = Number(dealId);
  const prep = await prepareReplace(id);
  if (!prep.ok) return prep;
  if (prep.erros.length) return { ok: false, codigo: 'erros', mensagem: `Corrija antes de substituir: ${prep.erros.join(' | ')}` };
  // Pedido existe no Bling mas o registro local não o vincula (ex.: resposta de erro na criação):
  // vincula sem alterar o número da O.S. nem do pedido
  if (prep._interno.ped.recuperar) {
    const ped = prep._interno.ped;
    blingDb.enqueue(id, '', 0, 'manual');
    blingDb.markSent(id, { pedidoId: ped.id, pedidoNumero: prep.pedido.numero, contatoId: ped.contatoId, request: null, response: { vinculado: true } });
    blingDb.addHistory({ dealId: id, origem: 'manual', evento: 'envio', resultado: 'info',
      mensagem: `Pedido nº ${prep.pedido.numero} já existia no Bling e foi vinculado ao negócio (números mantidos).`, pedidoId: ped.id, pedidoNumero: prep.pedido.numero });
  }
  const semDiferenca = !prep.diff.length;
  blingDb.setPendingChange(id, { ...prep._interno, erros: [] },
    semDiferenca ? [{ campo: '(campos comparados iguais)', antes: '', depois: 'Substituição solicitada na conferência' }] : prep.diff);
  blingDb.addHistory({ dealId: id, origem: 'manual', evento: 'alteracao', resultado: 'info',
    mensagem: `Substituição do pedido nº ${prep.pedido.numero} solicitada na conferência${semDiferenca ? ' (sem diferenças nos campos comparados)' : ` (${prep.diff.map(d => d.campo).join(', ')})`}.`,
    pedidoId: prep.pedido.id, pedidoNumero: prep.pedido.numero, diff: prep.diff });
  return applyPendingChange(id, { forcar: true });
}

function discardPendingChange(dealId) {
  const id = Number(dealId);
  const row = blingDb.getOrderByDeal(id);
  if (!row || row.status !== 'alteracao_pendente') return { ok: false, mensagem: 'Não há alteração pendente para este negócio.' };
  let signature = null;
  try { signature = JSON.parse(row.pending_payload).signature || null; } catch (e) { signature = null; }
  blingDb.clearPendingChange(id, { discardedSignature: signature });
  blingDb.addHistory({ dealId: id, origem: 'manual', evento: 'alteracao', resultado: 'info',
    mensagem: `Alteração descartada: o pedido nº ${row.bling_pedido_numero} no Bling foi mantido como estava.`, pedidoId: row.bling_pedido_id, pedidoNumero: row.bling_pedido_numero, diff: row.pending_diff ? JSON.parse(row.pending_diff) : null });
  return { ok: true };
}

// Reenvio automático em falhas de comunicação (enquanto o servidor estiver ativo)
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000];
const retryTimers = new Map();
function scheduleRetry(id, attempt) {
  if (retryTimers.has(String(id))) return true;
  if (attempt > RETRY_DELAYS_MS.length) return false;
  const delay = RETRY_DELAYS_MS[attempt - 1];
  blingDb.addHistory({ dealId: id, origem: 'automatico', evento: 'envio', resultado: 'info', mensagem: `Nova tentativa automática agendada em ${Math.round(delay / 60000)} min (tentativa ${attempt + 1}).` });
  // Mantém o servidor ligado até a nova tentativa acontecer (senão o Fly desliga a máquina e ela se perde)
  const keepAlive = require('./keepAlive');
  keepAlive.iniciar();
  const t = setTimeout(() => {
    retryTimers.delete(String(id));
    Promise.resolve().then(() => processWebhookDeal(id, { won: true, origem: 'automatico', attempt: attempt + 1 }))
      .catch(() => {}).finally(() => keepAlive.parar());
  }, delay);
  if (t.unref) t.unref();
  retryTimers.set(String(id), t);
  return true;
}

// Negócio ganho a partir da data de corte? (sem data de fechamento: considera recente)
function isRecentWin(closeDate) {
  const desde = blingDb.getConfig('envio_automatico_desde', '');
  if (!desde) return true;
  const d = toIsoDate(closeDate);
  if (!d) return true;
  return d >= desde;
}

// Chamado pelo webhook do Moskit (em segundo plano, depois de responder ao Moskit)
function processWebhookDeal(dealId, { won = true, status = '', origem = 'webhook', attempt = 1, nome = '', valor = 0, closeDate = null, criarOS = false } = {}) {
  const id = Number(dealId);
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve();
  return serialize(id, async () => {
    const row = blingDb.getOrderByDeal(id);

    // Negócio já enviado: só verifica se houve alteração
    if (row && ['enviado', 'alteracao_pendente'].includes(row.status)) {
      if (won) {
        try { await detectChange(id, origem); }
        catch (e) { blingDb.addHistory({ dealId: id, origem, evento: 'alteracao', resultado: 'erro', mensagem: `Não foi possível comparar com o Moskit: ${e.message}` }); }
      } else if (status && row.ultimo_status_moskit !== String(status)) {
        blingDb.setMoskitStatus(id, status);
        blingDb.addHistory({ dealId: id, origem, evento: 'status_moskit', resultado: 'info',
          mensagem: `Atenção: no Moskit o negócio passou para "${status}" depois que o pedido nº ${row.bling_pedido_numero} foi criado no Bling. O pedido no Bling não foi alterado.`,
          pedidoId: row.bling_pedido_id, pedidoNumero: row.bling_pedido_numero });
      }
      if (criarOS) await garantirOs(id, origem, null);
      return;
    }
    if (!won) return;
    if (row && ['ignorado', 'enviando', 'atualizando'].includes(row.status)) {
      if (criarOS) await garantirOs(id, origem, null);
      return;
    }
    // Negócio ganho antes da data de corte e ainda fora da fila: não entra automaticamente
    if (!row && origem === 'webhook' && !isRecentWin(closeDate)) return;

    const r = await tentarEnvioAutomatico(id, { row, origem, attempt, nome, valor });

    // O.S. nasce junto: com o número do pedido (enviado) ou "Aguardando Bling" (provisório)
    if (criarOS) await garantirOs(id, origem, r.preview);

    if (r.alerta) await alertarFalha(id, r.alerta, r.preview, origem);
  });
}

// Garante a O.S. do negócio (nunca duplica)
async function garantirOs(id, origem, preview) {
  try {
    if (osDb.getOrderByMoskitId(id)) return;
    const row = blingDb.getOrderByDeal(id);
    if (row && row.bling_pedido_numero && ['enviado', 'alteracao_pendente'].includes(row.status)) {
      await createOsForDeal(id, { preview, numero: formatOsNumber(row.bling_pedido_numero), status: 'won', origem });
    } else {
      await createOsForDeal(id, { preview, status: OS_STATUS_AGUARDANDO, origem });
    }
  } catch (e) {
    blingDb.addHistory({ dealId: id, origem, evento: 'os', resultado: 'erro', mensagem: `Não foi possível criar a O.S.: ${e.message}` });
    await alertarFalha(id, `Não foi possível criar a O.S.: ${e.message}`, preview, origem);
  }
}

// Tenta criar o pedido; devolve { enviado, preview, alerta } (alerta = motivo a enviar por e-mail)
async function tentarEnvioAutomatico(id, { row, origem, attempt, nome, valor }) {
  const automatico = blingDb.getConfig('envio_automatico', 'true') === 'true';
  if (!automatico) {
    // Modo manual: só coloca na fila para conferência (sem consultar o Bling)
    if (blingDb.getConfig('auto_enfileirar', 'true') !== 'false') {
      blingDb.enqueue(id, nome, round2(moskitMoney(valor)), 'webhook');
      if (!row) blingDb.addHistory({ dealId: id, origem, evento: 'fila', resultado: 'info', mensagem: 'Negócio Ganho recebido e colocado na fila para conferência manual (envio automático desligado).' });
    }
    return { enviado: false, preview: null, alerta: null };
  }

  let preview;
  try {
    preview = await buildPreview(id);
  } catch (e) {
    const msg = `Não foi possível conferir o negócio: ${e.message}`;
    blingDb.enqueue(id, nome, round2(moskitMoney(valor)), 'webhook');
    blingDb.setBlocked(id, 'erro', msg);
    blingDb.addHistory({ dealId: id, origem, evento: 'envio', resultado: 'erro', mensagem: msg });
    if ((isRetryable(e) || /\((429|5\d\d)\)/.test(e.message)) && scheduleRetry(id, attempt)) return { enviado: false, preview: null, alerta: null };
    return { enviado: false, preview: null, alerta: msg };
  }
  blingDb.enqueue(id, preview.deal.nome, preview.total || preview.deal.valor, 'webhook');

  const bloqueios = preview.erros.filter(e => !e.startsWith(JA_ENVIADO_PREFIX));
  if (bloqueios.length) {
    const msg = `Não enviado automaticamente: ${bloqueios.join(' | ')}`;
    const atual = blingDb.getOrderByDeal(id);
    blingDb.setBlocked(id, 'erro', msg);
    if (!atual || atual.last_error !== msg) blingDb.addHistory({ dealId: id, origem, evento: 'envio', resultado: 'bloqueado', mensagem: msg });
    return { enviado: false, preview, alerta: msg };
  }
  const duplicidade = preview.avisos.filter(a => a.startsWith('POSSÍVEL DUPLICIDADE'));
  if (duplicidade.length && !preview.pedidoExistente) {
    const msg = `Aguardando conferência manual: ${duplicidade.join(' | ')}`;
    const atual = blingDb.getOrderByDeal(id);
    blingDb.setBlocked(id, 'pendente', msg);
    if (!atual || atual.last_error !== msg) blingDb.addHistory({ dealId: id, origem, evento: 'envio', resultado: 'bloqueado', mensagem: msg });
    return { enviado: false, preview, alerta: msg };
  }

  const result = await sendDeal(id, { confirmarAvisos: true, origem: 'automatico' });
  if (result.ok || result.codigo === 'ja_enviado') return { enviado: true, preview };
  if (result.retryable) {
    if (scheduleRetry(id, attempt)) return { enviado: false, preview, alerta: null };
    return { enviado: false, preview, alerta: `Falha de comunicação com o Bling (após ${attempt} tentativas): ${result.mensagem}` };
  }
  if (result.codigo === 'falha_envio') return { enviado: false, preview, alerta: `O Bling recusou o pedido: ${result.mensagem}` };
  const detalhe = result.preview && result.preview.erros && result.preview.erros.length ? `: ${result.preview.erros.join(' | ')}` : '';
  const msg = `Não enviado automaticamente: ${result.mensagem}${detalhe}`;
  if (result.codigo === 'erros') blingDb.setBlocked(id, 'erro', msg);
  blingDb.addHistory({ dealId: id, origem, evento: 'envio', resultado: 'bloqueado', mensagem: msg });
  return { enviado: false, preview, alerta: msg };
}

// E-mail de alerta (uma vez por motivo e negócio)
async function alertarFalha(id, motivo, preview, origem) {
  try {
    const assinatura = String(motivo).slice(0, 300);
    const ja = blingDb.listHistory({ dealId: id, limite: 200 }).some(h => h.evento === 'alerta_email' && h.resultado === 'sucesso' && String(h.mensagem || '').includes(assinatura.slice(0, 120)));
    if (ja) return;
    let pv = preview;
    if (!pv) { try { pv = await buildPreview(id); } catch (e) { pv = null; } }
    const os = osDb.getOrderByMoskitId(id);
    const r = await emailService.enviarAlertaFalha({ dealId: id, motivo, preview: pv, os });
    blingDb.addHistory({ dealId: id, origem, evento: 'alerta_email', resultado: r.ok ? 'sucesso' : (r.naoConfigurado ? 'info' : 'erro'),
      mensagem: r.ok ? `Alerta enviado por e-mail para ${r.para}. Motivo: ${assinatura}` : `E-mail de alerta não enviado (${r.mensagem}). Motivo: ${assinatura}` });
  } catch (e) {
    blingDb.addHistory({ dealId: id, origem, evento: 'alerta_email', resultado: 'erro', mensagem: `Falha ao enviar o alerta por e-mail: ${e.message}` });
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
  createOsForDeal,
  overwriteOs,
  nextProvisionalOsNumber,
  OS_STATUS_AGUARDANDO,
  prepareReplace: async (id) => { const r = await prepareReplace(id); if (r && r._interno) delete r._interno; return r; },
  replaceOrder,
  syncOsNumber,
  formatOsNumber,
  isRecentWin,
  diagnosticarPermissoes,
  processWebhookDeal,
  detectChange,
  getPendingChange,
  applyPendingChange,
  discardPendingChange,
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
  // Leitura genérica (usada pelo diagnóstico de contatos)
  blingFetch,
  _limparVazios: limparVazios,
  // Exportado para testes
  _internals: { toIsoDate, parseNumber, addDays, onlyDigits, buildContext, traduzirOpcoes, opcoesCache }
};
