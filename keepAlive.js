// keepAlive.js - Mantém o servidor ligado SÓ enquanto existe tarefa em segundo plano.
//
// No Fly.io a máquina é desligada quando o site fica sem acessos (auto_stop_machines),
// o que interrompia tarefas longas (prévia/sincronização de contatos) e as novas
// tentativas de envio ao Bling. Enquanto houver tarefa ativa, o próprio servidor acessa
// o site a cada 30 s (pelo endereço público, que conta como acesso). Sem tarefa, nada
// é feito e a máquina volta a desligar normalmente (sem custo extra).

let ativos = 0;
let timer = null;

function alvo() {
  if (process.env.KEEPALIVE_URL) return process.env.KEEPALIVE_URL;
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev/api/next-orcamento`;
  return null; // fora do Fly (ex.: computador local) não faz nada
}

function iniciar() {
  ativos++;
  const url = alvo();
  if (timer || !url) return;
  const intervalo = Number(process.env.KEEPALIVE_MS) || 30000;
  timer = setInterval(() => {
    fetch(url, { signal: AbortSignal.timeout(10000) }).then(r => r.text()).catch(() => {});
  }, intervalo);
}

function parar() {
  ativos = Math.max(0, ativos - 1);
  if (!ativos && timer) { clearInterval(timer); timer = null; }
}

async function durante(fn) {
  iniciar();
  try { return await fn(); } finally { parar(); }
}

module.exports = { iniciar, parar, durante, ativos: () => ativos };
