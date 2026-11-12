// contatos.js - Diagnóstico de contatos Bling x Moskit (somente leitura)

const ContatosManager = {
  dados: null,
  aba: 'clientes',
  filtro: 'pendencias',
  busca: '',
  timer: null,
  LIMITE: 300,

  STATUS: {
    ok: { rotulo: 'Igual', classe: 'ok' },
    formato: { rotulo: 'Só formatação', classe: 'ok' },
    divergente: { rotulo: 'Diferente', classe: 'aviso' },
    possivel: { rotulo: 'Possível correspondência', classe: 'alteracao_pendente' },
    falta: { rotulo: 'Falta no Moskit', classe: 'erro' },
    sem_documento: { rotulo: 'Sem CPF/CNPJ no Bling', classe: 'ignorado' }
  },

  init() {
    document.getElementById('btn-open-contatos')?.addEventListener('click', () => this.open());
    document.getElementById('contatos-btn-verificar')?.addEventListener('click', () => this.verificar());
    document.getElementById('contatos-busca')?.addEventListener('input', (e) => { this.busca = e.target.value; this.render(); });
    document.querySelectorAll('[data-contatos-aba]').forEach(b => b.addEventListener('click', () => {
      this.aba = b.dataset.contatosAba;
      document.querySelectorAll('[data-contatos-aba]').forEach(x => x.classList.toggle('active', x === b));
      this.render();
    }));
  },

  esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  toast(msg, type = 'info') {
    if (typeof App !== 'undefined' && typeof App.showToast === 'function') App.showToast(this.esc(msg), type);
  },
  dataHora(iso) {
    try { return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); } catch (e) { return iso; }
  },
  digitos(v) { return String(v ?? '').replace(/\D/g, ''); },

  open() {
    document.getElementById('modal-contatos')?.classList.add('active');
    this.carregar();
  },

  async carregar() {
    try {
      const r = await fetch('/api/contatos/diagnostico').then(r => r.json());
      if (!r.success) throw new Error(r.error || 'Falha ao carregar');
      this.dados = r.resultado;
      this.atualizarStatus(r);
      this.render();
      clearTimeout(this.timer);
      if (r.rodando) this.timer = setTimeout(() => this.carregar(), 2500);
    } catch (e) {
      document.getElementById('contatos-status').textContent = 'Erro: ' + e.message;
    }
  },

  atualizarStatus(r) {
    const el = document.getElementById('contatos-status');
    const btn = document.getElementById('contatos-btn-verificar');
    btn.disabled = !!r.rodando;
    if (r.rodando) el.textContent = '⏳ ' + (r.etapa || 'Verificando…') + ' (leva cerca de 1 minuto)';
    else if (r.erro) el.textContent = '⚠️ A última verificação falhou: ' + r.erro;
    else if (r.resultado) el.textContent = 'Última verificação: ' + this.dataHora(r.resultado.geradoEm);
    else el.textContent = 'Nenhuma verificação feita ainda. Clique em "Verificar agora".';
  },

  async verificar() {
    try {
      const r = await fetch('/api/contatos/diagnostico', { method: 'POST' }).then(r => r.json());
      if (!r.success) throw new Error(r.error);
      if (!r.iniciado) this.toast(r.motivo || 'Verificação já em andamento.', 'info');
      this.carregar();
    } catch (e) { this.toast('Não foi possível iniciar: ' + e.message, 'error'); }
  },

  cards() {
    const el = document.getElementById('contatos-cards');
    if (!this.dados) { el.innerHTML = ''; return; }
    const r = this.dados.resumo;
    const lista = [
      ['todos', r.clientesBling, 'Clientes no Bling'],
      ['ok', r.ok + r.formato, 'Iguais nos dois'],
      ['divergente', r.divergente, 'Com nome ou telefone diferente'],
      ['falta', r.falta, 'Faltam no Moskit'],
      ['possivel', r.possivel, 'Possível correspondência (sem CPF/CNPJ no Moskit)'],
      ['sem_documento', r.semDocumento, 'Sem CPF/CNPJ no Bling']
    ];
    el.innerHTML = lista.map(([f, n, t]) =>
      `<button type="button" class="contatos-card ${this.aba === 'clientes' && this.filtro === f ? 'active' : ''}" data-f="${f}"><strong>${Number(n || 0).toLocaleString('pt-BR')}</strong><span>${this.esc(t)}</span></button>`).join('');
    el.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => {
      this.filtro = b.dataset.f;
      this.aba = 'clientes';
      document.querySelectorAll('[data-contatos-aba]').forEach(x => x.classList.toggle('active', x.dataset.contatosAba === 'clientes'));
      this.render();
    }));
  },

  filtros() {
    const el = document.getElementById('contatos-filtros');
    if (this.aba !== 'clientes' || !this.dados) { el.innerHTML = ''; return; }
    const op = [['pendencias', 'Precisam de atenção'], ['divergente', 'Diferentes'], ['falta', 'Faltam no Moskit'], ['possivel', 'Possível correspondência'], ['formato', 'Só formatação'], ['ok', 'Iguais'], ['sem_documento', 'Sem CPF/CNPJ'], ['todos', 'Todos']];
    el.innerHTML = op.map(([f, t]) => `<button type="button" class="filter-pill ${this.filtro === f ? 'active' : ''}" data-cf="${f}">${t}</button>`).join('');
    el.querySelectorAll('[data-cf]').forEach(b => b.addEventListener('click', () => { this.filtro = b.dataset.cf; this.render(); }));
  },

  casaBusca(...campos) {
    const q = this.busca.trim().toLowerCase();
    if (!q) return true;
    const qd = this.digitos(q);
    return campos.some(c => {
      const s = String(c ?? '');
      return s.toLowerCase().includes(q) || (qd.length >= 4 && this.digitos(s).includes(qd));
    });
  },

  moskitLink(m) {
    if (!m || !m.id) return '';
    const caminho = m.tipo === 'empresa' ? 'companies' : 'contacts';
    return `<a href="https://app.moskitcrm.com/${caminho}/${encodeURIComponent(String(m.id).split(',')[0].trim())}" target="_blank" rel="noopener">${this.esc(m.tipo === 'empresa' ? 'Empresa' : 'Contato')} ${this.esc(m.id)}</a>`;
  },

  render() {
    this.cards();
    this.filtros();
    const tab = document.getElementById('contatos-tabela');
    const rod = document.getElementById('contatos-rodape');
    if (!this.dados) { tab.innerHTML = ''; rod.textContent = ''; return; }
    let linhas = [], cab = '', total = 0;

    if (this.aba === 'clientes') {
      const pend = ['divergente', 'falta', 'possivel'];
      let itens = this.dados.itens.filter(i =>
        this.filtro === 'todos' ? true :
        this.filtro === 'pendencias' ? pend.includes(i.status) :
        this.filtro === 'ok' ? (i.status === 'ok' || i.status === 'formato') :
        i.status === this.filtro);
      itens = itens.filter(i => this.casaBusca(i.nome, i.doc, i.telefoneBling, i.moskit && i.moskit.nome, i.moskit && i.moskit.telefone));
      const ordem = { divergente: 0, possivel: 1, falta: 2, formato: 3, ok: 4, sem_documento: 5 };
      itens = itens.slice().sort((x, y) => (ordem[x.status] ?? 9) - (ordem[y.status] ?? 9));
      total = itens.length;
      cab = '<thead><tr><th>Cliente no Bling</th><th>CPF/CNPJ</th><th>Telefone (padrão)</th><th>Situação</th><th>No Moskit</th><th>Diferenças / sugestões</th></tr></thead>';
      linhas = itens.slice(0, this.LIMITE).map(i => {
        const st = this.STATUS[i.status] || { rotulo: i.status, classe: '' };
        let det = '';
        if (i.diferencas.length) det += i.diferencas.map(d => `<div class="contatos-dif"><b>${this.esc(d.campo)}:</b> <span class="antes">Moskit: ${this.esc(d.moskit)}</span> → <span class="depois">Bling: ${this.esc(d.bling)}</span></div>`).join('');
        if (i.status === 'formato') det += `<div class="contatos-dif">Telefone igual, gravado em outro formato no Moskit: ${this.esc(i.moskit.telefone)}</div>`;
        if (i.sugestoes.length) det += i.sugestoes.map(s => `<div class="contatos-dif">${this.moskitLink(s)}: ${this.esc(s.nome)} ${s.telefone ? '· ' + this.esc(s.telefone) : ''} <small>(${this.esc(s.motivo)})</small></div>`).join('');
        if (i.alertas.length) det += i.alertas.map(a => `<div class="contatos-dif">⚠️ ${this.esc(a)}</div>`).join('');
        return `<tr>
          <td>${this.esc(i.nome)}<small>Bling #${this.esc(i.blingId)}</small></td>
          <td style="white-space:nowrap">${this.esc(i.doc || '-')}</td>
          <td style="white-space:nowrap">${this.esc(i.telefonePadrao || i.telefoneBling || '-')}</td>
          <td><span class="bling-pill ${st.classe}">${this.esc(st.rotulo)}</span></td>
          <td>${i.moskit ? this.moskitLink(i.moskit) + '<small>' + this.esc(i.moskit.nome) + '</small>' : '-'}</td>
          <td>${det || '-'}</td></tr>`;
      });
    } else if (this.aba === 'problemasMoskit' || this.aba === 'soMoskit') {
      const fonte = this.aba === 'soMoskit' ? this.dados.soMoskit : this.dados.problemasMoskit;
      const itens = fonte.filter(p => this.casaBusca(p.nome, p.doc, p.telefone, p.problema));
      total = itens.length;
      cab = `<thead><tr><th>Cadastro no Moskit</th><th>CPF/CNPJ</th><th>Telefone</th><th>${this.aba === 'soMoskit' ? 'Situação' : 'Problema'}</th></tr></thead>`;
      linhas = itens.slice(0, this.LIMITE).map(p => `<tr>
        <td>${this.esc(p.nome)}<small>${this.moskitLink(p)}</small></td>
        <td style="white-space:nowrap">${this.esc(p.doc || '-')}</td>
        <td style="white-space:nowrap">${this.esc(p.telefone || '-')}</td>
        <td>${this.esc(p.problema || 'CPF/CNPJ não encontrado entre os clientes do Bling')}</td></tr>`);
    } else {
      const itens = this.dados.problemasBling.filter(p => this.casaBusca(p.nome, p.doc, p.problema));
      total = itens.length;
      cab = '<thead><tr><th>Cadastro no Bling</th><th>CPF/CNPJ</th><th>Problema</th></tr></thead>';
      linhas = itens.slice(0, this.LIMITE).map(p => `<tr><td>${this.esc(p.nome)}<small>Bling #${this.esc(p.blingId)}</small></td><td>${this.esc(p.doc || '-')}</td><td>${this.esc(p.problema)}</td></tr>`);
    }

    tab.innerHTML = cab + '<tbody>' + (linhas.join('') || '<tr><td colspan="6" class="bling-empty">Nada para mostrar com este filtro.</td></tr>') + '</tbody>';
    const m = this.dados.meta || {};
    rod.textContent = `Mostrando ${Math.min(total, this.LIMITE).toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}${total > this.LIMITE ? ' (use a busca para encontrar um cadastro específico)' : ''}. ` +
      `Base lida: ${this.dados.resumo.clientesBling} clientes do Bling${m.filtradoPorTipoCliente ? ' (tipo Cliente)' : ''}, ${m.contatosMoskit} contatos e ${m.empresasMoskit} empresas do Moskit; ${m.ignoradosCnpjZerado || 0} empresas com CNPJ zerado ignoradas.`;
  }
};

document.addEventListener('DOMContentLoaded', () => ContatosManager.init());
