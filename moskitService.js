const db = require('./db');
const skuDictionary = require('./skuDictionary');

const MOSKIT_BASE_URL = 'https://api.moskitcrm.com/v2';

// In-memory cache for Moskit products
const productCache = {};

async function fetchProductById(productId) {
  if (!productId) return null;
  if (productCache[productId]) return productCache[productId];
  try {
    const prod = await moskitFetch(`/products/${productId}`);
    if (prod) {
      productCache[productId] = prod;
      return prod;
    }
  } catch (e) {
    console.warn(`[Moskit] Aviso ao buscar detalhes do produto ID ${productId}:`, e.message);
  }
  return null;
}

// Safe property retriever supporting dot notation and fallbacks (e.g. "company.name || deal.name")
function resolvePath(obj, pathStr, fallback = '') {
  if (!obj || !pathStr) return fallback;

  // Handle fallback OR syntax: "path1 || path2"
  const candidates = pathStr.split('||').map(s => s.trim());

  for (const candidate of candidates) {
    let current = obj;
    // Replace array index notation [0] with .0
    const parts = candidate.replace(/\[(\w+)\]/g, '.$1').split('.');

    let matched = true;
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        matched = false;
        break;
      }
    }

    if (matched && current !== null && current !== undefined && String(current).trim() !== '') {
      return String(current).trim();
    }
  }

  return fallback;
}

// Request helper for Moskit API
async function moskitFetch(endpoint, options = {}) {
  const apiKey = db.getSetting('moskit_api_key', '');
  if (!apiKey) {
    throw new Error('Chave de API do Moskit não configurada. Configure a API Key nas Configurações.');
  }

  const url = endpoint.startsWith('http') ? endpoint : `${MOSKIT_BASE_URL}${endpoint}`;
  const headers = {
    'apikey': apiKey.trim(),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorJson;
    try { errorJson = JSON.parse(errorText); } catch (e) {}
    const message = (errorJson && (errorJson.message || errorJson.error)) || response.statusText || errorText;
    throw new Error(`Erro na API do Moskit (${response.status}): ${message}`);
  }

  return response.json();
}

// Test Connection
async function testConnection(testApiKey = null) {
  const keyToTest = testApiKey || db.getSetting('moskit_api_key', '');
  if (!keyToTest) {
    return { success: false, message: 'Chave de API vazia.' };
  }

  try {
    const response = await fetch(`${MOSKIT_BASE_URL}/users/me`, {
      headers: {
        'apikey': keyToTest.trim(),
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message: 'Conexão realizada com sucesso!',
        user: data.name || data.username || data.email || 'Usuário Moskit'
      };
    } else {
      // Try alternate endpoint /deals?limit=1
      const altResp = await fetch(`${MOSKIT_BASE_URL}/deals?quantity=1`, {
        headers: { 'apikey': keyToTest.trim(), 'Accept': 'application/json' }
      });
      if (altResp.ok) {
        return { success: true, message: 'Conexão realizada com sucesso!' };
      }
      return { success: false, message: `Falha na autenticação (${response.status}). Verifique a chave de API.` };
    }
  } catch (err) {
    return { success: false, message: `Erro ao conectar com o Moskit: ${err.message}` };
  }
}

// Fetch list of all available fields (standard + custom fields)
async function getAvailableFields() {
  const standardFields = [
    // Empresa (Company)
    { id: 'company.name', label: 'Empresa: Nome Fantasia / Razão', category: 'Empresa' },
    { id: 'company.legalName', label: 'Empresa: Razão Social Completa', category: 'Empresa' },
    { id: 'company.cnpj', label: 'Empresa: CNPJ', category: 'Empresa' },
    { id: 'company.phone', label: 'Empresa: Telefone', category: 'Empresa' },
    { id: 'company.email', label: 'Empresa: E-mail', category: 'Empresa' },
    { id: 'company.address', label: 'Empresa: Endereço', category: 'Empresa' },
    { id: 'company.city', label: 'Empresa: Cidade', category: 'Empresa' },
    { id: 'company.state', label: 'Empresa: Estado (UF)', category: 'Empresa' },

    // Contato (Contact)
    { id: 'contact.name', label: 'Contato: Nome Completo', category: 'Contato' },
    { id: 'contact.cpf', label: 'Contato: CPF', category: 'Contato' },
    { id: 'contact.phones[0].number', label: 'Contato: Telefone / WhatsApp', category: 'Contato' },
    { id: 'contact.emails[0].address', label: 'Contato: E-mail Principal', category: 'Contato' },
    { id: 'contact.jobTitle', label: 'Contato: Cargo', category: 'Contato' },

    // Negócio (Deal)
    { id: 'deal.id', label: 'Negócio: ID do Negócio', category: 'Negócio' },
    { id: 'deal.name', label: 'Negócio: Título / Nome da Venda', category: 'Negócio' },
    { id: 'deal.price', label: 'Negócio: Valor Total (R$)', category: 'Negócio' },
    { id: 'deal.closeDate', label: 'Negócio: Data de Fechamento', category: 'Negócio' },
    { id: 'deal.dateCreated', label: 'Negócio: Data de Criação', category: 'Negócio' },
    { id: 'deal.stage.name', label: 'Negócio: Etapa do Funil', category: 'Negócio' },
    { id: 'deal.user.name', label: 'Negócio: Vendedor Responsável', category: 'Negócio' },
    { id: 'deal.description', label: 'Negócio: Descrição / Observações', category: 'Negócio' },

    // Combinações Práticas
    { id: 'company.name || deal.name', label: 'Nome Fantasia (Empresa ou Título da O.S.)', category: 'Combinações' },
    { id: 'company.cnpj || contact.cpf', label: 'Documento (CNPJ ou CPF)', category: 'Combinações' }
  ];

  const itemFields = [
    { id: 'dealProduct.quantity', label: 'Quantidade do Produto', category: 'Itens' },
    { id: 'dealProduct.product.name', label: 'Nome do Produto', category: 'Itens' },
    { id: 'dealProduct.product.model', label: 'Modelo do Produto', category: 'Itens' },
    { id: 'dealProduct.product.description', label: 'Descrição do Produto', category: 'Itens' },
    { id: 'dealProduct.price', label: 'Preço Unitário', category: 'Itens' }
  ];

  // Try to fetch custom fields from Moskit API if key is set
  const apiKey = db.getSetting('moskit_api_key', '');
  const customFields = [];

  if (apiKey) {
    try {
      const resp = await moskitFetch('/custom-fields');
      const list = Array.isArray(resp) ? resp : (resp.data || []);
      for (const cf of list) {
        const fieldKey = cf.key || cf.id || cf.name;
        const fieldLabel = cf.name || cf.label || `Campo ${cf.id}`;
        const moduleName = cf.module || (cf.entity ? cf.entity.toLowerCase() : 'custom');

        customFields.push({
          id: `customFields.${fieldKey}`,
          label: `Campo Personalizado: ${fieldLabel} (${moduleName})`,
          category: `Custom Fields (${moduleName})`,
          rawKey: fieldKey
        });

        // Also add product custom fields
        itemFields.push({
          id: `dealProduct.customFields.${fieldKey}`,
          label: `Item: ${fieldLabel}`,
          category: 'Itens Customizados'
        });
      }
    } catch (e) {
      console.warn('Não foi possível obter campos customizados via API:', e.message);
    }
  }

  // Common pre-configured custom fields for visual communication companies
  const commonCustomDefaults = [
    { id: 'customFields.forma_pagamento', label: 'Campo Personalizado: Forma de Pagamento', category: 'Comuns' },
    { id: 'customFields.prazo_pagamento', label: 'Campo Personalizado: Prazo de Pagamento', category: 'Comuns' },
    { id: 'customFields.frete', label: 'Campo Personalizado: Frete / Envio', category: 'Comuns' },
    { id: 'customFields.data_entrega', label: 'Campo Personalizado: Data de Entrega', category: 'Comuns' },
    { id: 'customFields.dimensao', label: 'Item: Dimensões (ex: 2x1m)', category: 'Comuns' },
    { id: 'customFields.modelo', label: 'Item: Modelo (ex: Pena, Faca, Gota)', category: 'Comuns' },
    { id: 'customFields.posicao', label: 'Item: Posição (ex: Frente/Verso)', category: 'Comuns' },
    { id: 'customFields.base', label: 'Item: Base (ex: Cruzada com bóia)', category: 'Comuns' }
  ];

  for (const c of commonCustomDefaults) {
    if (!customFields.some(x => x.id === c.id)) {
      customFields.push(c);
    }
  }

  return {
    orderFields: [...standardFields, ...customFields],
    itemFields: itemFields
  };
}

// Fetch Won Deals from Moskit API
async function fetchWonDeals(limit = 30) {
  // Moskit API endpoint for deals. Filter by status WON.
  let deals = [];
  try {
    // Try query with status=WON
    const res = await moskitFetch(`/deals?status=WON&quantity=${limit}&sort=-closeDate`);
    deals = Array.isArray(res) ? res : (res.data || []);
  } catch (err) {
    // Fallback: fetch recent deals and filter in memory
    try {
      const res = await moskitFetch(`/deals?quantity=${limit}`);
      const rawList = Array.isArray(res) ? res : (res.data || []);
      deals = rawList.filter(d => String(d.status).toUpperCase() === 'WON' || d.won === true || d.status === 'Ganhou');
    } catch (err2) {
      throw err;
    }
  }

  return deals;
}

// Fetch Full Deal Details (including contact, company, products)
async function fetchFullDeal(dealId) {
  const deal = await moskitFetch(`/deals/${dealId}`);

  // Fetch products associated with this deal
  try {
    const productsRes = await moskitFetch(`/deals/${dealId}/products`);
    deal.dealProducts = Array.isArray(productsRes) ? productsRes : (productsRes.data || []);
  } catch (e) {
    // Some endpoints may include products inside the deal object already
    if (!deal.dealProducts) {
      deal.dealProducts = deal.products || [];
    }
  }

  // Hydrate products with SKU and details if missing
  const rawProds = deal.dealProducts || deal.products || [];
  if (Array.isArray(rawProds)) {
    for (const dp of rawProds) {
      if (dp.product && dp.product.id && (!dp.product.sku || !dp.product.name)) {
        const prodData = await fetchProductById(dp.product.id);
        if (prodData) {
          dp.product = { ...prodData, ...dp.product };
        }
      }
    }
    deal.dealProducts = rawProds;
  }

  // Fetch company details if linked
  if (deal.company && deal.company.id && !deal.company.cnpj) {
    try {
      const comp = await moskitFetch(`/companies/${deal.company.id}`);
      deal.company = { ...deal.company, ...comp };
    } catch (e) {}
  }

  // Fetch contact details if linked
  if (deal.contact && deal.contact.id && (!deal.contact.phones || deal.contact.phones.length === 0)) {
    try {
      const cont = await moskitFetch(`/contacts/${deal.contact.id}`);
      deal.contact = { ...deal.contact, ...cont };
    } catch (e) {}
  }

  return deal;
}

// Transform Moskit Deal to Service Order using saved Field Mappings and SKU Dictionary
function mapDealToServiceOrder(dealData) {
  const mappingsList = db.getFieldMappings();
  const mapLookup = {};
  for (const m of mappingsList) {
    mapLookup[m.os_field] = m;
  }

  // Flatten custom fields for easier path resolution
  const flatCustomFields = {};
  if (Array.isArray(dealData.customFields)) {
    for (const cf of dealData.customFields) {
      const k = cf.customField ? (cf.customField.id || cf.customField.key || cf.customField.name) : (cf.id || cf.key);
      const val = cf.value !== undefined ? cf.value : (cf.textValue || cf.numericValue || cf.dateValue);
      if (k) flatCustomFields[k] = val;
    }
  } else if (dealData.customFields && typeof dealData.customFields === 'object') {
    Object.assign(flatCustomFields, dealData.customFields);
  }

  // Normalize data container for resolver
  const context = {
    deal: dealData,
    company: dealData.company || {},
    contact: dealData.contact || {},
    customFields: flatCustomFields
  };

  function getVal(fieldKey, defaultFallback = '') {
    const mapping = mapLookup[fieldKey];
    if (mapping && mapping.moskit_source) {
      const resolved = resolvePath(context, mapping.moskit_source, mapping.fallback_value || defaultFallback);
      return resolved || defaultFallback;
    }
    return defaultFallback;
  }

  // Format delivery date nicely if found
  let deliveryDate = getVal('data_entrega');
  if (deliveryDate && deliveryDate.includes('T')) {
    try {
      const d = new Date(deliveryDate);
      if (!isNaN(d.getTime())) {
        deliveryDate = d.toLocaleDateString('pt-BR');
      }
    } catch (e) {}
  }

  const orderData = {
    moskit_deal_id: dealData.id,
    data_os: new Date().toLocaleDateString('pt-BR'),
    nome_fantasia: getVal('nome_fantasia', dealData.name || (dealData.company && dealData.company.name) || ''),
    razao_social: getVal('razao_social', (dealData.company && (dealData.company.legalName || dealData.company.name)) || ''),
    cnpj_cpf: getVal('cnpj_cpf', (dealData.company && dealData.company.cnpj) || ''),
    contato_nome: getVal('contato_nome', (dealData.contact && dealData.contact.name) || ''),
    contato_telefone: getVal('contato_telefone', (dealData.contact && dealData.contact.phones && dealData.contact.phones[0] && dealData.contact.phones[0].number) || ''),
    contato_email: getVal('contato_email', (dealData.contact && dealData.contact.emails && dealData.contact.emails[0] && dealData.contact.emails[0].address) || ''),
    data_entrega: deliveryDate,
    forma_pagamento: getVal('forma_pagamento', db.getSetting('default_forma_pagamento', 'PIX')),
    prazo_pagamento: getVal('prazo_pagamento', db.getSetting('default_prazo_pagamento', 'À Vista')),
    frete: getVal('frete', db.getSetting('default_frete', 'Incluso')),
    status: 'won',
    observacoes: dealData.description || '',
    raw_deal_data: dealData
  };

  // Map products/items using SKU dictionary
  const items = [];
  const rawProducts = dealData.dealProducts || dealData.products || [];

  if (Array.isArray(rawProducts) && rawProducts.length > 0) {
    rawProducts.forEach((dp, index) => {
      const prodContext = {
        dealProduct: dp,
        product: dp.product || {},
        customFields: dp.customFields || {}
      };

      // 1. Identify SKU from deal product or product object
      const rawSku = (dp.product && dp.product.sku) || dp.sku || (dp.product && dp.product.code) || '';
      
      // 2. Resolve via SKU Dictionary (DB parametrization first, then fallback to parser)
      let skuInfo = null;
      if (rawSku) {
        skuInfo = db.getProductSkuBySku(rawSku);
        if (!skuInfo) {
          skuInfo = skuDictionary.parseSku(rawSku);
        }
      }

      function getItemVal(fieldKey, defaultFallback = '') {
        const mapping = mapLookup[fieldKey];
        if (mapping && mapping.moskit_source) {
          return resolvePath(prodContext, mapping.moskit_source, mapping.fallback_value || defaultFallback);
        }
        return defaultFallback;
      }

      // Prioritize SKU dictionary values over direct Moskit fields for prod, modelo, dimensao, posicao, base
      const itemProd = (skuInfo && skuInfo.prod) || getItemVal('item_prod', (dp.product && dp.product.name) || dp.name || `Item ${index + 1}`);
      const itemModelo = (skuInfo && skuInfo.modelo) || getItemVal('item_modelo', (dp.product && dp.product.model) || '');
      const itemDimensao = (skuInfo && skuInfo.dimensao) || getItemVal('item_dimensao', '');
      const itemPosicao = (skuInfo && skuInfo.posicao) || getItemVal('item_posicao', '');
      const itemBase = (skuInfo && skuInfo.base) || getItemVal('item_base', '');

      items.push({
        sku: rawSku || (skuInfo && skuInfo.sku) || '',
        qtde: getItemVal('item_qtde', String(dp.quantity || '1')),
        prod: itemProd,
        modelo: itemModelo,
        dimensao: itemDimensao,
        posicao: itemPosicao,
        base: itemBase,
        preco_unitario: parseFloat(dp.price || dp.unitaryValue || 0),
        ordem: index
      });
    });
  } else {
    // If no products attached, add at least 1 row using deal name
    items.push({
      sku: '',
      qtde: '1',
      prod: dealData.name || 'Wind Banner Personalizado',
      modelo: '',
      dimensao: '',
      posicao: '',
      base: '',
      preco_unitario: parseFloat(dealData.price || 0),
      ordem: 0
    });
  }

  return { orderData, items };
}

// Process and Save Deal (from Webhook or Sync)
async function importDeal(dealData) {
  // Check if deal already exists in local DB
  const existingOrder = db.getOrderByMoskitId(dealData.id);
  const { orderData, items } = mapDealToServiceOrder(dealData);

  if (existingOrder) {
    // Update existing, preserve existing photo and budget number!
    orderData.orcamento_numero = existingOrder.orcamento_numero;
    orderData.photo_filename = existingOrder.photo_filename;
    orderData.template_id = existingOrder.template_id;

    const updated = db.updateOrder(existingOrder.id, orderData, items);
    return { action: 'updated', order: updated };
  } else {
    // Create new order with sequential orcamento_numero
    const newOrder = db.createOrder(orderData, items);
    return { action: 'created', order: newOrder };
  }
}

// Sync all Won Deals from Moskit
async function syncWonDeals() {
  const wonDeals = await fetchWonDeals(50);
  const results = {
    total: wonDeals.length,
    created: 0,
    updated: 0,
    errors: []
  };

  for (const deal of wonDeals) {
    try {
      // Fetch full details to hydrate products and SKUs
      let fullDeal = deal;
      try {
        fullDeal = await fetchFullDeal(deal.id);
      } catch (e) {
        fullDeal = deal;
      }

      const res = await importDeal(fullDeal);
      if (res.action === 'created') results.created++;
      else if (res.action === 'updated') results.updated++;
    } catch (err) {
      results.errors.push({ dealId: deal.id, error: err.message });
    }
  }

  db.setSetting('last_moskit_sync', new Date().toISOString());
  return results;
}

// Sincronizar produtos e cadastrar SKUs do Moskit no banco de dados
async function syncMoskitSkus() {
  try {
    const products = await moskitFetch('/products?quantity=50');
    const list = Array.isArray(products) ? products : (products.data || []);
    let added = 0;
    let updated = 0;

    for (const p of list) {
      if (!p.sku) continue;
      const existing = db.getProductSkuBySku(p.sku);
      const parsed = skuDictionary.parseSku(p.sku);

      if (existing) {
        if (!existing.descricao && p.name) {
          existing.descricao = p.name;
          db.saveProductSku(existing);
          updated++;
        }
      } else {
        db.saveProductSku({
          sku: p.sku,
          prod: (parsed && parsed.prod) || p.name || 'Produto',
          modelo: (parsed && parsed.modelo) || '',
          dimensao: (parsed && parsed.dimensao) || '',
          posicao: (parsed && parsed.posicao) || '',
          base: (parsed && parsed.base) || '',
          descricao: p.name || ''
        });
        added++;
      }
      productCache[p.id] = p;
    }

    return { success: true, total: list.length, added, updated };
  } catch (e) {
    throw new Error(`Falha ao sincronizar SKUs do Moskit: ${e.message}`);
  }
}

module.exports = {
  moskitFetch,
  testConnection,
  getAvailableFields,
  fetchWonDeals,
  fetchFullDeal,
  fetchProductById,
  mapDealToServiceOrder,
  importDeal,
  syncWonDeals,
  syncMoskitSkus
};
