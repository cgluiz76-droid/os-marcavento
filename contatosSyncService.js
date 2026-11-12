// contatosSyncService.js - Etapa 2: sincronização de clientes Bling -> Moskit
//
// Regras (decisões do usuário, 12/11/2026):
// - O Bling é a referência. O Moskit recebe nome, telefone, e-mail, endereço,
//   nome fantasia e IE (empresas).
// - Celular sem o 9 recebe o 9 nos DOIS sistemas.
// - Nome comparado só pelos 60 primeiros caracteres (limite do Moskit).
// - Pessoa física que está no Moskit como "empresa" sem CPF: só atualiza a empresa (sem CPF).
// - INSTITUTO BW (e quem estiver na lista de exclusão) não é alterado.
// - Cadastros só do Moskit ficam como estão; nada é apagado.
//
// Segurança:
// - "Preparar" só lê. "Aplicar" só grava o que foi confirmado na tela.
// - Antes de cada gravação o cadastro é lido de novo; depois é conferido.
// - O cadastro completo anterior é guardado em data/contatos_sync_backup.jsonl.
// - Se uma gravação no Moskit alterar vínculos (negócios, contatos, atividades),
//   o cadastro é restaurado e a aplicação PARA.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const blingService = require('./blingService');
const cs = require('./contatosService');
const keepAlive = require('./keepAlive');

const MOSKIT = 'https://api.moskitcrm.com/v2';
const DIR = path.join(__dirname, 'data');
const ARQ_PLANO = path.join(DIR, 'contatos_sync_plano.json');
const ARQ_BACKUP = path.join(DIR, 'contatos_sync_backup.jsonl');
const ARQ_PROGRESSO = path.join(DIR, 'contatos_sync_progresso.json');

const CF = {
  empresa: {
    endereco: 'CF_dVKmQlU1C6vlAMWR', numero: 'CF_Rg7MnpULCdaxjDvd', complemento: 'CF_6rRmw4UvCJbllD4X',
    bairro: 'CF_VRAqd4UdCa5L3qbL', cep: 'CF_Lo1qjxU1C4wgJmer', municipio: 'CF_2ojMxGUPCoWlaqOE',
    uf: 'CF_dVKmQlUbi6voQMWR', ie: 'CF_2wpDloUnCanjzmvL', fantasia: 'CF_0WGqopUKCxrzAMnP'
  },
  contato: {
    endereco: 'CF_POEMyESeC56RZMdk', numero: 'CF_3LvDvKS4CLBQpq6a', complemento: 'CF_wGrqzySVCpj2ODLo',
    bairro: 'CF_E79MrESoCejPjqZJ', cep: 'CF_QJXmAjSjCydERD25', municipio: 'CF_8P5q4aS2C4ObBMRJ',
    uf: 'CF_dVKmQASbi6voVmWR'
  }
};
const ROTULO = { endereco: 'Endereço', numero: 'Número', complemento: 'Complemento', bairro: 'Bairro', cep: 'CEP', municipio: 'Cidade', uf: 'UF', ie: 'Inscrição Estadual', fantasia: 'Nome fantasia' };
const VINCULOS = { empresa: ['deals', 'employees', 'activities', 'projects', 'dealParticipants', 'projectParticipants'], contato: ['deals', 'employers', 'activities', 'projects', 'dealParticipants', 'projectParticipants'] };

const dig = cs.digitos;
const norm = (v) => cs.normNome(v);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------
// Moskit
// ---------------------------------------------------------------
let ultimoMoskit = 0;
async function moskit(method, caminho, body) {
  const apiKey = String(db.getSetting('moskit_api_key', '') || '').trim();
  if (!apiKey) throw new Error('Chave de API do Moskit não configurada.');
  for (let tentativa = 1; ; tentativa++) {
    const espera = 250 - (Date.now() - ultimoMoskit);
    if (espera > 0) await sleep(espera);
    ultimoMoskit = Date.now();
    const resp = await fetch(MOSKIT + caminho, {
      method,
      headers: { apikey: apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
    // Só leituras são repetidas automaticamente
    if (resp.status === 429 && method === 'GET' && tentativa <= 5) { await sleep(2000 * tentativa); continue; }
    const texto = await resp.text();
    let json = null; try { json = texto ? JSON.parse(texto) : {}; } catch (e) {}
    if (!resp.ok) {
      const msg = (json && (json.message || json.detail || json.title)) || texto.slice(0, 300);
      const err = new Error(`Moskit (${resp.status}) ${method} ${caminho}: ${msg}`);
      err.status = resp.status;
      throw err;
    }
    return json;
  }
}

let ufCache = null;
async function opcoesUf() {
  if (ufCache) return ufCache;
  const out = {};
  for (const tipo of ['empresa', 'contato']) {
    const lista = await moskit('GET', `/customFields/${CF[tipo].uf}/options?quantity=50`);
    out[tipo] = Object.fromEntries((lista || []).map(o => [String(o.label || '').toUpperCase(), o.id]));
  }
  ufCache = out;
  return out;
}

// ---------------------------------------------------------------
// O que o Bling diz (referência)
// ---------------------------------------------------------------
function desejadoDoBling(b, pessoaMoskit) {
  const g = (b.endereco && b.endereco.geral) || {};
  const tel = cs.analisarTelefone(b.telefone || b.celular);
  const email = String(b.email || '').split(/[;,\s]+/).map(x => x.trim()).find(x => /@/.test(x)) || '';
  const cep = dig(g.cep);
  const doc = dig(b.numeroDocumento);
  return {
    nome: String(b.nome || '').trim(),
    doc,
    telefone: tel.final || '',
    telefoneDigitos: tel.digitosFinal || '',
    email,
    endereco: {
      endereco: g.endereco || '', numero: g.numero || '', complemento: g.complemento || '', bairro: g.bairro || '',
      cep: cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : (g.cep || ''), municipio: g.municipio || '',
      uf: String(g.uf || '').toUpperCase()
    },
    fantasia: String(b.fantasia || '').trim(),
    ie: String(b.ie || '').trim(),
    pessoaMoskit
  };
}

// ---------------------------------------------------------------
// Aplica o desejado sobre um cadastro do Moskit (função pura)
// ---------------------------------------------------------------
function cfValor(ent, id) {
  const c = (ent.entityCustomFields || []).find(x => x.id === id);
  if (!c) return { texto: '', opcoes: [] };
  return { texto: c.textValue || '', opcoes: c.options || [] };
}

function montarAtualizacao(entOriginal, tipo, desejado, ufs) {
  const ent = JSON.parse(JSON.stringify(entOriginal));
  const mudancas = [];
  const vazio = (v) => v === undefined || v === null || String(v).trim() === '';

  // Nome (compara só os 60 primeiros caracteres)
  if (!vazio(desejado.nome) && !cs.mesmoNome(desejado.nome, ent.name)) {
    mudancas.push({ campo: 'Nome', antes: ent.name || '', depois: desejado.nome.slice(0, 60) });
    ent.name = desejado.nome.slice(0, 60);
  }

  // Documento: empresa sem CNPJ recebe o CNPJ; contato sem CPF recebe o CPF.
  // Pessoa física cadastrada como empresa NÃO recebe CPF (decisão B).
  if (tipo === 'empresa' && desejado.doc.length === 14 && !dig(ent.cnpj)) {
    const f = cs.formatarDoc(desejado.doc);
    mudancas.push({ campo: 'CNPJ', antes: '', depois: f });
    ent.cnpj = f;
  }
  if (tipo === 'contato' && desejado.doc.length === 11 && !dig(ent.cpf)) {
    const f = cs.formatarDoc(desejado.doc);
    mudancas.push({ campo: 'CPF', antes: '', depois: f });
    ent.cpf = f;
  }

  // Telefones: todos no padrão (DD) 99999-9999, com o 9 nos celulares; o principal = o do Bling
  const phones = (ent.phones || []).map(p => ({ ...p }));
  for (const p of phones) {
    const a = cs.analisarTelefone(p.number);
    if (a.final && a.final !== p.number) {
      mudancas.push({ campo: 'Telefone (padronização)', antes: p.number, depois: a.final });
      p.number = a.final;
    }
  }
  if (desejado.telefone) {
    const ja = phones.find(p => dig(p.number) === desejado.telefoneDigitos);
    if (!ja) {
      const primId = ent.primaryPhone && ent.primaryPhone.id;
      const alvo = phones.find(p => primId && p.id === primId) || phones[0];
      if (alvo) {
        mudancas.push({ campo: 'Telefone', antes: alvo.number, depois: desejado.telefone });
        alvo.number = desejado.telefone;
      } else {
        mudancas.push({ campo: 'Telefone', antes: '', depois: desejado.telefone });
        phones.unshift({ number: desejado.telefone });
      }
    }
  }
  ent.phones = phones;

  // E-mail: o do Bling passa a ser o primeiro; os demais são mantidos
  if (desejado.email) {
    const emails = (ent.emails || []).map(e => ({ ...e }));
    const ja = emails.find(e => String(e.address || '').toLowerCase() === desejado.email.toLowerCase());
    if (!ja) {
      const primId = ent.primaryEmail && ent.primaryEmail.id;
      const alvo = emails.find(e => primId && e.id === primId) || emails[0];
      if (alvo) { mudancas.push({ campo: 'E-mail', antes: alvo.address, depois: desejado.email }); alvo.address = desejado.email; }
      else { mudancas.push({ campo: 'E-mail', antes: '', depois: desejado.email }); emails.unshift({ address: desejado.email }); }
    }
    ent.emails = emails;
  }

  // Campos personalizados: endereço, UF, IE e fantasia (só preenche/atualiza; vazio no Bling não apaga)
  const cfs = (ent.entityCustomFields || []).map(c => ({ ...c }));
  const setTexto = (chave, valor) => {
    const id = CF[tipo][chave];
    if (!id || vazio(valor)) return;
    const atual = cfValor({ entityCustomFields: cfs }, id).texto;
    const igual = chave === 'cep' ? dig(atual) === dig(valor) : norm(atual) === norm(valor);
    if (igual) return;
    mudancas.push({ campo: ROTULO[chave], antes: atual, depois: String(valor) });
    const c = cfs.find(x => x.id === id);
    if (c) c.textValue = String(valor);
    else cfs.push({ id, textValue: String(valor) });
  };
  const e = desejado.endereco || {};
  for (const k of ['endereco', 'numero', 'complemento', 'bairro', 'cep', 'municipio']) setTexto(k, e[k]);
  if (tipo === 'empresa') { setTexto('fantasia', desejado.fantasia); setTexto('ie', desejado.ie); }
  if (e.uf && ufs && ufs[tipo] && ufs[tipo][e.uf]) {
    const id = CF[tipo].uf, opt = ufs[tipo][e.uf];
    const c = cfs.find(x => x.id === id);
    const atual = c && (c.options || [])[0];
    if (atual !== opt) {
      const rotuloAtual = Object.entries(ufs[tipo]).find(([, v]) => v === atual);
      mudancas.push({ campo: 'UF', antes: rotuloAtual ? rotuloAtual[0] : '', depois: e.uf });
      if (c) c.options = [opt]; else cfs.push({ id, options: [opt] });
    }
  }
  ent.entityCustomFields = cfs;
  return { ent, mudancas };
}

// Corpo do PUT: o cadastro inteiro como veio do Moskit, só com os campos alterados
function corpoPut(ent) {
  const b = JSON.parse(JSON.stringify(ent));
  delete b.source; delete b.origin; delete b.dateCreated;
  return b;
}

function contarVinculos(ent, tipo) {
  return Object.fromEntries(VINCULOS[tipo].map(k => [k, Array.isArray(ent[k]) ? ent[k].length : 0]));
}

// ---------------------------------------------------------------
// Plano (prévia)
// ---------------------------------------------------------------
const estado = { rodando: false, tarefa: '', etapa: '', inicio: null, erro: null, parar: false };

function lerPlano() { try { return JSON.parse(fs.readFileSync(ARQ_PLANO, 'utf8')); } catch (e) { return null; } }
function salvarPlano(p) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = ARQ_PLANO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p));
  fs.renameSync(tmp, ARQ_PLANO);
}
function backup(reg) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(ARQ_BACKUP, JSON.stringify({ quando: new Date().toISOString(), ...reg }) + '\n');
}

async function blingContato(id) {
  const r = await blingService.blingFetch('GET', `/contatos/${id}`);
  return r.data || null;
}

function resumoPlano(itens) {
  const r = {};
  for (const i of itens) {
    const k = i.acao;
    r[k] = r[k] || { total: 0, pendente: 0, ok: 0, erro: 0, sem_mudanca: 0 };
    r[k].total++;
    r[k][i.status] = (r[k][i.status] || 0) + 1;
  }
  return r;
}

async function preparar() {
  const excluidos = cs.excluidosDocs();
  estado.etapa = 'Lendo clientes do Bling…';
  const { contatos: bling } = await cs.blingClientes(n => { estado.etapa = `Lendo clientes do Bling… ${n}`; });
  const contatos = await cs.moskitTodos('contacts', n => { estado.etapa = `Lendo contatos do Moskit… ${n}`; });
  const empresas = await cs.moskitTodos('companies', n => { estado.etapa = `Lendo empresas do Moskit… ${n}`; });
  const diag = cs.comparar(bling, contatos, empresas, { excluidos });
  const ufs = await opcoesUf();
  const cadastroMoskit = new Map();
  for (const c of contatos) cadastroMoskit.set(`contato:${c.id}`, c);
  for (const c of empresas) cadastroMoskit.set(`empresa:${c.id}`, c);

  // Retoma uma prévia interrompida (ex.: servidor reiniciado) a partir de onde parou
  let itens = [];
  const feitos = new Set();
  let progIniciado = new Date().toISOString();
  try {
    const prog = JSON.parse(fs.readFileSync(ARQ_PROGRESSO, 'utf8'));
    if (prog && Date.now() - Date.parse(prog.iniciadoEm) < 24 * 3600 * 1000) {
      itens = prog.itens || [];
      (prog.feitos || []).forEach(x => feitos.add(String(x)));
      progIniciado = prog.iniciadoEm;
    }
  } catch (e) { /* sem progresso salvo */ }
  const salvarProgresso = () => {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = ARQ_PROGRESSO + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ iniciadoEm: progIniciado, feitos: [...feitos], itens }));
    fs.renameSync(tmp, ARQ_PROGRESSO);
  };

  const candidatos = diag.itens.filter(i => i.status !== 'sem_documento');
  const retomados = candidatos.filter(i => feitos.has(String(i.blingId))).length;
  let n = 0;
  for (const it of candidatos) {
    if (estado.parar) { salvarProgresso(); throw new Error('Preparação interrompida.'); }
    n++;
    if (feitos.has(String(it.blingId))) continue;
    if (n % 25 === 0) salvarProgresso();
    estado.etapa = `Conferindo cadastro ${n} de ${candidatos.length}…${retomados ? ` (retomada: ${retomados} já conferidos antes)` : ''}`;
    feitos.add(String(it.blingId));
    const docD = dig(it.doc);
    const base = { blingId: it.blingId, nome: it.nome, doc: it.doc, status: 'pendente', erro: '' };
    if (excluidos.includes(docD)) {
      itens.push({ ...base, id: `x:${it.blingId}`, acao: 'excluido', mudancas: [], aviso: 'Excluído por decisão do usuário (não é alterado).' });
      continue;
    }
    let b;
    try { b = await blingContato(it.blingId); } catch (e) { itens.push({ ...base, id: `e:${it.blingId}`, acao: 'erro_leitura', status: 'erro', erro: e.message, mudancas: [] }); continue; }
    if (!b) continue;

    // 1) Telefone do próprio Bling sem o 9
    const tb = cs.analisarTelefone(b.telefone), cb = cs.analisarTelefone(b.celular);
    const fixBling = [];
    if (tb.problema === 'celular sem o 9') fixBling.push({ campo: 'Telefone', antes: b.telefone, depois: tb.final, chave: 'telefone' });
    if (cb.problema === 'celular sem o 9') fixBling.push({ campo: 'Celular', antes: b.celular, depois: cb.final, chave: 'celular' });
    if (fixBling.length) itens.push({ ...base, id: `b:${it.blingId}`, acao: 'corrigir_bling', alvo: { tipo: 'bling', id: it.blingId }, mudancas: fixBling });

    // 2) Moskit
    let alvo = null, origemAlvo = '';
    if (it.moskit) { alvo = { tipo: it.moskit.tipo, id: it.moskit.id }; origemAlvo = 'CPF/CNPJ'; }
    else if (it.status === 'possivel' && it.sugestoes.length === 1) { alvo = { tipo: it.sugestoes[0].tipo, id: it.sugestoes[0].id }; origemAlvo = it.sugestoes[0].motivo; }
    else if (it.status === 'possivel') {
      itens.push({ ...base, id: `m:${it.blingId}`, acao: 'escolha_manual', status: 'pendente', mudancas: [], sugestoes: it.sugestoes, aviso: `${it.sugestoes.length} cadastros parecidos no Moskit: escolha manual.` });
      continue;
    }

    if (!alvo) {
      // 3) Falta no Moskit: cria (PJ = empresa com CNPJ; PF = contato com CPF)
      const tipo = docD.length === 14 ? 'empresa' : 'contato';
      const des = desejadoDoBling(b, tipo);
      const { mudancas } = montarAtualizacao({ name: '', phones: [], emails: [], entityCustomFields: [] }, tipo, des, ufs);
      itens.push({ ...base, id: `c:${it.blingId}`, acao: 'criar_moskit', alvo: { tipo, id: null }, desejado: des, mudancas });
      continue;
    }

    // A listagem do Moskit já traz telefones, e-mails e campos personalizados.
    // Na gravação o cadastro é lido de novo, completo, antes de alterar.
    let ent = cadastroMoskit.get(`${alvo.tipo}:${alvo.id}`);
    if (!ent) {
      try { ent = await moskit('GET', `/${alvo.tipo === 'empresa' ? 'companies' : 'contacts'}/${alvo.id}`); }
      catch (e) { itens.push({ ...base, id: `u:${alvo.tipo}:${alvo.id}`, acao: 'atualizar_moskit', alvo, status: 'erro', erro: e.message, mudancas: [] }); continue; }
    }
    const des = desejadoDoBling(b, alvo.tipo);
    const { mudancas } = montarAtualizacao(ent, alvo.tipo, des, ufs);
    if (!mudancas.length) continue;
    itens.push({ ...base, id: `u:${alvo.tipo}:${alvo.id}`, acao: 'atualizar_moskit', alvo, porCorrespondencia: origemAlvo !== 'CPF/CNPJ' ? origemAlvo : '', moskitNome: ent.name, desejado: des, mudancas });
  }

  // Um mesmo cadastro do Moskit não pode receber dados de dois clientes do Bling
  const porAlvo = {};
  for (const i of itens) if (i.acao === 'atualizar_moskit') (porAlvo[i.id] = porAlvo[i.id] || []).push(i);
  for (const lista of Object.values(porAlvo)) if (lista.length > 1) for (const i of lista) {
    i.acao = 'escolha_manual';
    i.aviso = `O mesmo cadastro do Moskit corresponde a ${lista.length} clientes do Bling: escolha manual.`;
  }
  itens.forEach((i, k) => { if (i.acao === 'escolha_manual' && !i.id.startsWith('m:')) i.id = `m${k}:${i.blingId}`; });

  const plano = { geradoEm: new Date().toISOString(), resumo: resumoPlano(itens), itens };
  salvarPlano(plano);
  try { fs.unlinkSync(ARQ_PROGRESSO); } catch (e) {}
  return plano;
}

// ---------------------------------------------------------------
// Aplicação
// ---------------------------------------------------------------
let moskitUsuarioId = null;
async function usuarioMoskit() {
  if (moskitUsuarioId) return moskitUsuarioId;
  const me = await moskit('GET', '/users/me');
  moskitUsuarioId = me && me.id;
  if (!moskitUsuarioId) throw new Error('Não foi possível identificar o usuário do Moskit.');
  return moskitUsuarioId;
}

async function aplicarItem(item) {
  const ufs = await opcoesUf();
  if (item.acao === 'atualizar_moskit') {
    const rota = `/${item.alvo.tipo === 'empresa' ? 'companies' : 'contacts'}/${item.alvo.id}`;
    const antes = await moskit('GET', rota);
    const { ent, mudancas } = montarAtualizacao(antes, item.alvo.tipo, item.desejado, ufs);
    if (!mudancas.length) return { status: 'sem_mudanca', mudancas: [] };
    backup({ acao: 'atualizar_moskit', alvo: item.alvo, blingId: item.blingId, antes });
    await moskit('PUT', rota, corpoPut(ent));
    const depois = await moskit('GET', rota);
    const vA = contarVinculos(antes, item.alvo.tipo), vD = contarVinculos(depois, item.alvo.tipo);
    const perdeu = Object.keys(vA).filter(k => vD[k] < vA[k]);
    if (perdeu.length) {
      try { await moskit('PUT', rota, corpoPut(antes)); } catch (e) {}
      const err = new Error(`A gravação alterou vínculos do cadastro (${perdeu.join(', ')}). O cadastro foi restaurado e a sincronização foi interrompida.`);
      err.critico = true;
      throw err;
    }
    const resto = montarAtualizacao(depois, item.alvo.tipo, item.desejado, ufs).mudancas.filter(m => m.campo !== 'Nome' || norm(depois.name) !== norm(String(item.desejado.nome).slice(0, 60)));
    if (resto.length) return { status: 'erro', erro: 'Gravado, mas o Moskit guardou diferente nestes campos (conferir): ' + resto.map(m => m.campo).join(', '), mudancas };
    return { status: 'ok', mudancas };
  }

  if (item.acao === 'criar_moskit') {
    const uid = await usuarioMoskit();
    const tipo = item.alvo.tipo;
    const doc = dig(item.desejado.doc);
    // Confere de novo se ainda não existe (pelo documento) antes de criar
    const busca = await moskit('POST', `/${tipo === 'empresa' ? 'companies' : 'contacts'}/search`, [{ field: tipo === 'empresa' ? 'cnpj' : 'cpf', expression: 'like', values: [cs.formatarDoc(doc)] }]);
    if (Array.isArray(busca) && busca.some(x => dig(tipo === 'empresa' ? x.cnpj : x.cpf) === doc)) {
      return { status: 'erro', erro: 'Já existe no Moskit um cadastro com este CPF/CNPJ (criado depois da prévia). Prepare de novo.' };
    }
    const vazio = { name: '', phones: [], emails: [], entityCustomFields: [] };
    const { ent } = montarAtualizacao(vazio, tipo, item.desejado, ufs);
    const corpo = { ...ent, createdBy: { id: uid }, responsible: { id: uid } };
    if (tipo === 'empresa') corpo.cnpj = cs.formatarDoc(doc); else corpo.cpf = cs.formatarDoc(doc);
    if (!corpo.name) corpo.name = item.nome;
    const criado = await moskit('POST', `/${tipo === 'empresa' ? 'companies' : 'contacts'}`, corpo);
    backup({ acao: 'criar_moskit', alvo: { tipo, id: criado && criado.id }, blingId: item.blingId, criado: { id: criado && criado.id } });
    return { status: 'ok', criadoId: criado && criado.id };
  }

  if (item.acao === 'corrigir_bling') {
    const antes = await blingContato(item.blingId);
    if (!antes) return { status: 'erro', erro: 'Contato não encontrado no Bling.' };
    const corpo = JSON.parse(JSON.stringify(antes));
    delete corpo.id;
    let mudou = false;
    for (const m of item.mudancas) {
      const atual = cs.analisarTelefone(antes[m.chave]);
      if (atual.problema === 'celular sem o 9') { corpo[m.chave] = atual.final; mudou = true; }
    }
    if (!mudou) return { status: 'sem_mudanca' };
    backup({ acao: 'corrigir_bling', blingId: item.blingId, antes });
    await blingService.blingFetch('PUT', `/contatos/${item.blingId}`, { body: blingService._limparVazios(corpo) });
    const depois = await blingContato(item.blingId);
    const falhou = item.mudancas.filter(m => cs.analisarTelefone(depois && depois[m.chave]).problema === 'celular sem o 9');
    if (falhou.length) return { status: 'erro', erro: 'O Bling não gravou o telefone.' };
    return { status: 'ok' };
  }
  return { status: 'erro', erro: 'Ação não permitida para aplicação automática.' };
}

async function aplicar(ids) {
  const plano = lerPlano();
  if (!plano) throw new Error('Não há prévia preparada.');
  // Grava na ordem em que os cadastros foram selecionados
  const porId = new Map(plano.itens.map(i => [i.id, i]));
  const fila = [...new Set(ids)].map(id => porId.get(id)).filter(i => i && i.status === 'pendente' && ['atualizar_moskit', 'criar_moskit', 'corrigir_bling'].includes(i.acao));
  let n = 0;
  for (const item of fila) {
    if (estado.parar) { estado.erro = 'Aplicação interrompida pelo usuário.'; break; }
    n++;
    estado.etapa = `Gravando ${n} de ${fila.length}: ${item.nome}`;
    try {
      const r = await aplicarItem(item);
      item.status = r.status;
      item.erro = r.erro || '';
      if (r.criadoId) item.alvo.id = r.criadoId;
    } catch (e) {
      item.status = 'erro';
      item.erro = e.message;
      if (e.critico) { estado.erro = e.message; salvarPlano({ ...plano, resumo: resumoPlano(plano.itens) }); break; }
    }
    item.aplicadoEm = new Date().toISOString();
    salvarPlano({ ...plano, resumo: resumoPlano(plano.itens) });
  }
  plano.resumo = resumoPlano(plano.itens);
  salvarPlano(plano);
}

function executar(tarefa, fn) {
  if (estado.rodando) return { iniciado: false, motivo: 'Já existe uma tarefa em andamento.' };
  Object.assign(estado, { rodando: true, tarefa, etapa: '', inicio: new Date().toISOString(), erro: null, parar: false });
  (async () => {
    keepAlive.iniciar();
    try { await fn(); }
    catch (e) { estado.erro = e.message; }
    finally { estado.rodando = false; estado.etapa = ''; keepAlive.parar(); }
  })();
  return { iniciado: true };
}

module.exports = {
  iniciarPreparo: () => executar('preparar', preparar),
  iniciarAplicacao: (ids) => executar('aplicar', () => aplicar(ids)),
  parar: () => { if (estado.rodando) estado.parar = true; return { ok: true }; },
  status: () => {
    let progresso = null;
    try { const p = JSON.parse(fs.readFileSync(ARQ_PROGRESSO, 'utf8')); progresso = { iniciadoEm: p.iniciadoEm, conferidos: (p.feitos || []).length }; } catch (e) {}
    return { ...estado, plano: lerPlano(), progresso };
  },
  _internals: { montarAtualizacao, desejadoDoBling, corpoPut, CF }
};
