// Restaura O.S. específicas a partir de uma cópia (snapshot) do banco.
// Roda numa máquina temporária do Fly com o snapshot montado em /restore.
// NÃO imprime dados de clientes: só ids e contagens (o log do GitHub é público).
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.RESTORE_DB || '/restore/os_marcavento.db';
const BASE = process.env.BASE_URL || 'https://os-marcavento.fly.dev';
const IDS = (process.env.IDS || '9,10,16,17').split(',').map(Number);
// Prefixo do updated_at gravado pela sincronização acidental (UTC)
const SYNC_PREFIX = process.env.SYNC_PREFIX || '2026-11-05 20:51';

const FIELDS = ['orcamento_numero', 'data_os', 'nome_fantasia', 'razao_social', 'cnpj_cpf', 'contato_nome',
  'contato_telefone', 'contato_email', 'data_entrega', 'forma_pagamento', 'prazo_pagamento', 'frete',
  'observacoes', 'template_id', 'status'];

(async () => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let ok = 0;
  for (const id of IDS) {
    const snap = db.prepare('SELECT * FROM service_orders WHERE id = ?').get(id);
    if (!snap) { console.log(`O.S. id ${id}: não existe na cópia. Nada feito.`); continue; }
    if (String(snap.updated_at) >= SYNC_PREFIX) { console.log(`O.S. id ${id}: a cópia já contém a alteração. Nada feito.`); continue; }

    const cur = await fetch(`${BASE}/api/orders/${id}`).then(r => r.json());
    if (!cur.success || !cur.order) { console.log(`O.S. id ${id}: não encontrada na produção. Nada feito.`); continue; }
    if (!String(cur.order.updated_at).startsWith(SYNC_PREFIX)) { console.log(`O.S. id ${id}: foi alterada depois da sincronização. Nada feito.`); continue; }
    if (cur.order.orcamento_numero !== snap.orcamento_numero || cur.order.moskit_deal_id !== snap.moskit_deal_id) {
      console.log(`O.S. id ${id}: número ou negócio não conferem com a cópia. Nada feito.`); continue;
    }

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY ordem ASC, id ASC').all(id)
      .map(i => ({ qtde: i.qtde, prod: i.prod, modelo: i.modelo, dimensao: i.dimensao, posicao: i.posicao, base: i.base,
        preco_unitario: i.preco_unitario, ordem: i.ordem, sku: i.sku }));
    const orderData = {};
    for (const f of FIELDS) orderData[f] = snap[f];

    const res = await fetch(`${BASE}/api/orders/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderData, items })
    }).then(r => r.json());
    if (res.success) { ok++; console.log(`O.S. id ${id}: restaurada (${items.length} item(ns)).`); }
    else console.log(`O.S. id ${id}: falha ao gravar (${res.error}).`);
  }
  console.log(`RESULTADO ${ok}/${IDS.length}`);
  process.exit(ok === IDS.length ? 0 : 2);
})().catch(e => { console.log('ERRO ' + e.message); process.exit(1); });
