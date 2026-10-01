// moskit.js - Gerenciamento de Integração e Parametrização Moskit CRM

const MoskitManager = {
  availableFields: { orderFields: [], itemFields: [] },
  currentMappings: [],

  async init() {
    await this.fetchFields();
    await this.fetchMappings();
  },

  async fetchFields() {
    try {
      const res = await fetch('/api/moskit/fields');
      const data = await res.json();
      if (data.success) {
        this.availableFields = {
          orderFields: data.orderFields || [],
          itemFields: data.itemFields || []
        };
      }
    } catch (e) {
      console.error('Erro ao buscar campos do Moskit:', e);
    }
  },

  async fetchMappings() {
    try {
      const res = await fetch('/api/mappings');
      const data = await res.json();
      if (data.success) {
        this.currentMappings = data.mappings || [];
      }
    } catch (e) {
      console.error('Erro ao buscar mapeamentos:', e);
    }
  },

  renderMappingModal() {
    const headerContainer = document.getElementById('mappings-header-fields');
    const itemContainer = document.getElementById('mappings-item-fields');
    if (!headerContainer || !itemContainer) return;

    headerContainer.innerHTML = '';
    itemContainer.innerHTML = '';

    const headerFieldDefs = [
      { key: 'nome_fantasia', label: 'Nome Fantasia (Cliente)', icon: '🏢' },
      { key: 'razao_social', label: 'Razão Social da Empresa', icon: '📄' },
      { key: 'cnpj_cpf', label: 'CNPJ / CPF', icon: '💳' },
      { key: 'contato_nome', label: 'Nome do Contato', icon: '👤' },
      { key: 'contato_telefone', label: 'Telefone / WhatsApp', icon: '📞' },
      { key: 'data_entrega', label: 'Data de Entrega', icon: '📅' },
      { key: 'forma_pagamento', label: 'Forma de Pagamento', icon: '💰' },
      { key: 'prazo_pagamento', label: 'Prazo de Pagamento', icon: '⏳' },
      { key: 'frete', label: 'Tipo de Frete', icon: '🚚' }
    ];

    const itemFieldDefs = [
      { key: 'item_qtde', label: 'Coluna QTDE.', icon: '🔢' },
      { key: 'item_prod', label: 'Coluna PROD. (Nome)', icon: '📦' },
      { key: 'item_modelo', label: 'Coluna MODELO', icon: '🏷️' },
      { key: 'item_dimensao', label: 'Coluna DIMENSÃO', icon: '📐' },
      { key: 'item_posicao', label: 'Coluna POSIÇÃO', icon: '🔄' },
      { key: 'item_base', label: 'Coluna BASE', icon: '⚓' }
    ];

    const mapLookup = {};
    for (const m of this.currentMappings) {
      mapLookup[m.os_field] = m;
    }

    // Build Header Fields
    headerFieldDefs.forEach(def => {
      const currentMap = mapLookup[def.key] || { moskit_source: '', fallback_value: '' };
      const row = document.createElement('div');
      row.className = 'mapping-row';

      let optionsHtml = '<option value="">-- Não mapear (deixar manual) --</option>';
      const grouped = this.groupFields(this.availableFields.orderFields);

      for (const [groupName, fList] of Object.entries(grouped)) {
        optionsHtml += `<optgroup label="${groupName}">`;
        for (const f of fList) {
          const selected = f.id === currentMap.moskit_source ? 'selected' : '';
          optionsHtml += `<option value="${f.id}" ${selected}>${f.label}</option>`;
        }
        optionsHtml += '</optgroup>';
      }

      row.innerHTML = `
        <div class="mapping-label">
          <span>${def.icon}</span> ${def.label}
        </div>
        <select class="mapping-select" data-field="${def.key}">
          ${optionsHtml}
        </select>
        <input type="text" class="mapping-fallback" data-field="${def.key}" 
               placeholder="Valor padrão (opcional)" value="${currentMap.fallback_value || ''}">
      `;
      headerContainer.appendChild(row);
    });

    // Build Item Fields
    itemFieldDefs.forEach(def => {
      const currentMap = mapLookup[def.key] || { moskit_source: '', fallback_value: '' };
      const row = document.createElement('div');
      row.className = 'mapping-row';

      let optionsHtml = '<option value="">-- Padrão do Produto --</option>';
      const grouped = this.groupFields(this.availableFields.itemFields);

      for (const [groupName, fList] of Object.entries(grouped)) {
        optionsHtml += `<optgroup label="${groupName}">`;
        for (const f of fList) {
          const selected = f.id === currentMap.moskit_source ? 'selected' : '';
          optionsHtml += `<option value="${f.id}" ${selected}>${f.label}</option>`;
        }
        optionsHtml += '</optgroup>';
      }

      row.innerHTML = `
        <div class="mapping-label">
          <span>${def.icon}</span> ${def.label}
        </div>
        <select class="mapping-select" data-field="${def.key}">
          ${optionsHtml}
        </select>
        <input type="text" class="mapping-fallback" data-field="${def.key}" 
               placeholder="Valor padrão (opcional)" value="${currentMap.fallback_value || ''}">
      `;
      itemContainer.appendChild(row);
    });
  },

  groupFields(fieldsList) {
    const groups = {};
    for (const f of fieldsList) {
      const cat = f.category || 'Geral';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(f);
    }
    return groups;
  },

  async saveMappings() {
    const selects = document.querySelectorAll('.mapping-select');
    const fallbacks = document.querySelectorAll('.mapping-fallback');

    const fallbackMap = {};
    fallbacks.forEach(input => {
      fallbackMap[input.dataset.field] = input.value;
    });

    const payload = [];
    selects.forEach(select => {
      const fieldKey = select.dataset.field;
      payload.push({
        os_field: fieldKey,
        moskit_source: select.value,
        fallback_value: fallbackMap[fieldKey] || ''
      });
    });

    try {
      const res = await fetch('/api/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: payload })
      });
      const data = await res.json();
      if (data.success) {
        this.currentMappings = data.mappings;
        App.showToast('Parametrização salva com sucesso!', 'success');
        document.getElementById('modal-mappings').classList.remove('active');
      } else {
        App.showToast('Erro ao salvar parametrização: ' + data.error, 'error');
      }
    } catch (e) {
      App.showToast('Erro ao comunicar com o servidor: ' + e.message, 'error');
    }
  },

  async testConnection(apiKey) {
    try {
      const res = await fetch('/api/moskit/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey })
      });
      const data = await res.json();
      return data;
    } catch (e) {
      return { success: false, message: e.message };
    }
  },

  async syncWonDeals() {
    const btn = document.getElementById('btn-sync-moskit');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Sincronizando...';
    }

    try {
      const res = await fetch('/api/moskit/sync', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const { created, updated, total } = data.results;
        App.showToast(`Sincronização concluída! ${created} novas O.S. criadas, ${updated} atualizadas de ${total} negócios ganhos.`, 'success');
        await App.loadOrders();
        await App.loadSettings();
      } else {
        App.showToast(data.error || 'Erro ao sincronizar negócios.', 'error');
      }
    } catch (e) {
      App.showToast('Falha na sincronização: ' + e.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>🔄</span> Sincronizar Moskit';
      }
    }
  },

  async importDealById(dealId) {
    if (!dealId || isNaN(dealId)) {
      App.showToast('Informe um ID numérico válido do Moskit CRM.', 'error');
      return;
    }

    try {
      const res = await fetch(`/api/moskit/import-deal/${dealId}`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        App.showToast(`Negócio #${dealId} importado com sucesso!`, 'success');
        await App.loadOrders();
        await App.loadSettings();
      } else {
        App.showToast('Erro ao importar negócio: ' + data.error, 'error');
      }
    } catch (e) {
      App.showToast('Erro de requisição: ' + e.message, 'error');
    }
  }
};
