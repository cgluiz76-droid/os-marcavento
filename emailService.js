// emailService.js - Alertas por e-mail da integração Moskit -> Bling
//
// Envio por SMTP usando apenas módulos nativos do Node.js (sem dependências externas).
// Suporta SMTPS (porta 465, TLS direto) e STARTTLS (porta 587). Ex.: Gmail com senha de app.

const tls = require('tls');
const net = require('net');
const os = require('os');
const blingDb = require('./blingDb');

function cfg() {
  return {
    ativo: blingDb.getConfig('alerta_email_ativo', 'false') === 'true',
    host: blingDb.getConfig('smtp_host', 'smtp.gmail.com'),
    port: parseInt(blingDb.getConfig('smtp_porta', '465'), 10) || 465,
    usuario: blingDb.getConfig('smtp_usuario', ''),
    senha: blingDb.getConfig('smtp_senha', ''),
    remetente: blingDb.getConfig('email_remetente', '') || blingDb.getConfig('smtp_usuario', ''),
    destinatarios: blingDb.getConfig('email_destinatarios', '')
  };
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const encHeader = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');

function listaEmails(txt) {
  return String(txt || '').split(/[;,\s]+/).map(x => x.trim()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
}

// Cliente SMTP mínimo (EHLO, STARTTLS, AUTH LOGIN, MAIL, RCPT, DATA)
function smtpSend({ host, port, usuario, senha, de, para, mensagem }) {
  return new Promise((resolve, reject) => {
    let socket;
    let buffer = '';
    let etapa = 0;
    const filaRcpt = [...para];
    const timeout = setTimeout(() => fail(new Error('Tempo esgotado na comunicação com o servidor de e-mail.')), 30000);
    const fail = (err) => { clearTimeout(timeout); try { socket && socket.destroy(); } catch (e) { /* ignora */ } reject(err); };
    const send = (linha) => socket.write(linha + '\r\n');
    const nomeLocal = (os.hostname() || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
    let usandoTls = port === 465;
    // Servidor local (testes): sem TLS
    const local = ['127.0.0.1', 'localhost'].includes(String(host));

    const onResponse = (code, text) => {
      const ok = (exp) => { if (!exp.includes(code)) { fail(new Error(`Servidor de e-mail respondeu ${code}: ${text.slice(0, 200)}`)); return false; } return true; };
      switch (etapa) {
        case 0: if (!ok([220])) return; etapa = 1; send(`EHLO ${nomeLocal}`); break;
        case 1:
          if (!ok([250])) return;
          if (!usandoTls && !local) { etapa = 2; send('STARTTLS'); }
          else { etapa = 3; send('AUTH LOGIN'); }
          break;
        case 2: {
          if (!ok([220])) return;
          const plain = socket;
          plain.removeAllListeners('data');
          socket = tls.connect({ socket: plain, servername: host }, () => { usandoTls = true; etapa = 1; send(`EHLO ${nomeLocal}`); });
          socket.on('data', onData);
          socket.on('error', fail);
          break;
        }
        case 3: if (!ok([334])) return; etapa = 4; send(b64(usuario)); break;
        case 4: if (!ok([334])) return; etapa = 5; send(b64(senha)); break;
        case 5: if (!ok([235])) return; etapa = 6; send(`MAIL FROM:<${de}>`); break;
        case 6: if (!ok([250])) return; etapa = 7; send(`RCPT TO:<${filaRcpt.shift()}>`); break;
        case 7:
          if (!ok([250, 251])) return;
          if (filaRcpt.length) { send(`RCPT TO:<${filaRcpt.shift()}>`); break; }
          etapa = 8; send('DATA'); break;
        case 8:
          if (!ok([354])) return;
          etapa = 9;
          socket.write(mensagem.replace(/\r?\n\./g, '\r\n..') + '\r\n.\r\n');
          break;
        case 9: if (!ok([250])) return; etapa = 10; send('QUIT'); clearTimeout(timeout); resolve(true); break;
        default: break;
      }
    };
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const m = line.match(/^(\d{3})([ -])(.*)$/);
        if (!m) continue;
        if (m[2] === '-') continue; // resposta em várias linhas: espera a última
        onResponse(Number(m[1]), m[3]);
      }
    }
    try {
      socket = usandoTls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    } catch (e) { return fail(e); }
    socket.on('data', onData);
    socket.on('error', fail);
  });
}

function montarMensagem({ de, para, assunto, html, texto, anexos = [] }) {
  const limite = `limite_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const alt = `alt_${limite}`;
  const partes = [
    `From: ${encHeader('Automação Moskit-Bling')} <${de}>`,
    `To: ${para.join(', ')}`,
    `Subject: ${encHeader(assunto)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@os-marcavento>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${limite}"`,
    '',
    `--${limite}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(texto)),
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(html)),
    `--${alt}--`
  ];
  for (const a of anexos) {
    partes.push(`--${limite}`,
      `Content-Type: ${a.tipo}; name="${a.nome}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.nome}"`,
      '', wrap76(b64(a.conteudo)));
  }
  partes.push(`--${limite}--`, '');
  return partes.join('\r\n');
}

async function enviar({ assunto, html, texto, anexos }) {
  const c = cfg();
  const para = listaEmails(c.destinatarios);
  if (!c.ativo) return { ok: false, naoConfigurado: true, mensagem: 'alertas por e-mail desativados' };
  if (!c.usuario || !c.senha || !para.length) return { ok: false, naoConfigurado: true, mensagem: 'e-mail não configurado (usuário, senha ou destinatário em branco)' };
  const mensagem = montarMensagem({ de: c.remetente, para, assunto, html, texto, anexos });
  await smtpSend({ host: c.host, port: c.port, usuario: c.usuario, senha: c.senha, de: c.remetente, para, mensagem });
  return { ok: true, para: para.join(', ') };
}

// ---------- Conteúdo do alerta ----------
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const money = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function tabela(titulo, linhas) {
  if (!linhas.length) return '';
  return `<h3 style="margin:18px 0 6px;font-size:15px;color:#111">${esc(titulo)}</h3>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
  ${linhas.map(([k, v]) => `<tr><td style="border:1px solid #ddd;background:#f6f6f6;width:34%"><b>${esc(k)}</b></td><td style="border:1px solid #ddd">${esc(v)}</td></tr>`).join('')}
  </table>`;
}

async function enviarAlertaFalha({ dealId, motivo, preview, os: osRow }) {
  const agora = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
  const base = blingDb.getConfig('url_publica', 'https://os-marcavento.fly.dev');
  const p = preview || null;
  const deal = p ? p.deal : { id: dealId };
  const cliente = p && p.contatoDadosMoskit ? p.contatoDadosMoskit : null;
  const g = (cliente && cliente.endereco && cliente.endereco.geral) || {};

  const negocio = [
    ['Nº do negócio no Moskit', dealId],
    ['Nome do negócio', deal.nome || ''],
    ['Status no Moskit', deal.status || ''],
    ['Valor do negócio', deal.valor !== undefined ? money(deal.valor) : ''],
    ['Responsável', deal.responsavel || '']
  ];
  const cli = cliente ? [
    ['CPF/CNPJ', cliente.numeroDocumento], ['Nome / Razão Social', cliente.nome], ['Nome fantasia', cliente.fantasia],
    ['Inscrição Estadual', cliente.ie], ['E-mail', cliente.email], ['Telefone', cliente.telefone],
    ['Endereço', g.endereco], ['Número', g.numero], ['Complemento', g.complemento], ['Bairro', g.bairro],
    ['CEP', g.cep], ['Município', g.municipio], ['UF', g.uf],
    ['Situação no Bling', p.contato && p.contato.acao === 'existente' ? `Já cadastrado (id ${p.contato.id})` : 'Seria cadastrado como cliente novo']
  ].filter(([, v]) => v !== undefined && v !== null && String(v) !== '') : [];
  const pedido = p ? [
    ['Data do pedido', p.payload.data], ['Data prevista', p.payload.dataPrevista || ''],
    ['Situação', 'Em aberto'], ['Total', money(p.total)],
    ['Parcela', p.payload.parcelas && p.payload.parcelas[0] ? `${money(p.payload.parcelas[0].valor)} com vencimento em ${p.payload.parcelas[0].dataVencimento}` : ''],
    ['Nº na loja', p.payload.numeroLoja]
  ] : [];
  const itensHtml = p && p.itens.length ? `<h3 style="margin:18px 0 6px;font-size:15px;color:#111">Itens</h3>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
    <tr style="background:#f0f0f0"><th style="border:1px solid #ddd">SKU</th><th style="border:1px solid #ddd">Produto (Moskit)</th><th style="border:1px solid #ddd">Qtd.</th><th style="border:1px solid #ddd">Valor unit.</th><th style="border:1px solid #ddd">Subtotal</th><th style="border:1px solid #ddd">Situação</th></tr>
    ${p.itens.map(i => `<tr><td style="border:1px solid #ddd">${esc(i.codigo || '—')}</td><td style="border:1px solid #ddd">${esc(i.nomeMoskit || i.descricao)}</td><td style="border:1px solid #ddd;text-align:right">${esc(i.quantidade)}</td><td style="border:1px solid #ddd;text-align:right">${money(i.valor)}</td><td style="border:1px solid #ddd;text-align:right">${money(i.subtotal)}</td><td style="border:1px solid #ddd">${esc(i.nota || 'OK')}</td></tr>`).join('')}
    </table>` : '';
  const camposMoskit = p && p.camposMoskit ? p.camposMoskit.map(c => [c.caminho, c.valor]) : [];
  const listaProblemas = [...(p ? p.erros : []), ...(p ? p.avisos : [])];

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:760px">
    <h2 style="margin:0 0 6px;color:#b91c1c">⚠️ Pedido não criado no Bling: negócio #${esc(dealId)}</h2>
    <p style="margin:0 0 12px;color:#555">${esc(agora)} · Automação Moskit-Bling</p>
    <div style="border:2px solid #ef4444;background:#fef2f2;padding:10px 12px;border-radius:6px">
      <b>Motivo:</b> ${esc(motivo)}
      ${listaProblemas.length ? `<ul style="margin:6px 0 0 18px;padding:0">${listaProblemas.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>
    ${osRow ? `<p style="margin:12px 0"><b>O.S. criada:</b> ${esc(osRow.orcamento_numero)} com status <b>Aguardando Bling</b> (número provisório; será trocado pelo número do pedido quando ele for criado).</p>` : ''}
    <p style="margin:12px 0"><b>O que fazer:</b> corrija o motivo acima (no Moskit ou no Bling) e, no sistema, abra <b>📦 Bling</b>, digite o nº do negócio <b>${esc(dealId)}</b> e clique em <b>Conferir</b>. Acesse: <a href="${esc(base)}">${esc(base)}</a></p>
    ${tabela('Negócio (Moskit)', negocio)}
    ${tabela('Cliente', cli)}
    ${tabela('Pedido que seria criado', pedido)}
    ${itensHtml}
    ${tabela('Todos os campos recebidos do Moskit', camposMoskit)}
    <p style="color:#777;font-size:12px;margin-top:16px">Em anexo: dados técnicos (JSON) que seriam enviados ao Bling.</p>
  </div>`;

  const texto = [
    `PEDIDO NÃO CRIADO NO BLING — negócio #${dealId}`, agora, '', `MOTIVO: ${motivo}`, ...listaProblemas.map(x => ` - ${x}`), '',
    osRow ? `O.S. criada: ${osRow.orcamento_numero} (Aguardando Bling, número provisório)` : '', '',
    'NEGÓCIO', ...negocio.map(([k, v]) => `  ${k}: ${v}`), '',
    cli.length ? 'CLIENTE' : '', ...cli.map(([k, v]) => `  ${k}: ${v}`), '',
    pedido.length ? 'PEDIDO' : '', ...pedido.map(([k, v]) => `  ${k}: ${v}`), '',
    p && p.itens.length ? 'ITENS' : '', ...(p ? p.itens.map(i => `  ${i.codigo || '—'} | ${i.nomeMoskit || i.descricao} | ${i.quantidade} x ${money(i.valor)} = ${money(i.subtotal)} | ${i.nota || 'OK'}`) : []), '',
    camposMoskit.length ? 'CAMPOS RECEBIDOS DO MOSKIT' : '', ...camposMoskit.map(([k, v]) => `  ${k}: ${v}`), '',
    `Para resolver: corrija o motivo e, em ${base}, abra 📦 Bling, digite ${dealId} e clique em Conferir.`
  ].filter(l => l !== undefined).join('\n');

  const anexos = p ? [{ nome: `negocio-${dealId}.json`, tipo: 'application/json', conteudo: JSON.stringify({ negocio: p.deal, motivo, erros: p.erros, avisos: p.avisos, cliente: p.contatoDadosMoskit, pedido: p.payload, itens: p.itens }, null, 2) }] : [];
  const nomeCli = cliente && (cliente.fantasia || cliente.nome);
  return enviar({ assunto: `⚠️ Pedido não criado no Bling – negócio #${dealId}${nomeCli ? ' – ' + nomeCli : ''}`, html, texto, anexos });
}

async function enviarTeste() {
  const html = `<div style="font-family:Arial,sans-serif"><h2>✅ Teste de alerta</h2><p>Os alertas da Automação Moskit-Bling estão configurados corretamente.</p></div>`;
  return enviar({ assunto: '✅ Teste – alertas da Automação Moskit-Bling', html, texto: 'Os alertas da Automação Moskit-Bling estão configurados corretamente.', anexos: [] });
}

module.exports = { enviarAlertaFalha, enviarTeste, _internals: { montarMensagem, listaEmails, smtpSend } };
