// contatosService.js - Diagnóstico de contatos Bling x Moskit (Etapa 1: SOMENTE LEITURA)
//
// Compara os clientes do Bling (referência) com os contatos (pessoa física, CPF)
// e empresas (pessoa jurídica, CNPJ) do Moskit, sempre pelos DÍGITOS do documento.
// Nada é gravado no Bling nem no Moskit. O resultado fica em data/contatos_diagnostico.json.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const blingService = require('./blingService');

const MOSKIT_BASE_URL = 'https://api.moskitcrm.com/v2';
const ARQUIVO = path.join(__dirname, 'data', 'contatos_diagnostico.json');
const TIPO_CLIENTE = 'cliente';

// ---------------------------------------------------------------
// Padronização
// ---------------------------------------------------------------
const digitos = (v) => String(v ?? '').replace(/\D/g, '');

function cpfValido(c) {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === +c[9] && dv(10) === +c[10];
}
function cnpjValido(c) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (n) => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let s = 0; for (let i = 0; i < n; i++) s += +c[i] * w[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === +c[12] && calc(13) === +c[13];
}
function docZerado(d) { return !!d && /^0+$/.test(d); }
function formatarDoc(d) {
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

// Telefone no padrão (DD) 99999-9999 / (DD) 9999-9999
function analisarTelefone(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return { original, digitos: '', padrao: '', problema: '', final: '', digitosFinal: '' };
  if (/[a-zA-Z]{3,}/.test(original)) return { original, digitos: '', padrao: '', problema: 'texto no lugar do telefone', final: '', digitosFinal: '' };
  let d = digitos(original);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length > 11 && d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1); // 0 + DDD + 8 dígitos
  if (d.length === 8 || d.length === 9) return { original, digitos: d, padrao: '', problema: 'sem DDD', final: '', digitosFinal: d };
  if (d.length !== 10 && d.length !== 11) return { original, digitos: d, padrao: '', problema: 'quantidade de dígitos inválida', final: '', digitosFinal: d };
  const ddd = d.slice(0, 2), num = d.slice(2);
  const padrao = num.length === 9 ? `(${ddd}) ${num.slice(0, 5)}-${num.slice(5)}` : `(${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`;
  const problema = (num.length === 8 && /^[6-9]/.test(num)) ? 'celular sem o 9' : '';
  // "final": padrão a gravar. Celular sem o 9 recebe o 9 (decisão do usuário: incluir nos 2 sistemas)
  const final = problema ? `(${ddd}) 9${num.slice(0, 4)}-${num.slice(4)}` : padrao;
  const digitosFinal = problema ? ddd + '9' + num : d;
  return { original, digitos: d, padrao, problema, final, digitosFinal };
}

// O Moskit guarda no máximo 60 caracteres no nome: a comparação usa só os 60 primeiros
function mesmoNome(a, b) {
  return normNome(String(a ?? '').slice(0, 60)) === normNome(String(b ?? '').slice(0, 60));
}

function normNome(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim();
}

// ---------------------------------------------------------------
// Leitura das APIs
// ---------------------------------------------------------------
async function moskitPagina(entidade, token) {
  const apiKey = String(db.getSetting('moskit_api_key', '') || '').trim();
  if (!apiKey) throw new Error('Chave de API do Moskit não configurada.');
  const qs = new URLSearchParams({ quantity: '50' });
  if (token) qs.set('nextPageToken', token);
  for (let tentativa = 1; ; tentativa++) {
    const resp = await fetch(`${MOSKIT_BASE_URL}/${entidade}?${qs}`, {
      headers: { apikey: apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(30000)
    });
    if (resp.status === 429 && tentativa <= 5) { await new Promise(r => setTimeout(r, 2000 * tentativa)); continue; }
    if (!resp.ok) throw new Error(`Moskit (${resp.status}) ao listar ${entidade}: ${(await resp.text()).slice(0, 200)}`);
    return { dados: await resp.json(), proximo: resp.headers.get('x-moskit-listing-next-page-token') };
  }
}

async function moskitTodos(entidade, onProgresso) {
  const out = [];
  let token = null, paginas = 0;
  do {
    const { dados, proximo } = await moskitPagina(entidade, token);
    if (!Array.isArray(dados) || !dados.length) break;
    out.push(...dados);
    token = proximo;
    paginas++;
    onProgresso && onProgresso(out.length);
  } while (token && paginas < 1000);
  return out;
}

async function blingTiposContato() {
  // O tipo "Cliente" é identificado pelo nome; o id muda de conta para conta.
  try {
    const r = await blingService.blingFetch('GET', '/contatos/tipos');
    return Array.isArray(r.data) ? r.data : [];
  } catch (e) { return []; }
}

async function blingClientes(onProgresso) {
  const tipos = await blingTiposContato();
  const tipoCliente = tipos.find(t => normNome(t.descricao) === 'CLIENTE');
  const out = [];
  for (let pagina = 1; pagina <= 500; pagina++) {
    const r = await blingService.blingFetch('GET', '/contatos', {
      query: { pagina, limite: 100, criterio: 1, idTipoContato: tipoCliente ? tipoCliente.id : undefined }
    });
    const lista = Array.isArray(r.data) ? r.data : [];
    out.push(...lista);
    onProgresso && onProgresso(out.length);
    if (lista.length < 100) break;
  }
  return { contatos: out.filter(c => !c.situacao || c.situacao === 'A'), filtradoPorTipo: !!tipoCliente };
}

// ---------------------------------------------------------------
// Comparação
// ---------------------------------------------------------------
function telefonesMoskit(ent) {
  const lista = [];
  if (ent.primaryPhone && ent.primaryPhone.number) lista.push(ent.primaryPhone.number);
  for (const p of ent.phones || []) if (p && p.number && !lista.includes(p.number)) lista.push(p.number);
  return lista;
}

function resumoMoskit(ent, tipo) {
  const doc = digitos(tipo === 'empresa' ? ent.cnpj : ent.cpf);
  const tels = telefonesMoskit(ent);
  return {
    tipo, id: ent.id, nome: ent.name || '', doc: doc ? formatarDoc(doc) : '',
    telefone: tels[0] || '', telefones: tels,
    email: ((ent.emails || [])[0] || {}).address || (ent.primaryEmail && ent.primaryEmail.address) || ''
  };
}

function comparar(blingLista, contatosMk, empresasMk, meta) {
  const porDoc = new Map();      // dígitos -> [{ent, tipo}]
  const semDocPorNome = new Map();
  const semDocPorTel = new Map();
  const problemasMoskit = [];
  let ignoradosZerados = 0;

  const registrar = (ent, tipo) => {
    const bruto = tipo === 'empresa' ? ent.cnpj : ent.cpf;
    const d = digitos(bruto);
    const tels = telefonesMoskit(ent).map(analisarTelefone);
    for (const t of tels) if (t.problema) problemasMoskit.push({ ...resumoMoskit(ent, tipo), problema: `Telefone "${t.original}": ${t.problema}` });
    if (docZerado(d)) { ignoradosZerados++; return; } // decisão do usuário: ignorar CNPJ zerado
    if (d) {
      const valido = d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false;
      if (!valido) problemasMoskit.push({ ...resumoMoskit(ent, tipo), problema: `${tipo === 'empresa' ? 'CNPJ' : 'CPF'} inválido: ${bruto}` });
      if (!porDoc.has(d)) porDoc.set(d, []);
      porDoc.get(d).push({ ent, tipo });
      return;
    }
    const n = normNome(ent.name);
    if (n) { if (!semDocPorNome.has(n)) semDocPorNome.set(n, []); semDocPorNome.get(n).push({ ent, tipo }); }
    for (const t of tels) if (t.digitos && t.digitos.length >= 10) {
      if (!semDocPorTel.has(t.digitos)) semDocPorTel.set(t.digitos, []);
      semDocPorTel.get(t.digitos).push({ ent, tipo });
    }
  };
  contatosMk.forEach(c => registrar(c, 'contato'));
  empresasMk.forEach(c => registrar(c, 'empresa'));

  for (const [d, lista] of porDoc) if (lista.length > 1) {
    problemasMoskit.push({ tipo: lista[0].tipo, id: lista.map(x => x.ent.id).join(', '), nome: lista.map(x => x.ent.name).join(' / '), doc: formatarDoc(d), problema: `Documento repetido em ${lista.length} cadastros` });
  }

  const docsBling = new Set();
  const blingPorDoc = new Map();
  const itens = [];
  const problemasBling = [];

  for (const b of blingLista) {
    const d = digitos(b.numeroDocumento);
    const telB = analisarTelefone(b.telefone || b.celular);
    const base = {
      blingId: b.id, nome: b.nome || '', doc: d ? formatarDoc(d) : '', pessoa: d.length === 14 ? 'J' : d.length === 11 ? 'F' : '',
      telefoneBling: telB.original, telefonePadrao: telB.final, moskit: null, diferencas: [], sugestoes: [], alertas: []
    };
    if (telB.problema) base.alertas.push(`Telefone no Bling: ${telB.problema}`);

    if (!d || docZerado(d)) { itens.push({ ...base, status: 'sem_documento' }); continue; }
    if (meta.excluidos && meta.excluidos.includes(d)) base.alertas.push('Excluído da sincronização (decisão do usuário)');
    const valido = d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false;
    if (!valido) problemasBling.push({ blingId: b.id, nome: b.nome, doc: b.numeroDocumento, problema: 'CPF/CNPJ inválido' });
    if (blingPorDoc.has(d)) {
      problemasBling.push({ blingId: `${blingPorDoc.get(d)}, ${b.id}`, nome: b.nome, doc: formatarDoc(d), problema: 'Documento repetido em mais de um cadastro do Bling' });
    } else blingPorDoc.set(d, b.id);
    docsBling.add(d);

    const achados = porDoc.get(d) || [];
    if (!achados.length) {
      // Possíveis correspondências entre cadastros do Moskit SEM documento (confirmação manual)
      const sug = new Map();
      for (const x of semDocPorNome.get(normNome(b.nome)) || []) sug.set(x.ent.id, { ...resumoMoskit(x.ent, x.tipo), motivo: 'mesmo nome' });
      if (telB.digitos && telB.digitos.length >= 10) for (const x of semDocPorTel.get(telB.digitos) || []) {
        const ja = sug.get(x.ent.id);
        sug.set(x.ent.id, ja ? { ...ja, motivo: 'mesmo nome e telefone' } : { ...resumoMoskit(x.ent, x.tipo), motivo: 'mesmo telefone' });
      }
      itens.push({ ...base, status: sug.size ? 'possivel' : 'falta', sugestoes: [...sug.values()].slice(0, 5) });
      continue;
    }

    // Preferência: PF -> contato, PJ -> empresa
    const esperado = d.length === 11 ? 'contato' : 'empresa';
    const escolhido = achados.find(x => x.tipo === esperado) || achados[0];
    const mk = resumoMoskit(escolhido.ent, escolhido.tipo);
    const item = { ...base, moskit: mk };
    if (escolhido.tipo !== esperado) item.alertas.push(`No Moskit está cadastrado como ${escolhido.tipo}`);

    if (!mesmoNome(b.nome, mk.nome)) item.diferencas.push({ campo: 'Nome', bling: b.nome || '', moskit: mk.nome || '(vazio)' });
    let soFormato = false;
    if (telB.digitos) {
      const telsMk = mk.telefones.map(analisarTelefone);
      const igual = telsMk.find(t => t.digitos && (t.digitos === telB.digitos || (t.digitosFinal && t.digitosFinal === telB.digitosFinal)));
      if (!igual) item.diferencas.push({ campo: 'Telefone', bling: telB.original, moskit: mk.telefones.join(' / ') || '(vazio)' });
      else if (telB.final && igual.original !== telB.final) soFormato = true;
    }
    item.status = item.diferencas.length ? 'divergente' : (soFormato ? 'formato' : 'ok');
    itens.push(item);
  }

  // Cadastros do Moskit com documento que não existe entre os clientes do Bling
  const soMoskit = [];
  for (const [d, lista] of porDoc) if (!docsBling.has(d)) for (const x of lista) soMoskit.push(resumoMoskit(x.ent, x.tipo));

  const contar = (s) => itens.filter(i => i.status === s).length;
  return {
    geradoEm: new Date().toISOString(),
    meta: { ...meta, ignoradosCnpjZerado: ignoradosZerados },
    resumo: {
      clientesBling: blingLista.length,
      ok: contar('ok'), formato: contar('formato'), divergente: contar('divergente'),
      falta: contar('falta'), possivel: contar('possivel'), semDocumento: contar('sem_documento'),
      soNoMoskit: soMoskit.length, problemasMoskit: problemasMoskit.length, problemasBling: problemasBling.length
    },
    itens, soMoskit, problemasMoskit, problemasBling
  };
}

// ---------------------------------------------------------------
// Execução em segundo plano
// ---------------------------------------------------------------
const estado = { rodando: false, etapa: '', inicio: null, erro: null };

// CPF/CNPJ (só dígitos) que nunca são alterados pela sincronização. Padrão: INSTITUTO BW (decisão do usuário)
const EXCLUIDOS_PADRAO = ['35960609000197'];
function excluidosDocs() {
  try {
    const blingDb = require('./blingDb');
    const v = blingDb.getConfig('contatos_excluidos', '');
    const lista = String(v || '').split(/[\s,;]+/).map(digitos).filter(Boolean);
    return [...new Set([...EXCLUIDOS_PADRAO, ...lista])];
  } catch (e) { return EXCLUIDOS_PADRAO; }
}

function lerResultado() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')); } catch (e) { return null; }
}

function iniciarDiagnostico() {
  if (estado.rodando) return { iniciado: false, motivo: 'Já existe uma verificação em andamento.' };
  Object.assign(estado, { rodando: true, etapa: 'Lendo clientes do Bling…', inicio: new Date().toISOString(), erro: null });
  (async () => {
    try {
      const { contatos: bling, filtradoPorTipo } = await blingClientes(n => { estado.etapa = `Lendo clientes do Bling… ${n}`; });
      const contatos = await moskitTodos('contacts', n => { estado.etapa = `Lendo contatos do Moskit… ${n}`; });
      const empresas = await moskitTodos('companies', n => { estado.etapa = `Lendo empresas do Moskit… ${n}`; });
      estado.etapa = 'Comparando…';
      const r = comparar(bling, contatos, empresas, {
        excluidos: excluidosDocs(),
        filtradoPorTipoCliente: filtradoPorTipo, contatosMoskit: contatos.length, empresasMoskit: empresas.length,
        duracaoSeg: Math.round((Date.now() - Date.parse(estado.inicio)) / 1000)
      });
      fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
      const tmp = ARQUIVO + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(r));
      fs.renameSync(tmp, ARQUIVO);
    } catch (e) {
      estado.erro = e.message;
    } finally {
      estado.rodando = false;
      estado.etapa = '';
    }
  })();
  return { iniciado: true };
}

function status() {
  return { ...estado, resultado: lerResultado() };
}

module.exports = {
  iniciarDiagnostico, status, lerResultado, excluidosDocs,
  // usados pela sincronização
  blingClientes, moskitTodos, comparar, analisarTelefone, normNome, mesmoNome, formatarDoc, digitos,
  _internals: { analisarTelefone, normNome, cpfValido, cnpjValido, formatarDoc, comparar }
};
