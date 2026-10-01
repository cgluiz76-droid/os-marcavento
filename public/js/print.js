// print.js - Gerenciamento de Renderização para Impressão e PDF (mesmo layout)

const PrintManager = {
  currentOrder: null,

  // Retorna as configurações de grifar do App (se disponível)
  getGrifar() {
    if (typeof App === 'undefined' || !App.settings) return {};
    const s = App.settings;
    return {
      data:        String(s.grifar_data)        === 'true',
      orcamento:   String(s.grifar_orcamento)   === 'true',
      qtde:        String(s.grifar_qtde)        === 'true',
      dimensao:    String(s.grifar_dimensao)    === 'true',
      posicao:     String(s.grifar_posicao)     === 'true',
      modelo:      String(s.grifar_modelo)      === 'true',
      base:        String(s.grifar_base)        === 'true',
      entrega:     String(s.grifar_entrega)     === 'true',
      observacoes: String(s.grifar_observacoes) === 'true',
    };
  },

  // Aplica destaque amarelo ao elemento conforme flag
  applyHighlight(el, active) {
    if (!el) return;
    el.style.backgroundColor = active ? '#fef08a' : '';
    el.style.color           = active ? '#000000' : '';
    el.style.fontWeight      = active ? 'bold'    : '';
    el.style.borderRadius    = active ? '2px'     : '';
    el.style.padding         = active ? '0 2px'   : '';
  },

  // Aplica destaque numa célula <td> inteira
  applyHighlightCell(td, active) {
    if (!td) return;
    td.style.backgroundColor = active ? '#fef08a' : '';
    td.style.fontWeight      = active ? 'bold'    : '';
  },

  renderOrderToSheet(order, tbodyEl) {
    this.currentOrder = order;
    const g = this.getGrifar();

    const dataEl    = document.getElementById('print-data');
    const orcEl     = document.getElementById('print-orcamento');
    const nomeEl    = document.getElementById('print-nome-fantasia');
    const entregaEl = document.getElementById('print-entrega');
    const formaEl   = document.getElementById('print-forma-pgto');
    const prazoEl   = document.getElementById('print-prazo-pgto');
    const freteEl   = document.getElementById('print-frete');
    const obsEl     = document.getElementById('print-observacoes');

    if (dataEl)    { dataEl.textContent    = order.data_os || new Date().toLocaleDateString('pt-BR'); this.applyHighlight(dataEl, g.data); }
    if (orcEl)     { orcEl.textContent     = order.orcamento_numero || '----/--';                     this.applyHighlight(orcEl, g.orcamento); }
    if (nomeEl)    { nomeEl.textContent    = (order.nome_fantasia || 'NÃO INFORMADO').toUpperCase(); }
    if (entregaEl) { entregaEl.textContent = order.data_entrega || '--/--/----';                      this.applyHighlight(entregaEl, g.entrega); }
    if (formaEl)   { formaEl.textContent   = order.forma_pagamento || 'PIX'; }
    if (prazoEl)   { prazoEl.textContent   = order.prazo_pagamento || 'À Vista'; }
    if (freteEl)   { freteEl.textContent   = order.frete || 'Incluso'; }
    if (obsEl)     { obsEl.textContent     = order.observacoes || '';                                  this.applyHighlight(obsEl, g.observacoes); }

    const tbody = tbodyEl || document.getElementById('print-items-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      const items = (order.items || []).filter(Boolean);
      const rows = items.length > 0 ? items : [{}];

      rows.forEach((item) => {
        const tr = document.createElement('tr');
        const hasData = item && (item.qtde || item.prod || item.modelo || item.dimensao || item.posicao || item.base);
        tr.innerHTML = hasData
          ? `
            <td class="col-qtde">${item.qtde || ''}</td>
            <td class="col-prod">${item.prod || ''}</td>
            <td class="col-modelo">${item.modelo || ''}</td>
            <td class="col-dimensao">${item.dimensao || ''}</td>
            <td class="col-posicao">${item.posicao || ''}</td>
            <td class="col-base">${item.base || ''}</td>
          `
          : `
            <td class="col-qtde">&nbsp;</td>
            <td class="col-prod">&nbsp;</td>
            <td class="col-modelo">&nbsp;</td>
            <td class="col-dimensao">&nbsp;</td>
            <td class="col-posicao">&nbsp;</td>
            <td class="col-base">&nbsp;</td>
          `;

        // Aplica destaque nas células de itens
        this.applyHighlightCell(tr.querySelector('.col-qtde'),    g.qtde);
        this.applyHighlightCell(tr.querySelector('.col-modelo'),   g.modelo);
        this.applyHighlightCell(tr.querySelector('.col-dimensao'), g.dimensao);
        this.applyHighlightCell(tr.querySelector('.col-posicao'),  g.posicao);
        this.applyHighlightCell(tr.querySelector('.col-base'),     g.base);

        tbody.appendChild(tr);
      });
    }

    const photoImg = document.getElementById('print-photo-img');
    const photoPlaceholder = document.getElementById('print-photo-placeholder');
    if (photoImg && photoPlaceholder) {
      if (order.photo_filename) {
        photoImg.src = `/uploads/${order.photo_filename}?t=${Date.now()}`;
        photoImg.style.display = 'block';
        photoPlaceholder.style.display = 'none';
      } else {
        photoImg.src = '';
        photoImg.style.display = 'none';
        photoPlaceholder.style.display = 'flex';
      }
    }
  },

  openPreview(order) {
    this.renderOrderToSheet(order);
    document.getElementById('modal-print-preview').classList.add('active');
  },

  printNow() {
    window.print();
  },

  waitForImages(root) {
    const imgs = Array.from(root.querySelectorAll('img'));
    return Promise.all(imgs.map((img) => {
      if (!img.src || img.src.endsWith('/')) return Promise.resolve();
      if (img.complete && img.naturalWidth) return Promise.resolve();
      return new Promise((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
    }));
  },

  async loadOrder(orderId) {
    const res = await fetch(`/api/orders/${orderId}`);
    const data = await res.json();
    if (!data.success || !data.order) throw new Error('O.S. não encontrada');
    return data.order;
  },

  async downloadPdf(orderId) {
    const id = orderId || (this.currentOrder && this.currentOrder.id);
    if (!id) return;

    try {
      const order = await this.loadOrder(id);
      this.renderOrderToSheet(order);
      await this.exportSheetToPdf(order);
    } catch (e) {
      console.error(e);
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('Erro ao gerar PDF: ' + e.message, 'error');
      }
    }
  },

  async exportSheetToPdf(order) {
    const sheet = document.getElementById('os-print-sheet');
    if (!sheet || typeof html2canvas === 'undefined' || !window.jspdf) {
      window.open(`/api/orders/${order.id}/pdf`, '_blank');
      return;
    }

    const modal = document.getElementById('modal-print-preview');
    const wasOpen = modal?.classList.contains('active');
    if (modal && !wasOpen) modal.classList.add('active');

    await this.waitForImages(sheet);
    await new Promise((r) => setTimeout(r, 120));

    const canvas = await html2canvas(sheet, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false
    });

    if (modal && !wasOpen) modal.classList.remove('active');

    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    pdf.addImage(imgData, 'JPEG', 0, 0, 210, 297);
    const safeName = String(order.orcamento_numero || order.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    pdf.save(`OS_${safeName}.pdf`);
  },

  async printSelected(ids) {
    if (!ids || ids.length === 0) return;
    if (ids.length === 1) {
      const order = await this.loadOrder(ids[0]);
      this.openPreview(order);
      setTimeout(() => this.printNow(), 250);
      return;
    }

    const batch = document.getElementById('print-batch-root');
    if (!batch) return;
    batch.innerHTML = '';
    const template = document.getElementById('os-print-sheet');

    for (const id of ids) {
      const order = await this.loadOrder(id);
      const clone = template.cloneNode(true);
      clone.id = '';
      clone.classList.add('os-a4-sheet-batch');
      const cloneTbody = clone.querySelector('tbody');
      this.fillClonedSheet(clone, order, cloneTbody);
      batch.appendChild(clone);
    }

    document.body.classList.add('printing-batch');
    await this.waitForImages(batch);
    window.print();
    document.body.classList.remove('printing-batch');
    batch.innerHTML = '';
  },

  fillClonedSheet(root, order, tbodyEl) {
    const g = this.getGrifar();

    const setHL = (sel, val, active) => {
      const el = root.querySelector(sel);
      if (!el) return;
      el.textContent = val;
      this.applyHighlight(el, active);
    };

    setHL('#print-data',         order.data_os || new Date().toLocaleDateString('pt-BR'), g.data);
    setHL('#print-orcamento',    order.orcamento_numero || '----/--',                     g.orcamento);
    setHL('#print-nome-fantasia',(order.nome_fantasia || 'NÃO INFORMADO').toUpperCase(),  false);
    setHL('#print-entrega',      order.data_entrega || '--/--/----',                      g.entrega);
    setHL('#print-forma-pgto',   order.forma_pagamento || 'PIX',                          false);
    setHL('#print-prazo-pgto',   order.prazo_pagamento || 'À Vista',                      false);
    setHL('#print-frete',        order.frete || 'Incluso',                                false);
    setHL('#print-observacoes',  order.observacoes || '',                                 g.observacoes);

    if (tbodyEl) {
      tbodyEl.innerHTML = '';
      const items = (order.items || []).filter(Boolean);
      const rows = items.length > 0 ? items : [{}];
      rows.forEach((item) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="col-qtde">${item.qtde || ''}</td>
          <td class="col-prod">${item.prod || ''}</td>
          <td class="col-modelo">${item.modelo || ''}</td>
          <td class="col-dimensao">${item.dimensao || ''}</td>
          <td class="col-posicao">${item.posicao || ''}</td>
          <td class="col-base">${item.base || ''}</td>
        `;
        this.applyHighlightCell(tr.querySelector('.col-qtde'),    g.qtde);
        this.applyHighlightCell(tr.querySelector('.col-modelo'),   g.modelo);
        this.applyHighlightCell(tr.querySelector('.col-dimensao'), g.dimensao);
        this.applyHighlightCell(tr.querySelector('.col-posicao'),  g.posicao);
        this.applyHighlightCell(tr.querySelector('.col-base'),     g.base);
        tbodyEl.appendChild(tr);
      });
    }

    const photoImg = root.querySelector('#print-photo-img');
    const photoPlaceholder = root.querySelector('#print-photo-placeholder');
    if (photoImg && photoPlaceholder) {
      photoImg.removeAttribute('id');
      photoPlaceholder.removeAttribute('id');
      if (order.photo_filename) {
        photoImg.src = `/uploads/${order.photo_filename}?t=${Date.now()}`;
        photoImg.style.display = 'block';
        photoPlaceholder.style.display = 'none';
      } else {
        photoImg.src = '';
        photoImg.style.display = 'none';
        photoPlaceholder.style.display = 'flex';
      }
    }
  }
};

document.getElementById('btn-trigger-print')?.addEventListener('click', () => PrintManager.printNow());
document.getElementById('btn-trigger-print-bottom')?.addEventListener('click', () => PrintManager.printNow());
document.getElementById('btn-download-pdf')?.addEventListener('click', () => PrintManager.downloadPdf());
