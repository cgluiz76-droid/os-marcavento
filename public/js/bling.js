// bling.js - Tela de conferência e envio de pedidos ao Bling
// Independente do app.js: só usa App.showToast (se existir) para mensagens.

const BlingManager = {
  filtro: 'pendente',
  dealAtual: null,
  previewAtual: null,
  enviando: false,

  init() {
    document.getElementById('btn-open-bling')?.addEventListener('click', () => this.open('fila'));

    document.querySelectorAll('[data-bling-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.showTab(btn.dataset.blingTab));
    });

    document.querySelectorAll('[data-bling-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-bling-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.filtro = btn.dataset.blingFilter;
        this.loadFila();
      });
    });

    const input = document.getElementById('bling-input-deal');
    document.getElementById('bling-btn-conferir-id')?.addEventListener('click', () => this.conferirPorInput());
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.conferirPorInput(); });

    document.getElementById('bling-btn-salvar-mapeamento')?.addEventListener('click', () => this.saveMapeamento());
    document.getElementById('bling-btn-salvar-credenciais')?.addEventListener('click', () => this.saveCredenciais());
    document.getElementById('bling-btn-salvar-config')?.addEventListener('click', () => this.saveConfig());
    document.getElementById('bling-btn-carregar-opcoes')?.addEventListener('click', () => this.loadOpcoes());

    document.querySelectorAll('[data-bling-copy]').forEach(btn => {
      btn.addEventListener('click', () => this.copy(document.getElementById(btn.dataset.blingCopy)?.value || ''));
    });

    // Retorno da autorização OAuth
    const params = new URLSearchParams(window.location.search);
    if (params.get('bling') === 'conectado') {
      history.replaceState(null, '', window.location.pathname);
      this.toast('Conta Bling conectada com sucesso!', 'success');
      this.open('config');
    }

    this.refreshBadge();
    setInterval(() => this.refreshBadge(), 60000);
  },

  // ---------- Utilidades ----------
  toast(msg, type = 'info') {
    if (typeof App !== 'undefined' && typeof App.showToast === 'function') App.showToast(this.esc(msg), type);
    else alert(msg);
  },

  esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  money(v) {
    return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  },

  dateTime(v) {
    if (!v) return '';
    const d = new Date(String(v).includes('T') ? v : String(v).replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? v : d.toLocaleString('pt-BR');
  },

  async api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* sem corpo */ }
    if (!res.ok && !data.preview) {
      throw new Error(data.error || data.mensagem || `Erro ${res.status}`);
    }
    return data;
  },

  copy(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => this.toast('Copiado para a área de transferência.', 'success'),
      () => this.toast('Não foi possível copiar automaticamente. Selecione e copie o texto.', 'error')
    );
  },

  // ---------- Navegação ----------
  open(tab = 'fila') {
    document.getElementById('modal-bling')?.classList.add('active');
    this.loadStatus();
    this.showTab(tab);
  },

  showTab(tab) {
    document.querySelectorAll('[data-bling-tab]').forEach(b => b.classList.toggle('active', b.dataset.blingTab === tab));
    document.querySelectorAll('[data-bling-panel]').forEach(p => p.classList.toggle('active', p.dataset.blingPanel === tab));
    if (tab === 'fila') this.loadFila();
    if (tab === 'mapeamento') this.loadMapeamento();
    if (tab === 'config') this.loadStatus();
  },

  async refreshBadge() {
    try {
      const data = await this.api('/api/bling/fila?status=pendente');
      const n = (data.pedidos || []).length;
      const badge = document.getElementById('bling-pending-badge');
      if (badge) {
        badge.textContent = n;
        badge.style.display = n > 0 ? 'inline-block' : 'none';
      }
    } catch (e) { /* silencioso */ }
  },

  // ---------- Status / Configuração ----------
  async loadStatus() {
    try {
      const data = await this.api('/api/bling/status');
      this.status = data;
      const a = data.auth;

      const banner = document.getElementById('bling-connection-banner');
      if (banner) {
        if (!a.conectado || a.reconexaoNecessaria) {
          banner.style.display = 'block';
          banner.innerHTML = `<div class="bling-box aviso"><strong class="title">⚠️ Bling não conectado</strong>
            Para conferir e enviar pedidos, configure e conecte sua conta na aba <strong>Configuração</strong>.</div>`;
        } else {
          banner.style.display = 'none';
        }
      }

      const st = document.getElementById('bling-auth-status');
      if (st) {
        if (a.conectado && !a.reconexaoNecessaria) {
          st.innerHTML = `<div class="bling-box ok"><strong class="title">✅ Conectado ao Bling</strong>
            ${a.ultimaConexao ? 'Autorizado em ' + this.esc(this.dateTime(a.ultimaConexao)) + '. ' : ''}O acesso é renovado automaticamente.</div>`;
        } else if (a.reconexaoNecessaria) {
          st.innerHTML = `<div class="bling-box erro"><strong class="title">A conexão expirou ou foi revogada</strong>Clique em "Conectar ao Bling" para autorizar novamente.</div>`;
        } else {
          st.innerHTML = `<div class="bling-box info"><strong class="title">Passo a passo</strong>
            1. No Bling, crie um aplicativo em <em>Central de Extensões → Área do Integrador</em> com o link de redirecionamento abaixo e os escopos de Contatos, Produtos, Pedidos de Venda e Situações.<br>
            2. Copie o Client ID e o Client Secret do aplicativo para os campos abaixo e salve.<br>
            3. Clique em <strong>Conectar ao Bling</strong> e autorize o acesso.</div>`;
        }
      }

      const idInput = document.getElementById('bling-client-id');
      const secretInput = document.getElementById('bling-client-secret');
      const saveCredBtn = document.getElementById('bling-btn-salvar-credenciais');
      if (a.credenciaisViaAmbiente) {
        if (idInput) { idInput.value = '(definido no servidor)'; idInput.disabled = true; }
        if (secretInput) { secretInput.disabled = true; secretInput.placeholder = '(definido no servidor)'; }
        if (saveCredBtn) saveCredBtn.style.display = 'none';
      } else {
        if (idInput && !idInput.value) idInput.value = data.config.client_id || '';
        if (secretInput) secretInput.placeholder = a.credenciaisConfiguradas ? '•••••••• (salvo; em branco = manter)' : 'Cole o Client Secret';
      }
      const cb = document.getElementById('bling-callback-url');
      if (cb) cb.value = data.callbackUrl;

      const c = data.config;
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
      this.ensureOption('bling-cfg-situacao', c.situacao_id, c.situacao_id === '6' ? 'Em aberto (6)' : `Situação ${c.situacao_id}`);
      setVal('bling-cfg-situacao', c.situacao_id || '6');
      setVal('bling-cfg-prazo', c.prazo_dias || '30');
      this.ensureOption('bling-cfg-forma', c.forma_pagamento_id, `Forma de pagamento ${c.forma_pagamento_id}`);
      setVal('bling-cfg-forma', c.forma_pagamento_id);
      this.ensureOption('bling-cfg-vendedor', c.vendedor_id, `Vendedor ${c.vendedor_id}`);
      setVal('bling-cfg-vendedor', c.vendedor_id);
      setVal('bling-cfg-categoria', c.categoria_id);
      setVal('bling-cfg-loja', c.loja_id);
      const auto = document.getElementById('bling-cfg-auto');
      if (auto) auto.checked = c.auto_enfileirar !== 'false';

      this.renderWebhookBox(data.webhook);
    } catch (e) {
      this.toast('Erro ao carregar status do Bling: ' + e.message, 'error');
    }
  },

  ensureOption(selectId, value, label) {
    const sel = document.getElementById(selectId);
    if (!sel || !value) return;
    if (![...sel.options].some(o => o.value === String(value))) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
  },

  renderWebhookBox(wh) {
    const box = document.getElementById('bling-webhook-box');
    if (!box) return;
    if (wh.protegido) {
      box.innerHTML = `
        <div class="bling-box ok"><strong class="title">🔒 Webhook protegido por token</strong>
          Chamadas sem o token correto são recusadas. A URL cadastrada no Moskit precisa ser exatamente esta:</div>
        <div class="bling-url-row"><input type="text" readonly value="${this.esc(wh.url)}" id="bling-webhook-url">
          <button type="button" class="btn btn-secondary" id="bling-btn-copy-wh">Copiar</button></div>
        <div class="bling-actions-right"><button type="button" class="btn btn-danger btn-sm" id="bling-btn-wh-remover">Desativar proteção</button></div>`;
    } else {
      box.innerHTML = `
        <div class="bling-box aviso"><strong class="title">Webhook sem proteção</strong>
          Hoje qualquer pessoa que conheça o endereço pode enviar negócios falsos ao sistema.
          Ao ativar a proteção, é gerada uma URL com token secreto.
          <br><strong>Importante:</strong> logo após ativar, atualize a URL do webhook no Moskit. Até isso ser feito, os negócios "Ganhou" não chegarão automaticamente (você ainda pode importá-los pelo número).</div>
        <div class="bling-url-row"><input type="text" readonly value="${this.esc(wh.url)}" id="bling-webhook-url"></div>
        <div class="bling-actions-right"><button type="button" class="btn btn-primary btn-sm" id="bling-btn-wh-gerar">🛡️ Ativar proteção (gerar token)</button></div>`;
    }
    document.getElementById('bling-btn-copy-wh')?.addEventListener('click', () => this.copy(wh.url));
    document.getElementById('bling-btn-wh-gerar')?.addEventListener('click', () => this.webhookToken('gerar'));
    document.getElementById('bling-btn-wh-remover')?.addEventListener('click', () => this.webhookToken('remover'));
  },

  async webhookToken(acao) {
    const msg = acao === 'gerar'
      ? 'Ativar a proteção do webhook?\n\nDepois disso, você PRECISA trocar a URL do webhook no Moskit pela nova URL exibida. Até trocar, os negócios não chegarão automaticamente.'
      : 'Desativar a proteção do webhook? O endereço voltará a aceitar chamadas sem token.';
    if (!confirm(msg)) return;
    try {
      const data = await this.api('/api/bling/webhook-token', { method: 'POST', body: JSON.stringify({ acao }) });
      this.renderWebhookBox({ protegido: data.protegido, url: data.url });
      this.toast(data.protegido ? 'Proteção ativada. Atualize agora a URL no Moskit.' : 'Proteção desativada.', 'success');
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async saveCredenciais() {
    try {
      const clientId = document.getElementById('bling-client-id').value.trim();
      const clientSecret = document.getElementById('bling-client-secret').value.trim();
      await this.api('/api/bling/credenciais', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
      document.getElementById('bling-client-secret').value = '';
      this.toast('Credenciais salvas. Agora clique em "Conectar ao Bling".', 'success');
      this.loadStatus();
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async saveConfig() {
    try {
      const body = {
        situacao_id: document.getElementById('bling-cfg-situacao').value,
        prazo_dias: document.getElementById('bling-cfg-prazo').value,
        forma_pagamento_id: document.getElementById('bling-cfg-forma').value,
        vendedor_id: document.getElementById('bling-cfg-vendedor').value,
        categoria_id: document.getElementById('bling-cfg-categoria').value,
        loja_id: document.getElementById('bling-cfg-loja').value,
        auto_enfileirar: document.getElementById('bling-cfg-auto').checked ? 'true' : 'false'
      };
      await this.api('/api/bling/config', { method: 'POST', body: JSON.stringify(body) });
      this.toast('Configuração salva.', 'success');
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async loadOpcoes() {
    try {
      const data = await this.api('/api/bling/opcoes');
      const fill = (id, items, map, emptyLabel) => {
        const sel = document.getElementById(id);
        if (!sel || !items.length) return;
        const current = sel.value;
        sel.innerHTML = emptyLabel !== null ? `<option value="">${emptyLabel}</option>` : '';
        for (const it of items) {
          const [v, l] = map(it);
          const opt = document.createElement('option');
          opt.value = v; opt.textContent = l;
          sel.appendChild(opt);
        }
        if ([...sel.options].some(o => o.value === current)) sel.value = current;
      };
      fill('bling-cfg-situacao', data.situacoes, s => [String(s.id), `${s.nome} (${s.id})`], null);
      fill('bling-cfg-forma', data.formasPagamento, f => [String(f.id), f.descricao || `Forma ${f.id}`], '— não informar —');
      fill('bling-cfg-vendedor', data.vendedores, v => [String(v.id), (v.contato && v.contato.nome) || `Vendedor ${v.id}`], '— não informar —');
      if (data.erros && data.erros.length) this.toast('Algumas listas não puderam ser carregadas: ' + data.erros.join(' / '), 'error');
      else this.toast('Listas carregadas do Bling. Revise e salve.', 'success');
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // ---------- Mapeamento ----------
  labels: {
    'contato.numeroDocumento': 'Cliente: CPF/CNPJ (identifica o cliente no Bling)',
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
  },

  async loadMapeamento() {
    const body = document.getElementById('bling-mapeamento-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="3" class="bling-loading">Carregando…</td></tr>';
    try {
      const [mapRes, fieldsRes] = await Promise.all([
        this.api('/api/bling/mapeamentos'),
        this.api('/api/moskit/fields').catch(() => ({}))
      ]);
      const dl = document.getElementById('bling-moskit-fields');
      if (dl) {
        const all = [...(fieldsRes.orderFields || []), ...(fieldsRes.itemFields || [])];
        dl.innerHTML = all.map(f => `<option value="${this.esc(f.id)}">${this.esc(f.label)}</option>`).join('');
      }
      const order = Object.keys(this.labels);
      const rows = (mapRes.mappings || []).sort((a, b) => order.indexOf(a.bling_field) - order.indexOf(b.bling_field));
      body.innerHTML = rows.map(m => `
        <tr data-field="${this.esc(m.bling_field)}">
          <td><strong>${this.esc(this.labels[m.bling_field] || m.bling_field)}</strong><small class="bling-origem">${this.esc(m.bling_field)}</small></td>
          <td><input type="text" list="bling-moskit-fields" class="bling-map-source" value="${this.esc(m.moskit_source)}"></td>
          <td><input type="text" class="bling-map-fallback" value="${this.esc(m.fallback_value)}"></td>
        </tr>`).join('');
    } catch (e) {
      body.innerHTML = `<tr><td colspan="3" class="bling-empty">${this.esc(e.message)}</td></tr>`;
    }
  },

  async saveMapeamento() {
    const mappings = [...document.querySelectorAll('#bling-mapeamento-body tr[data-field]')].map(tr => ({
      bling_field: tr.dataset.field,
      moskit_source: tr.querySelector('.bling-map-source').value.trim(),
      fallback_value: tr.querySelector('.bling-map-fallback').value.trim()
    }));
    try {
      await this.api('/api/bling/mapeamentos', { method: 'POST', body: JSON.stringify({ mappings }) });
      this.toast('Mapeamento salvo. As próximas conferências já usam os novos campos.', 'success');
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // ---------- Fila ----------
  statusLabel: { pendente: 'Pendente', enviando: 'Enviando…', enviado: 'Enviado', erro: 'Erro', ignorado: 'Ignorado' },

  async loadFila() {
    const body = document.getElementById('bling-fila-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="7" class="bling-loading">Carregando…</td></tr>';
    try {
      const data = await this.api(`/api/bling/fila?status=${encodeURIComponent(this.filtro)}`);
      const rows = data.pedidos || [];
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="7" class="bling-empty">Nenhum negócio nesta lista.</td></tr>';
      } else {
        body.innerHTML = rows.map(r => `
          <tr>
            <td><strong>#${this.esc(r.moskit_deal_id)}</strong><small>${this.esc(this.dateTime(r.created_at))}</small></td>
            <td>${this.esc(r.deal_name)}${r.last_error && r.status === 'erro' ? `<small style="color: var(--accent-red);">${this.esc(r.last_error)}</small>` : ''}</td>
            <td class="num">${this.money(r.deal_value)}</td>
            <td>${r.origem === 'webhook' ? 'Automático' : 'Manual'}</td>
            <td><span class="bling-pill ${this.esc(r.status)}">${this.esc(this.statusLabel[r.status] || r.status)}</span></td>
            <td>${r.bling_pedido_numero ? `<strong>Nº ${this.esc(r.bling_pedido_numero)}</strong>` : (r.bling_pedido_id ? `id ${this.esc(r.bling_pedido_id)}` : '—')}
                ${r.sent_at ? `<small>${this.esc(this.dateTime(r.sent_at))}</small>` : ''}</td>
            <td><div class="bling-row-actions">
              ${['pendente', 'erro'].includes(r.status) ? `<button type="button" class="btn btn-primary btn-sm" data-act="conferir" data-id="${r.moskit_deal_id}">🔎 Conferir</button>` : ''}
              ${['pendente', 'erro'].includes(r.status) ? `<button type="button" class="btn btn-secondary btn-sm" data-act="ignorar" data-id="${r.moskit_deal_id}" title="Não enviar este negócio">Ignorar</button>` : ''}
              ${r.status === 'ignorado' ? `<button type="button" class="btn btn-secondary btn-sm" data-act="reativar" data-id="${r.moskit_deal_id}">Reativar</button>` : ''}
              <button type="button" class="btn btn-secondary btn-sm" data-act="log" data-id="${r.moskit_deal_id}" title="Histórico">🕘</button>
            </div></td>
          </tr>`).join('');
        body.querySelectorAll('button[data-act]').forEach(btn => {
          btn.addEventListener('click', () => this.onFilaAction(btn.dataset.act, btn.dataset.id));
        });
      }
      this.refreshBadge();
    } catch (e) {
      body.innerHTML = `<tr><td colspan="7" class="bling-empty">${this.esc(e.message)}</td></tr>`;
    }
  },

  async onFilaAction(act, id) {
    if (act === 'conferir') return this.conferir(id);
    if (act === 'ignorar' || act === 'reativar') {
      if (act === 'ignorar' && !confirm(`Ignorar o negócio #${id}? Ele não será enviado ao Bling (você pode reativar depois).`)) return;
      try {
        await this.api(`/api/bling/fila/${id}/status`, { method: 'POST', body: JSON.stringify({ status: act === 'ignorar' ? 'ignorado' : 'pendente' }) });
        this.loadFila();
      } catch (e) { this.toast(e.message, 'error'); }
    }
    if (act === 'log') {
      try {
        const data = await this.api(`/api/bling/fila/${id}/log`);
        const linhas = (data.log || []).map(l => `${this.dateTime(l.created_at)} · ${l.acao}: ${l.detalhe}`);
        alert(linhas.length ? `Histórico do negócio #${id}\n\n${linhas.join('\n')}` : `Sem histórico para o negócio #${id}.`);
      } catch (e) { this.toast(e.message, 'error'); }
    }
  },

  conferirPorInput() {
    const v = (document.getElementById('bling-input-deal').value || '').replace(/\D/g, '');
    if (!v) return this.toast('Digite o número do negócio do Moskit.', 'error');
    this.conferir(v);
  },

  // ---------- Conferência ----------
  async conferir(dealId) {
    this.dealAtual = String(dealId);
    this.previewAtual = null;
    this.showTab('conferencia');
    const c = document.getElementById('bling-preview-container');
    c.innerHTML = `<div class="bling-loading">Buscando o negócio #${this.esc(dealId)} no Moskit e conferindo no Bling…</div>`;
    try {
      const data = await this.api(`/api/bling/preview/${encodeURIComponent(dealId)}`);
      this.previewAtual = data.preview;
      this.renderPreview(data.preview);
    } catch (e) {
      c.innerHTML = `<div class="bling-box erro"><strong class="title">Não foi possível conferir o negócio #${this.esc(dealId)}</strong>${this.esc(e.message)}</div>`;
    }
  },

  renderPreview(p, resultado = null) {
    const c = document.getElementById('bling-preview-container');
    const nivelPill = (n) => `<span class="bling-pill ${n}">${n === 'ok' ? 'OK' : n === 'aviso' ? 'Atenção' : 'Erro'}</span>`;
    const fila = p.fila;
    const jaEnviado = fila && fila.status === 'enviado';

    let html = `
      <div class="bling-deal-header">
        <div>
          <h3>Negócio #${this.esc(p.deal.id)} · ${this.esc(p.deal.nome)}</h3>
          <small>Status no Moskit: ${this.esc(p.deal.status || '—')}${p.deal.responsavel ? ' · Responsável: ' + this.esc(p.deal.responsavel) : ''}
          ${fila ? ' · Fila: ' + this.esc(this.statusLabel[fila.status] || fila.status) : ''}</small>
        </div>
        <div class="bling-deal-total"><small>Total do pedido</small><strong>${this.money(p.total)}</strong>
          ${p.deal.valor ? `<small>Valor no Moskit: ${this.money(p.deal.valor)}</small>` : ''}</div>
      </div>`;

    if (resultado) html += resultado;

    if (jaEnviado) {
      html += `<div class="bling-box ok"><strong class="title">Pedido já enviado</strong>Pedido Bling nº ${this.esc(fila.bling_pedido_numero || fila.bling_pedido_id)}. Nenhum novo envio é possível para este negócio.</div>`;
    }
    if (p.erros.length && !jaEnviado) {
      html += `<div class="bling-box erro"><strong class="title">⛔ Corrija antes de enviar</strong><ul>${p.erros.map(e => `<li>${this.esc(e)}</li>`).join('')}</ul></div>`;
    }
    if (p.avisos.length) {
      html += `<div class="bling-box aviso"><strong class="title">⚠️ Avisos</strong><ul>${p.avisos.map(e => `<li>${this.esc(e)}</li>`).join('')}</ul></div>`;
    }
    if (!p.erros.length && !p.avisos.length && !jaEnviado) {
      html += `<div class="bling-box ok">Tudo conferido. Revise os dados abaixo e confirme o envio.</div>`;
    }

    // Tabela ORIGEM -> DESTINO
    html += `<div class="bling-section-title">Campos do pedido</div>
      <div class="table-responsive"><table class="bling-table">
        <thead><tr><th>ORIGEM (Moskit)</th><th>VALOR</th><th>DESTINO (Bling)</th><th>Status</th></tr></thead><tbody>`;
    let grupo = null;
    for (const l of p.linhas) {
      if (l.grupo !== grupo) {
        grupo = l.grupo;
        html += `<tr class="bling-group-row"><td colspan="4">${this.esc(grupo)}</td></tr>`;
      }
      html += `<tr>
        <td class="bling-origem">${this.esc(l.origem)}</td>
        <td>${l.valor ? this.esc(l.valor) : '<span style="color: var(--text-muted);">(vazio)</span>'}${l.nota ? `<small>${this.esc(l.nota)}</small>` : ''}</td>
        <td>${this.esc(l.destinoLabel)}<small class="bling-origem">${this.esc(l.destino)}</small></td>
        <td>${nivelPill(l.nivel)}</td></tr>`;
    }
    html += `</tbody></table></div>`;

    // Itens
    html += `<div class="bling-section-title">Itens (${p.itens.length})</div>
      <div class="table-responsive"><table class="bling-table">
        <thead><tr><th>SKU (Moskit → Bling)</th><th>Descrição no Bling</th><th class="num">Qtd.</th><th class="num">Valor unit.</th><th class="num">Subtotal</th><th>Status</th></tr></thead><tbody>`;
    for (const i of p.itens) {
      html += `<tr>
        <td><strong>${this.esc(i.codigo || '—')}</strong>${i.nomeMoskit ? `<small>Moskit: ${this.esc(i.nomeMoskit)}</small>` : ''}</td>
        <td>${this.esc(i.descricao)}${i.nota ? `<small>${this.esc(i.nota)}</small>` : ''}</td>
        <td class="num">${this.esc(String(i.quantidade).replace('.', ','))}</td>
        <td class="num">${this.money(i.valor)}</td>
        <td class="num">${this.money(i.subtotal)}</td>
        <td>${nivelPill(i.nivel)}</td></tr>`;
    }
    html += `<tr><td colspan="4" class="num"><strong>Total</strong></td><td class="num"><strong>${this.money(p.total)}</strong></td><td></td></tr>`;
    html += `</tbody></table></div>`;

    html += `<details class="bling-json"><summary>Ver dados técnicos que serão enviados ao Bling (JSON)</summary>
      <pre>${this.esc(JSON.stringify({ contatoNovo: p.contatoPayload, pedido: p.payload }, null, 2))}</pre></details>`;

    // Barra de confirmação
    const bloqueado = p.erros.length > 0 || jaEnviado;
    html += `<div class="bling-confirm-bar">
      ${p.avisos.length && !bloqueado ? `<label><input type="checkbox" id="bling-chk-avisos"> Li os avisos e quero enviar mesmo assim</label>` : '<span></span>'}
      <div class="bling-confirm-buttons">
        <button type="button" class="btn btn-secondary" id="bling-btn-reconferir">🔄 Conferir novamente</button>
        <button type="button" class="btn btn-success" id="bling-btn-enviar" ${bloqueado || p.avisos.length ? 'disabled' : ''}>✅ Confirmar envio ao Bling</button>
      </div>
    </div>`;

    c.innerHTML = html;

    const chk = document.getElementById('bling-chk-avisos');
    const btn = document.getElementById('bling-btn-enviar');
    chk?.addEventListener('change', () => { btn.disabled = !chk.checked; });
    btn?.addEventListener('click', () => this.enviar());
    document.getElementById('bling-btn-reconferir')?.addEventListener('click', () => this.conferir(this.dealAtual));
  },

  async enviar() {
    if (this.enviando || !this.previewAtual) return;
    const p = this.previewAtual;
    const confirmarAvisos = Boolean(document.getElementById('bling-chk-avisos')?.checked);
    const resumo = `Criar no Bling o pedido do negócio #${p.deal.id}?\n\nCliente: ${p.contato.nome || p.contato.numeroDocumento}${p.contato.acao === 'criar' ? ' (NOVO cadastro)' : ''}\nItens: ${p.itens.length}\nTotal: ${this.money(p.total)}\nSituação: Em aberto`;
    if (!confirm(resumo)) return;

    this.enviando = true;
    const btn = document.getElementById('bling-btn-enviar');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
    try {
      const res = await fetch(`/api/bling/enviar/${encodeURIComponent(p.deal.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmarAvisos })
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        const n = data.pedido && (data.pedido.numero || data.pedido.id);
        this.toast(`Pedido nº ${n} criado no Bling (Em aberto).`, 'success');
        const box = `<div class="bling-box ok"><strong class="title">✅ Pedido criado no Bling</strong>Pedido nº ${this.esc(n)}${data.recuperado ? ' (já existia; registro atualizado, nada foi duplicado)' : ''}.${data.contatoCriado ? ' O cliente foi cadastrado no Bling.' : ''}</div>`;
        const c = document.getElementById('bling-preview-container');
        c.innerHTML = box + `<div class="bling-actions-right"><button type="button" class="btn btn-secondary" id="bling-btn-voltar-fila">← Voltar para a fila</button></div>`;
        document.getElementById('bling-btn-voltar-fila')?.addEventListener('click', () => this.showTab('fila'));
        this.refreshBadge();
      } else if (data.preview) {
        this.previewAtual = data.preview;
        const box = `<div class="bling-box erro"><strong class="title">O pedido não foi criado</strong>${this.esc(data.mensagem || data.error || 'Erro desconhecido')}</div>`;
        this.renderPreview(data.preview, box);
      } else {
        throw new Error(data.error || data.mensagem || `Erro ${res.status}`);
      }
    } catch (e) {
      this.toast('Falha no envio: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '✅ Confirmar envio ao Bling'; }
    } finally {
      this.enviando = false;
    }
  }
};

window.addEventListener('DOMContentLoaded', () => BlingManager.init());
