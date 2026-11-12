// contatos.js - Diagnóstico de contatos Bling x Moskit (somente leitura)

const ContatosManager = {
  dados: null,
  aba: 'clientes',
  filtro: 'pendencias',
  busca: '',
  timer: null,
  LIMITE: 300,
  sync: null,
  syncFiltro: 'atualizar_moskit',
  selecionados: new Set(),
  selecaoIniciada: false,
  syncTimer: null,

  ACOES: {
    atualizar_moskit: 'Atualizar no Moskit',
    criar_moskit: 'Criar no Moskit',
    corrigir_bling: 'Incluir o 9 no Bling',
    escolha_manual: 'Escolha manual',
    excluido: 'Excluído',
    erro_leitura: 'Erro de leitura'
  },
  GRAVAVEIS: ['atualizar_moskit', 'criar_moskit', 'corrigir_bling'],

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
    document.getElementById('contatos-sync-preparar')?.addEventListener('click', () => this.syncPreparar());
    document.getElementById('contatos-sync-parar')?.addEventListener('click', () => this.syncParar());
    document.getElementById('contatos-sync-teste')?.addEventListener('click', () => this.syncGravar(true));
    document.getElementById('contatos-sync-gravar')?.addEventListener('click', () => this.syncGravar(false));
    document.getElementById('contatos-sync-marcar')?.addEventListener('click', () => this.syncMarcar(true));
    document.getElementById('contatos-sync-desmarcar')?.addEventListener('click', () => this.syncMarcar(false));
    document.getElementById('contatos-tabela')?.addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-sel]');
      if (!cb) return;
      if (cb.checked) this.selecionados.add(cb.dataset.sel); else this.selecionados.delete(cb.dataset.sel);
      this.syncContagem();
    });
    document.querySelectorAll('[data-contatos-aba]').forEach(b => b.addEventListener('click', () => {
      this.aba = b.dataset.contatosAba;
      if (this.aba === 'sync') this.syncCarregar();
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
    if (r.rodando) el.textContent = '⏳ ' + (r.etapa || 'Verificando…') + ' (cerca de 1 minuto)';
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
    const emSync = this.aba === 'sync';
    document.getElementById('contatos-sync').style.display = emSync ? '' : 'none';
    document.getElementById('contatos-cards').style.display = emSync ? 'none' : '';
    if (emSync) { document.getElementById('contatos-filtros').innerHTML = ''; return this.syncRender(); }
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

Object.assign(ContatosManager, {
  async syncCarregar() {
    try {
      const r = await fetch('/api/contatos/sync').then(r => r.json());
      if (!r.success) throw new Error(r.error);
      const planoNovo = r.plano && (!this.sync || !this.sync.plano || this.sync.plano.geradoEm !== r.plano.geradoEm);
      this.sync = r;
      if (planoNovo || !this.selecaoIniciada) this.syncSelecaoPadrao();
      if (this.aba === 'sync') this.syncRender();
      clearTimeout(this.syncTimer);
      if (r.rodando || r.progresso || r.loteEmAndamento) this.syncTimer = setTimeout(() => this.syncCarregar(), 2500);
    } catch (e) {
      // Servidor reiniciando: tenta de novo em alguns segundos
      document.getElementById('contatos-sync-status').textContent = '⏳ Servidor reiniciando… a tarefa continua em instantes.';
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => this.syncCarregar(), 4000);
    }
  },

  syncSelecaoPadrao() {
    this.selecionados = new Set();
    const p = this.sync && this.sync.plano;
    if (!p) return;
    p.itens.forEach(i => { if (this.GRAVAVEIS.includes(i.acao) && i.status === 'pendente') this.selecionados.add(i.id); });
    this.selecaoIniciada = true;
  },

  async syncPreparar() {
    const r = await fetch('/api/contatos/sync/preparar', { method: 'POST' }).then(r => r.json()).catch(e => ({ success: false, error: e.message }));
    if (!r.success) return this.toast(r.error || 'Falha ao preparar', 'error');
    if (!r.iniciado) this.toast(r.motivo || 'Já existe uma tarefa em andamento.', 'info');
    this.syncCarregar();
  },

  async syncParar() {
    await fetch('/api/contatos/sync/parar', { method: 'POST' }).catch(() => {});
    this.toast('Pedido de parada enviado. O cadastro em andamento termina e a tarefa para.', 'info');
    this.syncCarregar();
  },

  syncItensFiltro() {
    const p = this.sync && this.sync.plano;
    if (!p) return [];
    return p.itens.filter(i => (this.syncFiltro === 'todos' || i.acao === this.syncFiltro || (this.syncFiltro === 'erros' && i.status === 'erro') || (this.syncFiltro === 'gravados' && i.status === 'ok'))
      && this.casaBusca(i.nome, i.doc, (i.mudancas || []).map(m => m.depois).join(' ')));
  },

  syncMarcar(marcar) {
    this.syncItensFiltro().forEach(i => {
      if (!this.GRAVAVEIS.includes(i.acao) || i.status !== 'pendente') return;
      if (marcar) this.selecionados.add(i.id); else this.selecionados.delete(i.id);
    });
    this.syncRender();
  },

  syncSelecionadosValidos() {
    const p = this.sync && this.sync.plano;
    if (!p) return [];
    return p.itens.filter(i => this.selecionados.has(i.id) && this.GRAVAVEIS.includes(i.acao) && i.status === 'pendente');
  },

  syncContagem() {
    const n = this.syncSelecionadosValidos().length;
    document.getElementById('contatos-sync-selecao').innerHTML = `<strong>${n.toLocaleString('pt-BR')}</strong> cadastro(s) marcados para gravar`;
    document.getElementById('contatos-sync-gravar').textContent = `✅ Gravar selecionados (${n.toLocaleString('pt-BR')})`;
  },

  async syncGravar(soUm) {
    const validos = this.syncSelecionadosValidos();
    if (!validos.length) return this.toast('Nenhum cadastro marcado.', 'info');
    let corpo;
    if (soUm) {
      const visiveis = new Set(this.syncItensFiltro().map(i => i.id));
      const item = validos.find(i => visiveis.has(i.id)) || validos[0];
      corpo = { ids: [item.id], confirmado: true };
      this.toast(`Gravando 1 cadastro de teste: ${item.nome}`, 'info');
    } else {
      const conf = document.getElementById('contatos-sync-confirmacao').value.trim().toUpperCase();
      if (conf !== 'SINCRONIZAR') return this.toast('Digite SINCRONIZAR no campo ao lado para confirmar.', 'error');
      corpo = { ids: validos.map(i => i.id), confirmacao: 'SINCRONIZAR' };
    }
    const r = await fetch('/api/contatos/sync/aplicar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) })
      .then(r => r.json()).catch(e => ({ success: false, error: e.message }));
    if (!r.success) return this.toast(r.error || 'Falha ao gravar', 'error');
    if (!r.iniciado) return this.toast(r.motivo || 'Já existe uma tarefa em andamento.', 'info');
    document.getElementById('contatos-sync-confirmacao').value = '';
    this.syncCarregar();
  },

  syncRender() {
    const st = this.sync || {};
    const p = st.plano;
    const elSt = document.getElementById('contatos-sync-status');
    document.getElementById('contatos-sync-preparar').disabled = !!st.rodando;
    document.getElementById('contatos-sync-parar').style.display = st.rodando ? '' : 'none';
    ['contatos-sync-teste', 'contatos-sync-gravar'].forEach(id => { document.getElementById(id).disabled = !!st.rodando; });
    if (st.rodando) elSt.textContent = '⏳ ' + (st.etapa || 'Trabalhando…') + ' — mantenha esta tela aberta: o servidor (plano de teste do Fly) reinicia a cada 5 minutos e a tarefa continua sozinha de onde parou';
    else if (st.loteEmAndamento) elSt.textContent = '⏳ Gravação em andamento. O servidor reiniciou e ela continua sozinha em instantes…';
    else if (st.progresso) elSt.textContent = `⏳ Prévia em andamento (${st.progresso.conferidos} cadastros conferidos). O servidor reiniciou e ela continua sozinha em instantes…`;
    else if (st.erro) elSt.textContent = '⚠️ ' + st.erro;
    else if (p) elSt.textContent = 'Prévia de ' + this.dataHora(p.geradoEm) + '.';
    else elSt.textContent = 'Nenhuma prévia preparada ainda.';

    const cards = document.getElementById('contatos-sync-cards');
    const filtros = document.getElementById('contatos-sync-filtros');
    const tab = document.getElementById('contatos-tabela');
    const rod = document.getElementById('contatos-rodape');
    document.getElementById('contatos-sync-acoes').style.display = p ? '' : 'none';
    if (!p) { cards.innerHTML = ''; filtros.innerHTML = ''; tab.innerHTML = ''; rod.textContent = ''; return; }

    const res = p.resumo || {};
    cards.innerHTML = Object.keys(this.ACOES).filter(a => res[a]).map(a => {
      const r = res[a];
      const extra = this.GRAVAVEIS.includes(a) ? `${r.pendente || 0} pendentes · ${r.ok || 0} gravados${r.erro ? ' · ' + r.erro + ' com erro' : ''}` : (a === 'escolha_manual' ? 'não são gravados' : '');
      return `<button type="button" class="contatos-card ${this.syncFiltro === a ? 'active' : ''}" data-sf="${a}"><strong>${r.total.toLocaleString('pt-BR')}</strong><span>${this.esc(this.ACOES[a])}<br>${this.esc(extra)}</span></button>`;
    }).join('');
    cards.querySelectorAll('[data-sf]').forEach(b => b.addEventListener('click', () => { this.syncFiltro = b.dataset.sf; this.syncRender(); }));

    const ops = [['atualizar_moskit', 'Atualizar no Moskit'], ['criar_moskit', 'Criar no Moskit'], ['corrigir_bling', 'Incluir o 9 no Bling'], ['escolha_manual', 'Escolha manual'], ['gravados', 'Gravados'], ['erros', 'Com erro'], ['todos', 'Todos']];
    filtros.innerHTML = ops.map(([f, t]) => `<button type="button" class="filter-pill ${this.syncFiltro === f ? 'active' : ''}" data-sff="${f}">${t}</button>`).join('');
    filtros.querySelectorAll('[data-sff]').forEach(b => b.addEventListener('click', () => { this.syncFiltro = b.dataset.sff; this.syncRender(); }));

    const itens = this.syncItensFiltro();
    const SIT = { pendente: ['Pendente', 'pendente'], ok: ['Gravado', 'ok'], erro: ['Erro', 'erro'], sem_mudanca: ['Já estava igual', 'ignorado'] };
    tab.innerHTML = '<thead><tr><th></th><th>Cliente (Bling)</th><th>Ação</th><th>Cadastro de destino</th><th>Alterações (antes → depois)</th><th>Situação</th></tr></thead><tbody>' +
      (itens.slice(0, this.LIMITE).map(i => {
        const gravavel = this.GRAVAVEIS.includes(i.acao) && i.status === 'pendente';
        const destino = i.acao === 'corrigir_bling' ? `Bling #${this.esc(i.blingId)}` :
          i.acao === 'criar_moskit' ? (i.alvo && i.alvo.id ? `${i.alvo.tipo === 'empresa' ? 'Empresa' : 'Contato'} #${this.esc(i.alvo.id)}` : `Nova ${i.alvo && i.alvo.tipo === 'empresa' ? 'empresa' : 'pessoa (contato)'}`) :
          i.alvo ? `${i.alvo.tipo === 'empresa' ? 'Empresa' : 'Contato'} #${this.esc(i.alvo.id)}<small>${this.esc(i.moskitNome || '')}</small>${i.porCorrespondencia ? `<small>⚠️ encontrado por ${this.esc(i.porCorrespondencia)} (sem CPF/CNPJ no Moskit)</small>` : ''}` : '-';
        let det = (i.mudancas || []).map(m => `<div class="contatos-dif"><b>${this.esc(m.campo)}:</b> <span class="antes">${this.esc(m.antes || '(vazio)')}</span> → <span class="depois">${this.esc(m.depois)}</span></div>`).join('');
        if (i.sugestoes) det += i.sugestoes.map(sg => `<div class="contatos-dif">${this.moskitLink(sg)}: ${this.esc(sg.nome)} ${sg.telefone ? '· ' + this.esc(sg.telefone) : ''} <small>(${this.esc(sg.motivo)})</small></div>`).join('');
        if (i.aviso) det += `<div class="contatos-dif">ℹ️ ${this.esc(i.aviso)}</div>`;
        if (i.erro) det += `<div class="contatos-dif antes">⚠️ ${this.esc(i.erro)}</div>`;
        const sit = SIT[i.status] || [i.status, ''];
        return `<tr>
          <td>${gravavel ? `<input type="checkbox" data-sel="${this.esc(i.id)}" ${this.selecionados.has(i.id) ? 'checked' : ''} aria-label="Selecionar ${this.esc(i.nome)}">` : ''}</td>
          <td>${this.esc(i.nome)}<small>${this.esc(i.doc || '')}</small></td>
          <td>${this.esc(this.ACOES[i.acao] || i.acao)}</td>
          <td>${destino}</td>
          <td>${det || '-'}</td>
          <td><span class="bling-pill ${sit[1]}">${this.esc(sit[0])}</span></td></tr>`;
      }).join('') || '<tr><td colspan="6" class="bling-empty">Nada para mostrar com este filtro.</td></tr>') + '</tbody>';
    rod.textContent = `Mostrando ${Math.min(itens.length, this.LIMITE).toLocaleString('pt-BR')} de ${itens.length.toLocaleString('pt-BR')}${itens.length > this.LIMITE ? ' (use a busca para encontrar um cadastro específico; "Marcar/Desmarcar todos do filtro" vale para todos, inclusive os não exibidos)' : ''}.`;
    this.syncContagem();
  }
});

document.addEventListener('DOMContentLoaded', () => ContatosManager.init());
