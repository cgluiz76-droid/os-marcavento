// app.js - Controlador Principal da Aplicação O.S. Marca Vento

const App = {
  orders: [],
  settings: {},
  templates: [],
  currentFilter: 'all',
  currentSearch: '',
  currentPage: 1,
  pageSize: 10,
  totalOrders: 0,
  totalPages: 1,
  dateFrom: '',
  dateTo: '',
  selectedIds: new Set(),

  isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  applyDefaultDateRange() {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 15);
    this.dateFrom = this.isoDate(from);
    this.dateTo = this.isoDate(to);
    const fromInput = document.getElementById('filter-date-from');
    const toInput = document.getElementById('filter-date-to');
    if (fromInput) fromInput.value = this.dateFrom;
    if (toInput) toInput.value = this.dateTo;
  },

  applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('mv-theme', next);
    const icon = document.getElementById('theme-toggle-icon');
    if (icon) icon.textContent = next === 'dark' ? '☀️' : '🌙';
  },

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    this.applyTheme(current === 'dark' ? 'light' : 'dark');
  },

  applyCompanyLogo(filename) {
    const img  = document.getElementById('company-logo-img');
    const text = document.getElementById('brand-text-fallback');
    if (!img || !text) return;
    if (filename) {
      img.src = `/uploads/${filename}?t=${Date.now()}`;
      img.style.display = 'block';
      text.style.display = 'none';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      text.style.display = 'inline';
    }
    this.syncSettingsLogoPreview(filename);
  },

  syncSettingsLogoPreview(filename) {
    const previewImg   = document.getElementById('settings-logo-img');
    const placeholder  = document.getElementById('settings-logo-placeholder');
    if (!previewImg) return;
    if (filename) {
      previewImg.src = `/uploads/${filename}?t=${Date.now()}`;
      previewImg.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
    } else {
      previewImg.removeAttribute('src');
      previewImg.style.display = 'none';
      if (placeholder) placeholder.style.display = 'block';
    }
  },

  async uploadCompanyLogo(file) {
    if (!file || !file.type.startsWith('image/')) {
      return this.showToast('Selecione uma imagem válida para o logotipo.', 'error');
    }
    const formData = new FormData();
    formData.append('logo', file);
    try {
      const res  = await fetch('/api/settings/logo', { method: 'POST', body: formData });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Falha no upload');
      this.settings = data.settings || this.settings;
      this.applyCompanyLogo(data.filename);
      this.showToast('Logotipo da empresa atualizado.', 'success');
    } catch (e) {
      this.showToast('Erro ao enviar logotipo: ' + e.message, 'error');
    }
  },

  async init() {
    this.applyTheme(localStorage.getItem('mv-theme') || 'dark');
    this.applyDefaultDateRange();
    this.setupEventListeners();
    await MoskitManager.init();
    await SkuManager.init();
    await this.loadSettings();
    await this.loadTemplates();
    await this.loadOrders();

    // Restore saved company logo
    if (this.settings && this.settings.company_logo) {
      this.applyCompanyLogo(this.settings.company_logo);
    } else {
      this.syncSettingsLogoPreview('');
    }

    // Auto-update Webhook URL input with current origin
    const webhookInput = document.getElementById('setting-webhook-url');
    if (webhookInput) {
      webhookInput.value = `${window.location.origin}/api/webhook/moskit`;
    }
  },

  // ==========================================
  // CARREGAMENTO DE DADOS
  // ==========================================

  async loadSettings() {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.success) {
        this.settings = data.settings || {};
        this.nextOrcamento = data.nextOrcamento || {};

        // Update stats
        const statBudget = document.getElementById('stat-next-budget');
        if (statBudget && this.nextOrcamento.numero) {
          statBudget.textContent = this.nextOrcamento.numero;
        }

        // Fill settings modal
        const keyInput = document.getElementById('setting-moskit-api-key');
        if (keyInput) keyInput.value = this.settings.moskit_api_key || '';

        const numInput = document.getElementById('setting-orcamento-numero');
        if (numInput) numInput.value = this.settings.orcamento_proximo_numero || '1';

        const fmtInput = document.getElementById('setting-orcamento-formato');
        if (fmtInput) fmtInput.value = this.settings.orcamento_formato || '{NUM}/26';

        const autoCheck = document.getElementById('setting-orcamento-autoincrement');
        if (autoCheck) autoCheck.checked = (this.settings.orcamento_auto_increment !== 'false');

        // Populate grifar (highlight) checkboxes
        const grifarFields = ['data', 'orcamento', 'qtde', 'dimensao', 'posicao', 'modelo', 'base', 'entrega', 'observacoes'];
        const grifarDefaults = { data: true, orcamento: true, qtde: true, dimensao: true, posicao: true, modelo: false, base: false, entrega: false, observacoes: false };
        grifarFields.forEach(field => {
          const el = document.getElementById(`setting-grifar-${field}`);
          if (el) {
            const storedVal = this.settings[`grifar_${field}`];
            if (storedVal !== undefined && storedVal !== null) {
              el.checked = String(storedVal) === 'true';
            } else {
              el.checked = grifarDefaults[field] === true;
            }
          }
        });

        this.updatePreviewNextBudget();
      }
    } catch (e) {
      console.error('Erro ao carregar configurações:', e);
    }
  },

  async loadTemplates() {
    try {
      const res = await fetch('/api/templates');
      const data = await res.json();
      if (data.success) {
        this.templates = data.templates || [];
        this.renderTemplatesList();
        this.renderTemplateSelect();
      }
    } catch (e) {
      console.error('Erro ao carregar modelos:', e);
    }
  },

  async loadOrders() {
    try {
      const params = new URLSearchParams();
      if (this.currentSearch) params.append('search', this.currentSearch);
      if (this.currentFilter && this.currentFilter !== 'all') params.append('status', this.currentFilter);
      if (this.dateFrom) params.append('dateFrom', this.dateFrom);
      if (this.dateTo) params.append('dateTo', this.dateTo);
      params.append('page', String(this.currentPage));
      params.append('pageSize', String(this.pageSize));

      const res = await fetch(`/api/orders?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        this.orders = data.orders || [];
        this.totalOrders = data.total || 0;
        this.totalPages = data.totalPages || 1;
        this.currentPage = data.page || 1;
        this.renderOrdersTable();
        this.renderPagination();
        this.updateStats();
      }
    } catch (e) {
      console.error('Erro ao carregar ordens de serviço:', e);
    }
  },

  // ==========================================
  // RENDERIZAÇÃO
  // ==========================================

  updateStats() {
    document.getElementById('stat-total-orders').textContent = this.totalOrders || this.orders.length;
    document.getElementById('stat-won-deals').textContent = this.orders.filter(o => o.status === 'won').length;
    document.getElementById('stat-with-photo').textContent = this.orders.filter(o => o.photo_filename).length;
  },

  renderPagination() {
    const info = document.getElementById('pagination-info');
    const pagesEl = document.getElementById('pagination-pages');
    const prevBtn = document.getElementById('btn-page-prev');
    const nextBtn = document.getElementById('btn-page-next');
    const bar = document.getElementById('pagination-bar');

    if (!bar) return;

    if (this.totalOrders === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';

    const start = (this.currentPage - 1) * this.pageSize + 1;
    const end = Math.min(this.currentPage * this.pageSize, this.totalOrders);
    if (info) info.textContent = `Mostrando ${start}–${end} de ${this.totalOrders}`;

    if (prevBtn) prevBtn.disabled = this.currentPage <= 1;
    if (nextBtn) nextBtn.disabled = this.currentPage >= this.totalPages;

    if (pagesEl) {
      pagesEl.innerHTML = '';
      const maxBtns = 7;
      let startPage = Math.max(1, this.currentPage - 3);
      let endPage = Math.min(this.totalPages, startPage + maxBtns - 1);
      if (endPage - startPage < maxBtns - 1) startPage = Math.max(1, endPage - maxBtns + 1);

      for (let p = startPage; p <= endPage; p++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary btn-sm' + (p === this.currentPage ? ' active' : '');
        btn.textContent = p;
        btn.style.minWidth = '36px';
        if (p === this.currentPage) {
          btn.style.background = 'var(--accent-gold)';
          btn.style.color = '#0b0f19';
          btn.style.borderColor = 'var(--accent-gold)';
        }
        btn.addEventListener('click', () => {
          this.currentPage = p;
          this.loadOrders();
        });
        pagesEl.appendChild(btn);
      }
    }
  },

  renderOrdersTable() {
    const tbody = document.getElementById('orders-table-body');
    const emptyState = document.getElementById('orders-empty-state');
    tbody.innerHTML = '';

    if (this.orders.length === 0) {
      emptyState.style.display = 'block';
      return;
    }
    emptyState.style.display = 'none';

    this.orders.forEach(order => {
      const tr = document.createElement('tr');
      const isChecked = this.selectedIds.has(order.id);

      // Status pill label
      let statusBadge = '<span class="status-badge status-won">Ganhou</span>';
      if (order.status === 'production') statusBadge = '<span class="status-badge status-production">Em Produção</span>';
      else if (order.status === 'finished') statusBadge = '<span class="status-badge status-finished">Concluído</span>';

      // Photo indicator
      const photoHtml = order.photo_filename
        ? '<span class="photo-indicator photo-has">🖼️ Anexada</span>'
        : '<span class="photo-indicator photo-none">Sem foto</span>';

      tr.innerHTML = `
        <td class="col-select">
          <input type="checkbox" class="chk-order-row" data-id="${order.id}" ${isChecked ? 'checked' : ''}>
        </td>
        <td><span class="badge-budget">${order.orcamento_numero}</span></td>
        <td><small style="color: var(--text-secondary);">${order.data_os}</small></td>
        <td>
          <div class="client-name-cell">
            <strong>${order.nome_fantasia || 'Cliente Não Informado'}</strong>
            <small>${order.cnpj_cpf ? 'Doc: ' + order.cnpj_cpf : (order.contato_nome || '')}</small>
          </div>
        </td>
        <td>
          <span style="font-weight: 600;">${order.items_count || 1} item(ns)</span>
        </td>
        <td>
          <div style="font-size: 0.8rem; display: flex; flex-direction: column;">
            <span>Entrega: <strong>${order.data_entrega || '--/--/----'}</strong></span>
            <small style="color: var(--text-muted);">${order.forma_pagamento || ''} (${order.prazo_pagamento || ''})</small>
          </div>
        </td>
        <td>${photoHtml}</td>
        <td>${statusBadge}</td>
        <td style="text-align: right;">
          <div class="actions-cell" style="justify-content: flex-end;">
            <button class="btn btn-secondary btn-sm" onclick="App.openPrintPreview(${order.id})" title="Visualizar e Imprimir O.S.">
              🖨️ Imprimir
            </button>
            <button class="btn btn-outline-gold btn-sm" onclick="App.openPrintPreview(${order.id})" title="Baixar PDF">
              📥 PDF
            </button>
            <button class="btn btn-secondary btn-sm btn-icon" onclick="App.openEditModal(${order.id})" title="Editar">
              ✏️
            </button>
            <button class="btn btn-danger btn-sm btn-icon" onclick="App.deleteOrder(${order.id})" title="Excluir">
              🗑️
            </button>
          </div>
        </td>
      `;

      // Attach checkbox handler
      const chk = tr.querySelector('.chk-order-row');
      chk?.addEventListener('change', () => {
        if (chk.checked) this.selectedIds.add(order.id);
        else this.selectedIds.delete(order.id);
        this.updateBulkBar();
      });

      tbody.appendChild(tr);
    });

    this.updateBulkBar();
  },

  updateBulkBar() {
    const count = this.selectedIds.size;
    const bar = document.getElementById('bulk-actions-bar');
    const countEl = document.getElementById('bulk-selected-count');
    if (bar) bar.classList.toggle('active', count > 0);
    if (countEl) countEl.textContent = `${count} selecionada(s)`;

    // Sync select-all checkbox state
    const chkAll = document.getElementById('chk-select-all');
    const chkAllVis = document.getElementById('chk-select-all-visible');
    const visibleIds = Array.from(document.querySelectorAll('.chk-order-row')).map(c => parseInt(c.dataset.id));
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => this.selectedIds.has(id));
    if (chkAll) chkAll.checked = allVisibleSelected;
    if (chkAllVis) chkAllVis.checked = allVisibleSelected;
  },

  renderTemplateSelect() {
    const select = document.getElementById('order-template');
    if (!select) return;
    select.innerHTML = '';
    this.templates.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name + (t.is_default ? ' (Padrão)' : '');
      if (t.is_default) opt.selected = true;
      select.appendChild(opt);
    });
  },

  renderTemplatesList() {
    const container = document.getElementById('templates-list-container');
    if (!container) return;
    container.innerHTML = '';

    this.templates.forEach(t => {
      const card = document.createElement('div');
      card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; display: flex; justify-content: space-between; align-items: center;';
      
      card.innerHTML = `
        <div>
          <strong style="font-size: 1rem; color: var(--text-primary);">${t.name}</strong>
          ${t.is_default ? '<span class="status-badge status-won" style="margin-left: 0.5rem;">Padrão Ativo</span>' : ''}
          <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.2rem;">
            Arquivo: ${t.filename}
          </div>
        </div>
        <div style="display: flex; gap: 0.5rem;">
          ${!t.is_default ? `<button class="btn btn-secondary btn-sm" onclick="App.setDefaultTemplate(${t.id})">Tornar Padrão</button>` : ''}
          ${!t.is_default ? `<button class="btn btn-danger btn-sm btn-icon" onclick="App.deleteTemplate(${t.id})">🗑️</button>` : ''}
        </div>
      `;
      container.appendChild(card);
    });
  },

  updatePreviewNextBudget() {
    const numInput = document.getElementById('setting-orcamento-numero');
    const fmtInput = document.getElementById('setting-orcamento-formato');
    const previewEl = document.getElementById('preview-next-budget-format');
    if (!numInput || !fmtInput || !previewEl) return;

    const num = parseInt(numInput.value, 10) || 1;
    const fmt = fmtInput.value || '{NUM}/26';
    const numPadded = String(num).padStart(4, '0');
    const yy = String(new Date().getFullYear()).slice(-2);

    const formatted = fmt.replace('{NUM}', numPadded).replace('{YY}', yy);
    previewEl.textContent = formatted;
  },

  // ==========================================
  // EVENTOS E INTERAÇÃO
  // ==========================================

  setupEventListeners() {
    // ── Tema Claro/Escuro ──────────────────────────────────────────
    document.getElementById('btn-theme-toggle')?.addEventListener('click', () => this.toggleTheme());

    // ── Upload de Logotipo da Empresa (dentro de Configurações) ───
    const logoInput = document.getElementById('input-company-logo');
    const btnLogo   = document.getElementById('btn-upload-logo');
    const btnRemoveLogo = document.getElementById('btn-remove-logo');

    btnLogo?.addEventListener('click', () => logoInput?.click());
    logoInput?.addEventListener('change', (e) => {
      if (e.target.files.length > 0) this.uploadCompanyLogo(e.target.files[0]);
    });
    btnRemoveLogo?.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/settings/logo', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          this.settings = data.settings || this.settings;
          this.applyCompanyLogo('');
          this.syncSettingsLogoPreview('');
          this.showToast('Logotipo removido.', 'info');
        }
      } catch (e) {
        this.showToast('Erro ao remover logotipo: ' + e.message, 'error');
      }
    });

    // ── Busca ──────────────────────────────────────────────────────
    const searchInput = document.getElementById('input-search');
    let searchTimeout;
    searchInput?.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.currentSearch = e.target.value;
        this.currentPage = 1;
        this.loadOrders();
      }, 300);
    });

    // ── Filtro de Data ─────────────────────────────────────────────
    document.getElementById('btn-apply-date-filter')?.addEventListener('click', () => {
      const fromVal = document.getElementById('filter-date-from')?.value;
      const toVal   = document.getElementById('filter-date-to')?.value;
      this.dateFrom = fromVal || '';
      this.dateTo   = toVal   || '';
      this.currentPage = 1;
      this.loadOrders();
    });

    // ── Filter pills ───────────────────────────────────────────────
    document.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentFilter = btn.dataset.filter;
        this.currentPage = 1;
        this.loadOrders();
      });
    });

    // ── Paginação ──────────────────────────────────────────────────
    document.getElementById('btn-page-prev')?.addEventListener('click', () => {
      if (this.currentPage > 1) { this.currentPage--; this.loadOrders(); }
    });
    document.getElementById('btn-page-next')?.addEventListener('click', () => {
      if (this.currentPage < this.totalPages) { this.currentPage++; this.loadOrders(); }
    });
    document.getElementById('select-page-size')?.addEventListener('change', (e) => {
      this.pageSize = parseInt(e.target.value, 10) || 10;
      this.currentPage = 1;
      this.loadOrders();
    });

    // ── Selecionar Todas ───────────────────────────────────────────
    const chkSelectAll = document.getElementById('chk-select-all');
    chkSelectAll?.addEventListener('change', () => {
      document.querySelectorAll('.chk-order-row').forEach(chk => {
        const id = parseInt(chk.dataset.id);
        chk.checked = chkSelectAll.checked;
        if (chkSelectAll.checked) this.selectedIds.add(id);
        else this.selectedIds.delete(id);
      });
      const chkAllVis = document.getElementById('chk-select-all-visible');
      if (chkAllVis) chkAllVis.checked = chkSelectAll.checked;
      this.updateBulkBar();
    });

    const chkAllVis = document.getElementById('chk-select-all-visible');
    chkAllVis?.addEventListener('change', () => {
      document.querySelectorAll('.chk-order-row').forEach(chk => {
        const id = parseInt(chk.dataset.id);
        chk.checked = chkAllVis.checked;
        if (chkAllVis.checked) this.selectedIds.add(id);
        else this.selectedIds.delete(id);
      });
      const chkAll = document.getElementById('chk-select-all');
      if (chkAll) chkAll.checked = chkAllVis.checked;
      this.updateBulkBar();
    });

    // ── Ações em Lote ──────────────────────────────────────────────
    document.getElementById('btn-print-selected')?.addEventListener('click', () => {
      const ids = Array.from(this.selectedIds);
      if (!ids.length) return this.showToast('Selecione pelo menos uma O.S.', 'error');
      PrintManager.printSelected(ids);
    });

    document.getElementById('btn-pdf-selected')?.addEventListener('click', () => {
      const ids = Array.from(this.selectedIds);
      if (!ids.length) return this.showToast('Selecione pelo menos uma O.S.', 'error');
      ids.forEach(id => PrintManager.downloadPdf(id));
    });

    document.getElementById('btn-delete-selected')?.addEventListener('click', async () => {
      const ids = Array.from(this.selectedIds);
      if (!ids.length) return;
      if (!confirm(`Deseja excluir ${ids.length} O.S. selecionada(s)? Esta ação não pode ser desfeita.`)) return;
      for (const id of ids) {
        await fetch(`/api/orders/${id}`, { method: 'DELETE' });
      }
      this.selectedIds.clear();
      this.showToast(`${ids.length} O.S. excluída(s).`, 'info');
      await this.loadOrders();
    });

    // ── Modal openers ──────────────────────────────────────────────
    document.getElementById('btn-new-order')?.addEventListener('click', () => this.openNewOrderModal());
    document.getElementById('btn-sync-moskit')?.addEventListener('click', () => MoskitManager.syncWonDeals());
    
    document.getElementById('btn-import-id')?.addEventListener('click', () => {
      const dealId = prompt('Digite o ID numérico do negócio registrado no Moskit CRM:');
      if (dealId) MoskitManager.importDealById(dealId.trim());
    });

    document.getElementById('btn-open-mappings')?.addEventListener('click', () => {
      MoskitManager.renderMappingModal();
      document.getElementById('modal-mappings').classList.add('active');
    });

    document.getElementById('btn-open-skus')?.addEventListener('click', () => {
      SkuManager.openModal();
    });

    document.getElementById('btn-add-sku')?.addEventListener('click', () => {
      SkuManager.openNewModal();
    });

    document.getElementById('btn-sync-skus-moskit')?.addEventListener('click', () => {
      SkuManager.syncMoskitProducts();
    });

    document.getElementById('btn-save-sku')?.addEventListener('click', () => {
      SkuManager.saveSku();
    });

    // SKU Code live preview listener
    const skuCodeInput = document.getElementById('sku-input-code');
    let skuInputTimeout;
    skuCodeInput?.addEventListener('input', (e) => {
      clearTimeout(skuInputTimeout);
      skuInputTimeout = setTimeout(() => {
        SkuManager.handleSkuCodeInput(e.target.value);
      }, 250);
    });

    // Search SKU list listener
    const skuSearchInput = document.getElementById('input-search-sku');
    let skuSearchTimeout;
    skuSearchInput?.addEventListener('input', (e) => {
      clearTimeout(skuSearchTimeout);
      skuSearchTimeout = setTimeout(() => {
        SkuManager.loadSkus(e.target.value);
      }, 300);
    });

    document.getElementById('btn-open-templates')?.addEventListener('click', () => {
      document.getElementById('modal-templates').classList.add('active');
    });

    document.getElementById('btn-open-settings')?.addEventListener('click', () => {
      document.getElementById('modal-settings').classList.add('active');
    });

    // Modal closers
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.close;
        document.getElementById(modalId)?.classList.remove('active');
      });
    });

    // Close on backdrop click
    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
      });
    });

    // Save mappings
    document.getElementById('btn-save-mappings')?.addEventListener('click', () => MoskitManager.saveMappings());

    // Settings listeners
    document.getElementById('setting-orcamento-numero')?.addEventListener('input', () => this.updatePreviewNextBudget());
    document.getElementById('setting-orcamento-formato')?.addEventListener('input', () => this.updatePreviewNextBudget());

    document.getElementById('btn-save-settings')?.addEventListener('click', () => this.saveSettings());
    
    document.getElementById('btn-test-moskit-conn')?.addEventListener('click', async () => {
      const key = document.getElementById('setting-moskit-api-key').value;
      const res = await MoskitManager.testConnection(key);
      if (res.success) {
        this.showToast(res.message + (res.user ? ` (${res.user})` : ''), 'success');
      } else {
        this.showToast(res.message, 'error');
      }
    });

    document.getElementById('btn-copy-webhook')?.addEventListener('click', () => {
      const urlInput = document.getElementById('setting-webhook-url');
      urlInput.select();
      navigator.clipboard.writeText(urlInput.value);
      this.showToast('URL do Webhook copiada para a área de transferência!', 'success');
    });

    document.getElementById('btn-simulate-deal')?.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/test/simulate-deal', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          this.showToast('Negócio simulado importado com sucesso!', 'success');
          await this.loadOrders();
          await this.loadSettings();
          document.getElementById('modal-settings').classList.remove('active');
        }
      } catch (e) {
        this.showToast('Erro ao simular: ' + e.message, 'error');
      }
    });

    // Order form buttons
    document.getElementById('btn-add-item')?.addEventListener('click', () => this.addItemRow());
    document.getElementById('btn-save-order')?.addEventListener('click', () => this.saveOrder());
    document.getElementById('btn-preview-from-modal')?.addEventListener('click', () => {
      const order = this.collectOrderFormData();
      PrintManager.openPreview(order);
    });

    // Photo drag & drop
    const dropzone = document.getElementById('photo-dropzone');
    const photoInput = document.getElementById('input-photo-file');

    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));

    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        this.handlePhotoSelect(e.dataTransfer.files[0]);
      }
    });

    photoInput?.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.handlePhotoSelect(e.target.files[0]);
      }
    });

    document.getElementById('btn-remove-photo')?.addEventListener('click', () => this.removeCurrentPhoto());

    // PDF template upload dropzone
    const tmplDropzone = document.getElementById('template-dropzone');
    const tmplInput = document.getElementById('input-template-file');

    tmplDropzone?.addEventListener('dragover', (e) => { e.preventDefault(); tmplDropzone.classList.add('dragover'); });
    tmplDropzone?.addEventListener('dragleave', () => tmplDropzone.classList.remove('dragover'));
    tmplDropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      tmplDropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) this.uploadNewTemplate(e.dataTransfer.files[0]);
    });
    tmplInput?.addEventListener('change', (e) => {
      if (e.target.files.length > 0) this.uploadNewTemplate(e.target.files[0]);
    });
  },

  // ==========================================
  // OPERAÇÕES DA O.S. (CRUD)
  // ==========================================

  async openNewOrderModal() {
    document.getElementById('modal-order-title').innerHTML = '<span>➕</span> Nova Ordem de Serviço';
    document.getElementById('order-id').value = '';
    document.getElementById('order-moskit-id').value = '';

    // Next sequential budget
    const seq = await fetch('/api/next-orcamento').then(r => r.json());
    document.getElementById('order-orcamento').value = seq.numero || '';
    document.getElementById('order-data').value = new Date().toLocaleDateString('pt-BR');
    
    document.getElementById('order-nome-fantasia').value = '';
    document.getElementById('order-razao-social').value = '';
    document.getElementById('order-cnpj').value = '';
    document.getElementById('order-contato').value = '';
    document.getElementById('order-telefone').value = '';
    document.getElementById('order-entrega').value = '';
    document.getElementById('order-forma-pgto').value = this.settings.default_forma_pagamento || 'PIX';
    document.getElementById('order-prazo-pgto').value = this.settings.default_prazo_pagamento || 'À Vista';
    document.getElementById('order-frete').value = this.settings.default_frete || 'Incluso';
    document.getElementById('order-status').value = 'won';
    document.getElementById('order-observacoes').value = '';

    // Clear items table & add 1 default row
    const tbody = document.getElementById('order-items-tbody');
    tbody.innerHTML = '';
    this.addItemRow({ qtde: '1', prod: 'Wind Banner Dupla Face', modelo: 'Pena 3m', dimensao: '3,00m x 0,70m', posicao: 'Frente e Verso', base: 'Base Cruzada Bóia' });

    // Clear photo
    this.selectedPhotoFile = null;
    document.getElementById('photo-preview-container').style.display = 'none';
    document.getElementById('photo-dropzone').style.display = 'block';

    document.getElementById('modal-order').classList.add('active');
  },

  async openEditModal(orderId) {
    try {
      const res = await fetch(`/api/orders/${orderId}`);
      const data = await res.json();
      if (!data.success) return this.showToast('Erro ao carregar dados da O.S.', 'error');

      const o = data.order;
      document.getElementById('modal-order-title').innerHTML = `<span>✏️</span> Editar O.S. Nº ${o.orcamento_numero}`;
      document.getElementById('order-id').value = o.id;
      document.getElementById('order-moskit-id').value = o.moskit_deal_id || '';
      document.getElementById('order-orcamento').value = o.orcamento_numero;
      document.getElementById('order-data').value = o.data_os;
      document.getElementById('order-nome-fantasia').value = o.nome_fantasia || '';
      document.getElementById('order-razao-social').value = o.razao_social || '';
      document.getElementById('order-cnpj').value = o.cnpj_cpf || '';
      document.getElementById('order-contato').value = o.contato_nome || '';
      document.getElementById('order-telefone').value = o.contato_telefone || '';
      document.getElementById('order-entrega').value = o.data_entrega || '';
      document.getElementById('order-forma-pgto').value = o.forma_pagamento || '';
      document.getElementById('order-prazo-pgto').value = o.prazo_pagamento || '';
      document.getElementById('order-frete').value = o.frete || '';
      document.getElementById('order-status').value = o.status || 'won';
      document.getElementById('order-observacoes').value = o.observacoes || '';

      if (o.template_id) {
        document.getElementById('order-template').value = o.template_id;
      }

      // Populate items table
      const tbody = document.getElementById('order-items-tbody');
      tbody.innerHTML = '';
      if (o.items && o.items.length > 0) {
        o.items.forEach(it => this.addItemRow(it));
      } else {
        this.addItemRow();
      }

      // Populate photo
      this.selectedPhotoFile = null;
      const previewContainer = document.getElementById('photo-preview-container');
      const dropzone = document.getElementById('photo-dropzone');
      const previewImg = document.getElementById('photo-preview-img');

      if (o.photo_filename) {
        previewImg.src = `/uploads/${o.photo_filename}?t=${Date.now()}`;
        previewContainer.style.display = 'flex';
        dropzone.style.display = 'none';
      } else {
        previewContainer.style.display = 'none';
        dropzone.style.display = 'block';
      }

      document.getElementById('modal-order').classList.add('active');
    } catch (e) {
      this.showToast('Erro ao abrir O.S.: ' + e.message, 'error');
    }
  },

  addItemRow(item = {}) {
    const tbody = document.getElementById('order-items-tbody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" list="skus-datalist" class="item-sku" value="${item.sku || ''}" placeholder="ex: WBB200FDSO" onchange="App.onSkuChange(this)"></td>
      <td><input type="text" class="item-qtde" value="${item.qtde || '1'}" placeholder="1"></td>
      <td><input type="text" class="item-prod" value="${item.prod || ''}" placeholder="Nome do produto"></td>
      <td><input type="text" class="item-modelo" value="${item.modelo || ''}" placeholder="ex: Pena, Box"></td>
      <td><input type="text" class="item-dimensao" value="${item.dimensao || ''}" placeholder="ex: 2,00"></td>
      <td><input type="text" class="item-posicao" value="${item.posicao || ''}" placeholder="ex: Face Dupla"></td>
      <td><input type="text" class="item-base" value="${item.base || ''}" placeholder="ex: Solo, Plástica"></td>
      <td style="text-align: center;">
        <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="this.closest('tr').remove()" title="Excluir item">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  },

  async onSkuChange(inputEl) {
    const rawSku = String(inputEl.value || '').trim().toUpperCase();
    if (!rawSku) return;

    inputEl.value = rawSku;
    const row = inputEl.closest('tr');
    if (!row) return;

    // Check local SkuManager first
    let skuInfo = SkuManager.getSkuInfo(rawSku);
    if (!skuInfo) {
      try {
        const res = await fetch(`/api/skus/${encodeURIComponent(rawSku)}`);
        const data = await res.json();
        if (data.success && data.sku) {
          skuInfo = data.sku;
        }
      } catch (e) {}
    }

    if (skuInfo) {
      const prodInp = row.querySelector('.item-prod');
      const modInp = row.querySelector('.item-modelo');
      const dimInp = row.querySelector('.item-dimensao');
      const posInp = row.querySelector('.item-posicao');
      const baseInp = row.querySelector('.item-base');

      if (skuInfo.prod && prodInp) prodInp.value = skuInfo.prod;
      if (skuInfo.modelo && modInp) modInp.value = skuInfo.modelo;
      if (skuInfo.dimensao && dimInp) dimInp.value = skuInfo.dimensao;
      if (skuInfo.posicao && posInp) posInp.value = skuInfo.posicao;
      if (skuInfo.base && baseInp) baseInp.value = skuInfo.base;
    }
  },

  handlePhotoSelect(file) {
    if (!file || !file.type.startsWith('image/')) {
      return this.showToast('Por favor selecione um arquivo de imagem válido (JPG, PNG).', 'error');
    }

    this.selectedPhotoFile = file;

    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('photo-preview-img').src = e.target.result;
      document.getElementById('photo-preview-container').style.display = 'flex';
      document.getElementById('photo-dropzone').style.display = 'none';
    };
    reader.readAsDataURL(file);
  },

  async removeCurrentPhoto() {
    const orderId = document.getElementById('order-id').value;
    if (orderId) {
      await fetch(`/api/orders/${orderId}/photo`, { method: 'DELETE' });
    }
    this.selectedPhotoFile = null;
    document.getElementById('photo-preview-img').src = '';
    document.getElementById('photo-preview-container').style.display = 'none';
    document.getElementById('photo-dropzone').style.display = 'block';
    this.showToast('Foto removida.', 'info');
  },

  collectOrderFormData() {
    const orderId = document.getElementById('order-id').value;
    const items = [];

    document.querySelectorAll('#order-items-tbody tr').forEach((tr, index) => {
      items.push({
        sku: tr.querySelector('.item-sku')?.value || '',
        qtde: tr.querySelector('.item-qtde')?.value || '1',
        prod: tr.querySelector('.item-prod')?.value || '',
        modelo: tr.querySelector('.item-modelo')?.value || '',
        dimensao: tr.querySelector('.item-dimensao')?.value || '',
        posicao: tr.querySelector('.item-posicao')?.value || '',
        base: tr.querySelector('.item-base')?.value || '',
        ordem: index
      });
    });

    return {
      id: orderId ? parseInt(orderId, 10) : null,
      orcamento_numero: document.getElementById('order-orcamento').value,
      data_os: document.getElementById('order-data').value,
      template_id: parseInt(document.getElementById('order-template').value, 10) || null,
      status: document.getElementById('order-status').value,
      nome_fantasia: document.getElementById('order-nome-fantasia').value,
      razao_social: document.getElementById('order-razao-social').value,
      cnpj_cpf: document.getElementById('order-cnpj').value,
      contato_nome: document.getElementById('order-contato').value,
      contato_telefone: document.getElementById('order-telefone').value,
      data_entrega: document.getElementById('order-entrega').value,
      forma_pagamento: document.getElementById('order-forma-pgto').value,
      prazo_pagamento: document.getElementById('order-prazo-pgto').value,
      frete: document.getElementById('order-frete').value,
      observacoes: document.getElementById('order-observacoes').value,
      items: items
    };
  },

  async saveOrder() {
    const orderData = this.collectOrderFormData();
    if (!orderData.nome_fantasia.trim()) {
      return this.showToast('O campo "Nome Fantasia" é obrigatório.', 'error');
    }

    try {
      let savedOrder;
      if (orderData.id) {
        // Update
        const res = await fetch(`/api/orders/${orderData.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderData, items: orderData.items })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        savedOrder = data.order;
        this.showToast('Ordem de Serviço atualizada com sucesso!', 'success');
      } else {
        // Create
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderData, items: orderData.items })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        savedOrder = data.order;
        this.showToast(`O.S. Nº ${savedOrder.orcamento_numero} criada com sucesso!`, 'success');
      }

      // If photo was selected, upload it now
      if (this.selectedPhotoFile) {
        const formData = new FormData();
        formData.append('photo', this.selectedPhotoFile);
        await fetch(`/api/orders/${savedOrder.id}/photo`, {
          method: 'POST',
          body: formData
        });
      }

      document.getElementById('modal-order').classList.remove('active');
      await this.loadOrders();
      await this.loadSettings();
    } catch (e) {
      this.showToast('Erro ao salvar: ' + e.message, 'error');
    }
  },

  async deleteOrder(orderId) {
    if (!confirm('Deseja realmente excluir esta Ordem de Serviço? Esta ação não pode ser desfeita.')) return;
    try {
      const res = await fetch(`/api/orders/${orderId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast('Ordem de Serviço excluída.', 'info');
        await this.loadOrders();
      }
    } catch (e) {
      this.showToast('Erro ao excluir: ' + e.message, 'error');
    }
  },

  async openPrintPreview(orderId) {
    try {
      const res = await fetch(`/api/orders/${orderId}`);
      const data = await res.json();
      if (data.success) {
        PrintManager.openPreview(data.order);
      }
    } catch (e) {
      this.showToast('Erro ao carregar pré-visualização: ' + e.message, 'error');
    }
  },

  // ==========================================
  // MODELOS DE PDF
  // ==========================================

  async uploadNewTemplate(file) {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      return this.showToast('Por favor selecione um arquivo no formato PDF.', 'error');
    }

    const formData = new FormData();
    formData.append('templateFile', file);
    formData.append('name', file.name.replace('.pdf', ''));

    try {
      const res = await fetch('/api/templates/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        this.showToast('Novo modelo PDF cadastrado com sucesso!', 'success');
        await this.loadTemplates();
      } else {
        this.showToast('Erro ao enviar modelo: ' + data.error, 'error');
      }
    } catch (e) {
      this.showToast('Falha no upload: ' + e.message, 'error');
    }
  },

  async setDefaultTemplate(templateId) {
    try {
      const res = await fetch(`/api/templates/${templateId}/default`, { method: 'PUT' });
      const data = await res.json();
      if (data.success) {
        this.showToast('Modelo padrão atualizado!', 'success');
        await this.loadTemplates();
      }
    } catch (e) {
      this.showToast('Erro ao definir padrão: ' + e.message, 'error');
    }
  },

  async deleteTemplate(templateId) {
    if (!confirm('Deseja excluir este modelo de PDF?')) return;
    try {
      const res = await fetch(`/api/templates/${templateId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast('Modelo removido com sucesso.', 'info');
        await this.loadTemplates();
      } else {
        this.showToast(data.error, 'error');
      }
    } catch (e) {
      this.showToast('Erro ao excluir: ' + e.message, 'error');
    }
  },

  // ==========================================
  // CONFIGURAÇÕES GERAIS
  // ==========================================

  async saveSettings() {
    const payload = {
      moskit_api_key: document.getElementById('setting-moskit-api-key').value.trim(),
      orcamento_proximo_numero: document.getElementById('setting-orcamento-numero').value.trim(),
      orcamento_formato: document.getElementById('setting-orcamento-formato').value.trim(),
      orcamento_auto_increment: document.getElementById('setting-orcamento-autoincrement').checked ? 'true' : 'false'
    };

    // Persist grifar (highlight) checkboxes
    const grifarFields = ['data', 'orcamento', 'qtde', 'dimensao', 'posicao', 'modelo', 'base', 'entrega', 'observacoes'];
    grifarFields.forEach(field => {
      const el = document.getElementById(`setting-grifar-${field}`);
      if (el) payload[`grifar_${field}`] = el.checked ? 'true' : 'false';
    });

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        this.settings = data.settings;
        this.nextOrcamento = data.nextOrcamento;
        this.showToast('Configurações salvas com sucesso!', 'success');
        document.getElementById('modal-settings').classList.remove('active');
        await this.loadSettings();
      }
    } catch (e) {
      this.showToast('Erro ao salvar configurações: ' + e.message, 'error');
    }
  },

  // Toast Notification
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    else if (type === 'error') icon = '❌';

    toast.innerHTML = `<span>${icon}</span> <div>${message}</div>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }
};

// Initialize App on DOM load
window.addEventListener('DOMContentLoaded', () => {
  App.init();
});
