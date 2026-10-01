// skuDictionary.js - Dicionário de dados e Decomposição de SKUs para Marca Vento

const PRODUCT_PREFIXES = [
  { prefix: 'RWBB', prod: 'Refil Wind Banner', defaultModelo: 'Box' },
  { prefix: 'RWBD', prod: 'Refil Wind Banner', defaultModelo: 'Diagonal' },
  { prefix: 'RWBP', prod: 'Refil Wind Banner', defaultModelo: 'Pena' },
  { prefix: 'RWBV', prod: 'Refil Wind Banner', defaultModelo: 'Vela' },
  { prefix: 'RWBG', prod: 'Refil Wind Banner', defaultModelo: 'Gota' },
  { prefix: 'RWBR', prod: 'Refil Wind Banner', defaultModelo: 'Reta' },
  { prefix: 'RWB', prod: 'Refil Wind Banner' },
  { prefix: 'RBD', prod: 'Refil Backdrop' },
  { prefix: 'WBB', prod: 'Wind Banner', defaultModelo: 'Box' },
  { prefix: 'WBP', prod: 'Wind Banner', defaultModelo: 'Pena' },
  { prefix: 'WBV', prod: 'Wind Banner', defaultModelo: 'Vela' },
  { prefix: 'WBG', prod: 'Wind Banner', defaultModelo: 'Gota' },
  { prefix: 'WBR', prod: 'Wind Banner', defaultModelo: 'Reta' },
  { prefix: 'WBD', prod: 'Wind Banner', defaultModelo: 'Diagonal' },
  { prefix: 'WBF', prod: 'Wind Banner', defaultModelo: 'Faca' },
  { prefix: 'WB', prod: 'Wind Banner' },
  { prefix: 'BD', prod: 'Backdrop' },
  { prefix: 'BAN', prod: 'Bandeira' },
  { prefix: 'BA', prod: 'Banner' },
  { prefix: 'BCG', prod: 'Bandeira Capô', defaultModelo: 'Grande (SUV)' },
  { prefix: 'BCP', prod: 'Bandeira Capô', defaultModelo: 'Padrão' },
  { prefix: 'BVG', prod: 'Bandeira de Vestir', defaultModelo: 'Grande' },
  { prefix: 'BVI', prod: 'Bandeira de Vestir', defaultModelo: 'Infantil' },
  { prefix: 'BVM', prod: 'Bandeira de Vestir', defaultModelo: 'Médio' },
  { prefix: 'BVP', prod: 'Bandeira de Vestir', defaultModelo: 'Pequeno' },
  { prefix: 'CG', prod: 'Capa de Gradil' },
  { prefix: 'CJH', prod: 'Conjunto de Hastes' },
  { prefix: 'FAP', prod: 'Faixa' }
];

const MODEL_MAP = {
  'B': 'Box',
  'P': 'Pena',
  'V': 'Vela',
  'G': 'Gota',
  'R': 'Reta',
  'D': 'Diagonal',
  'F': 'Faca',
  'M': 'Mochila'
};

const POSITION_MAP = {
  'FD': 'Face Dupla',
  'FS': 'Face Simples',
  'FU': 'Frente Única',
  'DU': 'Dupla',
  'SI': 'Simples'
};

const BASE_MAP = {
  'SO': 'Solo',
  'PL': 'Plástica',
  'RE': 'Reta',
  'IN': 'Inclinada',
  'CR': 'Cruzada',
  'SB': 'Sem Base',
  'BO': 'Bóia / Água'
};

function formatDimension(dimStr) {
  if (!dimStr) return '';
  const upper = String(dimStr).toUpperCase();
  if (upper.includes('X')) {
    const parts = upper.split('X');
    const p0 = formatSingleDimension(parts[0]);
    const p1 = formatSingleDimension(parts[1]);
    return `${p0} x ${p1}`;
  }
  return formatSingleDimension(upper);
}

function formatSingleDimension(d) {
  const num = parseInt(d, 10);
  if (isNaN(num)) return d;
  if (num >= 50 && num <= 900) {
    const meters = (num / 100).toFixed(2).replace('.', ',');
    return meters;
  }
  return String(d);
}

/**
 * Parses an SKU according to Marca Vento rules
 * Example: "WBB200FDSO"
 * Product: WB = "Wind Banner"
 * Model: B = "Box"
 * Dimension: 200 = "2,00"
 * Position: FD = "Face Dupla"
 * Base: SO = "Solo"
 */
function parseSku(rawSku) {
  if (!rawSku) return null;
  const sku = String(rawSku).trim().toUpperCase();

  let prod = '';
  let modelo = '';
  let dimensao = '';
  let posicao = '';
  let base = '';

  let rem = sku;

  // 1. Identify Product Prefix
  for (const item of PRODUCT_PREFIXES) {
    if (rem.startsWith(item.prefix)) {
      prod = item.prod;
      if (item.defaultModelo) modelo = item.defaultModelo;
      rem = rem.substring(item.prefix.length);
      break;
    }
  }

  if (!prod) {
    prod = sku; // fallback
    return { sku, prod, modelo, dimensao, posicao, base };
  }

  // 2. Identify Model if not set or if next char is a known single-letter model
  if (!modelo && rem.length > 0) {
    const firstChar = rem[0];
    if (MODEL_MAP[firstChar] && isNaN(parseInt(firstChar, 10))) {
      modelo = MODEL_MAP[firstChar];
      rem = rem.substring(1);
    }
  }

  // 3. Check for Base at the end
  for (const [code, label] of Object.entries(BASE_MAP)) {
    if (rem.endsWith(code)) {
      base = label;
      rem = rem.substring(0, rem.length - code.length);
      break;
    }
  }

  // If it's a refil and no base specified, base is typically "Sem Base"
  if (!base && (prod.includes('Refil') || sku.startsWith('R'))) {
    base = 'Sem Base';
  }

  // 4. Check for Position at the end
  for (const [code, label] of Object.entries(POSITION_MAP)) {
    if (rem.endsWith(code)) {
      posicao = label;
      rem = rem.substring(0, rem.length - code.length);
      break;
    }
  }

  // 5. Remaining string is usually dimension (e.g. "200", "250", "300X200", "200X160")
  if (rem.length > 0) {
    dimensao = formatDimension(rem);
  }

  return {
    sku,
    prod,
    modelo,
    dimensao,
    posicao,
    base
  };
}

module.exports = {
  parseSku,
  formatDimension,
  PRODUCT_PREFIXES,
  MODEL_MAP,
  POSITION_MAP,
  BASE_MAP
};
