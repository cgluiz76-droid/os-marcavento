// skuManager.js - Gestão e Parametrização de SKUs de Produtos (Marca Vento)

const SkuManager = {
  skus: [],
  currentEditingId: null,

  async init() {
    await this.loadSkus();
  },

  async loadSkus(search = '') {
    try {
      const url = search ? `/api/skus?search=${encodeURIComponent(search)}` : '/api/skus';
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        this.skus = data.skus || [];
        this.renderTable();
        this.updateDatalist();
      }
    } catch (e) {
      console.error('Erro ao carregar SKUs:', e);
    }
  },

  updateDatalist() {
    let datalist = document.getElementById('skus-datalist');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'skus-datalist';
      document.body.appendChild(datalist);
    }
    datalist.innerHTML = '';
    this.skus.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.sku;
      opt.label = `${s.prod} ${s.modelo ? s.modelo + ' ' : ''}${s.dimensao ? s.dimensao + ' ' : ''}${s.posicao || ''}`.trim();
      datalist.appendChild(opt);
    });
  },

  openModal() {
    this.loadSkus();
    document.getElementById('modal-skus')?.classList.add('active');
  },

  closeModal() {
    document.getElementById('modal-skus')?.classList.remove('active');
  },

  renderTable() {
    const tbody = document.getElementById('skus-table-body');
    const countEl = document.getElementById('skus-count-badge');
    if (!tbody) return;

    if (countEl) countEl.textContent = `${this.skus.length} cadastrados`;
    tbody.innerHTML = '';

    if (this.skus.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">
            Nenhum SKU encontrado. Clique em "➕ Novo SKU" ou "🔄 Sincronizar Produtos do Moskit".
          </td>
        </tr>
      `;
      return;
    }

    this.skus.forEach(s => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong style="color: var(--accent-gold); font-family: monospace; font-size: 0.95rem;">${s.sku}</strong></td>
        <td><strong>${s.prod || '-'}</strong></td>
        <td>${s.modelo || '-'}</td>
        <td><span class="badge-dimensao">${s.dimensao || '-'}</span></td>
        <td>${s.posicao || '-'}</td>
        <td>${s.base || '-'}</td>
        <td><small style="color: var(--text-muted);">${s.descricao || '-'}</small></td>
        <td style="text-align: right; white-space: nowrap;">
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="SkuManager.openEditModal(${s.id})" title="Editar SKU">✏️</button>
          <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="SkuManager.deleteSku(${s.id}, '${s.sku}')" title="Excluir SKU">🗑️</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  },

  openNewModal() {
    this.currentEditingId = null;
    document.getElementById('form-sku-title').textContent = '➕ Novo Cadastro de SKU';
    document.getElementById('sku-input-code').value = '';
    document.getElementById('sku-input-prod').value = '';
    document.getElementById('sku-input-modelo').value = '';
    document.getElementById('sku-input-dimensao').value = '';
    document.getElementById('sku-input-posicao').value = '';
    document.getElementById('sku-input-base').value = '';
    document.getElementById('sku-input-descricao').value = '';
    document.getElementById('sku-auto-preview').style.display = 'none';

    document.getElementById('modal-sku-form')?.classList.add('active');
    setTimeout(() => document.getElementById('sku-input-code')?.focus(), 150);
  },

  openEditModal(id) {
    const item = this.skus.find(x => x.id === id);
    if (!item) return;

    this.currentEditingId = id;
    document.getElementById('form-sku-title').textContent = `✏️ Editar SKU: ${item.sku}`;
    document.getElementById('sku-input-code').value = item.sku;
    document.getElementById('sku-input-prod').value = item.prod || '';
    document.getElementById('sku-input-modelo').value = item.modelo || '';
    document.getElementById('sku-input-dimensao').value = item.dimensao || '';
    document.getElementById('sku-input-posicao').value = item.posicao || '';
    document.getElementById('sku-input-base').value = item.base || '';
    document.getElementById('sku-input-descricao').value = item.descricao || '';
    document.getElementById('sku-auto-preview').style.display = 'none';

    document.getElementById('modal-sku-form')?.classList.add('active');
  },

  closeFormModal() {
    document.getElementById('modal-sku-form')?.classList.remove('active');
  },

  async handleSkuCodeInput(val) {
    const clean = String(val || '').trim().toUpperCase();
    if (!clean) {
      document.getElementById('sku-auto-preview').style.display = 'none';
      return;
    }

    try {
      const res = await fetch('/api/skus/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: clean })
      });
      const data = await res.json();
      if (data.success && data.parsed) {
        const p = data.parsed;
        const previewEl = document.getElementById('sku-auto-preview');
        previewEl.style.display = 'block';
        previewEl.innerHTML = `
          ⚡ <strong>Decomposição Sugerida:</strong> 
          Prod: <span class="preview-tag">${p.prod || '-'}</span> | 
          Mod: <span class="preview-tag">${p.modelo || '-'}</span> | 
          Dim: <span class="preview-tag">${p.dimensao || '-'}</span> | 
          Pos: <span class="preview-tag">${p.posicao || '-'}</span> | 
          Base: <span class="preview-tag">${p.base || '-'}</span>
          <button type="button" class="btn btn-secondary btn-sm" style="margin-left: 0.5rem; padding: 2px 8px;" onclick="SkuManager.applyParsedFields(${JSON.stringify(p).replace(/"/g, '&quot;')})">Preencher Campos</button>
        `;

        // If this is a new SKU and fields are currently empty, auto-fill
        if (!this.currentEditingId) {
          const prodInp = document.getElementById('sku-input-prod');
          if (!prodInp.value && p.prod) prodInp.value = p.prod;
          const modInp = document.getElementById('sku-input-modelo');
          if (!modInp.value && p.modelo) modInp.value = p.modelo;
          const dimInp = document.getElementById('sku-input-dimensao');
          if (!dimInp.value && p.dimensao) dimInp.value = p.dimensao;
          const posInp = document.getElementById('sku-input-posicao');
          if (!posInp.value && p.posicao) posInp.value = p.posicao;
          const baseInp = document.getElementById('sku-input-base');
          if (!baseInp.value && p.base) baseInp.value = p.base;
        }
      }
    } catch (e) {}
  },

  applyParsedFields(p) {
    if (p.prod) document.getElementById('sku-input-prod').value = p.prod;
    if (p.modelo) document.getElementById('sku-input-modelo').value = p.modelo;
    if (p.dimensao) document.getElementById('sku-input-dimensao').value = p.dimensao;
    if (p.posicao) document.getElementById('sku-input-posicao').value = p.posicao;
    if (p.base) document.getElementById('sku-input-base').value = p.base;
  },

  async saveSku() {
    const skuCode = document.getElementById('sku-input-code').value.trim().toUpperCase();
    if (!skuCode) {
      return App.showToast('O código do SKU é obrigatório.', 'error');
    }

    const payload = {
      sku: skuCode,
      prod: document.getElementById('sku-input-prod').value.trim(),
      modelo: document.getElementById('sku-input-modelo').value.trim(),
      dimensao: document.getElementById('sku-input-dimensao').value.trim(),
      posicao: document.getElementById('sku-input-posicao').value.trim(),
      base: document.getElementById('sku-input-base').value.trim(),
      descricao: document.getElementById('sku-input-descricao').value.trim()
    };

    try {
      const res = await fetch('/api/skus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        App.showToast(`SKU "${skuCode}" parametrizado com sucesso!`, 'success');
        this.closeFormModal();
        await this.loadSkus();
      } else {
        App.showToast('Erro ao salvar SKU: ' + data.error, 'error');
      }
    } catch (e) {
      App.showToast('Erro: ' + e.message, 'error');
    }
  },

  async deleteSku(id, skuCode) {
    if (!confirm(`Deseja realmente remover o SKU "${skuCode}" do dicionário?`)) return;
    try {
      const res = await fetch(`/api/skus/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        App.showToast(`SKU "${skuCode}" removido.`, 'info');
        await this.loadSkus();
      }
    } catch (e) {
      App.showToast('Erro ao excluir: ' + e.message, 'error');
    }
  },

  async syncMoskitProducts() {
    const btn = document.getElementById('btn-sync-skus-moskit');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Sincronizando...';
    }

    try {
      const res = await fetch('/api/skus/sync-moskit', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        App.showToast(`Sincronização concluída! ${data.added} novo(s) SKU(s) cadastrados, ${data.updated} atualizado(s).`, 'success');
        await this.loadSkus();
      } else {
        App.showToast('Erro ao sincronizar: ' + (data.error || 'Erro desconhecido'), 'error');
      }
    } catch (e) {
      App.showToast('Falha na sincronização: ' + e.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 Sincronizar Produtos do Moskit';
      }
    }
  },

  // Lookup SKU details helper for order editing
  getSkuInfo(skuCode) {
    if (!skuCode) return null;
    const clean = String(skuCode).trim().toUpperCase();
    return this.skus.find(s => s.sku.toUpperCase() === clean) || null;
  }
};
