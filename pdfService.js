const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 28;
const CONTENT_W = PAGE_W - MARGIN * 2;

const BLACK = rgb(0, 0, 0);
const ORANGE = rgb(0.85, 0.45, 0.0);
const YELLOW = rgb(1.0, 1.0, 0.0);
const GRAY_BG = rgb(0.97, 0.98, 0.99);

function truncate(text, maxLen) {
  if (!text) return '';
  const s = String(text);
  return s.length > maxLen ? s.substring(0, maxLen - 2) + '..' : s;
}

async function generateServiceOrderPdf(orderId) {
  const order = db.getOrderById(orderId);
  if (!order) throw new Error('Ordem de Servico nao encontrada');

  const defaultHighlights = {
    data: db.getSetting('grifar_data', 'true') === 'true',
    orcamento: db.getSetting('grifar_orcamento', 'true') === 'true',
    qtde: db.getSetting('grifar_qtde', 'true') === 'true',
    dimensao: db.getSetting('grifar_dimensao', 'true') === 'true',
    posicao: db.getSetting('grifar_posicao', 'true') === 'true',
    modelo: db.getSetting('grifar_modelo', 'false') === 'true',
    base: db.getSetting('grifar_base', 'false') === 'true',
    entrega: db.getSetting('grifar_entrega', 'false') === 'true',
    observacoes: db.getSetting('grifar_observacoes', 'false') === 'true'
  };

  let H = { ...defaultHighlights };
  if (order.highlight_fields) {
    try {
      const customList = typeof order.highlight_fields === 'string'
        ? JSON.parse(order.highlight_fields) : order.highlight_fields;
      if (Array.isArray(customList)) {
        Object.keys(H).forEach(k => { H[k] = customList.includes(k); });
      }
    } catch (e) { }
  }

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  let curY = PAGE_H;

  // CABECALHO
  const headerPath = path.join(__dirname, 'public', 'assets', 'header_banner.jpg');
  let headerHeight = 70;
  if (fs.existsSync(headerPath)) {
    try {
      const hImg = await pdfDoc.embedJpg(fs.readFileSync(headerPath));
      const hDims = hImg.scaleToFit(PAGE_W, 100);
      page.drawImage(hImg, { x: 0, y: PAGE_H - hDims.height, width: PAGE_W, height: hDims.height });
      headerHeight = hDims.height;
    } catch (e) { console.error('Header error:', e.message); }
  }
  // Data e Orcamento uma linha abaixo de onde estavam (deslocado para baixo)
  curY = PAGE_H - headerHeight - 24;

  // RODAPE (fixo no bottom)
  const footerPath = path.join(__dirname, 'public', 'assets', 'footer_info.jpg');
  let footerHeight = 90;
  if (fs.existsSync(footerPath)) {
    try {
      const fImg = await pdfDoc.embedJpg(fs.readFileSync(footerPath));
      const fDims = fImg.scaleToFit(PAGE_W, 110);
      footerHeight = fDims.height;
      page.drawImage(fImg, { x: 0, y: 0, width: PAGE_W, height: fDims.height });
    } catch (e) { console.error('Footer error:', e.message); }
  }
  const bottomLimit = footerHeight + 8;

  // DATA e ORCAMENTO
  const dataLabel = 'DATA: ';
  const dataVal = order.data_os || '';
  const dataLabelW = fontBold.widthOfTextAtSize(dataLabel, 11);
  const dataValW = fontBold.widthOfTextAtSize(dataVal, 11);
  page.drawText(dataLabel, { x: MARGIN, y: curY, size: 11, font: fontBold, color: BLACK });
  if (H.data && dataVal) {
    page.drawRectangle({ x: MARGIN + dataLabelW - 2, y: curY - 3, width: dataValW + 6, height: 14, color: YELLOW });
  }
  page.drawText(dataVal, { x: MARGIN + dataLabelW, y: curY, size: 11, font: fontBold, color: BLACK });

  const orcLabel = 'ORCAMENTO No ';
  const orcVal = order.orcamento_numero || '';
  const orcLabelW = fontBold.widthOfTextAtSize(orcLabel, 11);
  const orcValW = fontBold.widthOfTextAtSize(orcVal, 12.5);
  const orcX = PAGE_W - MARGIN - orcLabelW - orcValW - 4;
  page.drawText(orcLabel, { x: orcX, y: curY, size: 11, font: fontBold, color: BLACK });
  if (H.orcamento && orcVal) {
    page.drawRectangle({ x: orcX + orcLabelW - 2, y: curY - 3, width: orcValW + 6, height: 14, color: YELLOW });
    page.drawText(orcVal, { x: orcX + orcLabelW, y: curY, size: 12.5, font: fontBold, color: BLACK });
  } else {
    page.drawText(orcVal, { x: orcX + orcLabelW, y: curY, size: 12.5, font: fontBold, color: ORANGE });
  }
  curY -= 25;

  // NOME FANTASIA
  const clientBoxH = 18;
  page.drawRectangle({ x: MARGIN, y: curY - clientBoxH + 4, width: CONTENT_W, height: clientBoxH, borderColor: BLACK, borderWidth: 0.5 });
  const nfLabel = 'NOME FANTASIA: ';
  const nfVal = (order.nome_fantasia || 'NAO INFORMADO').toUpperCase();
  const nfLabelW = fontBold.widthOfTextAtSize(nfLabel, 10);
  page.drawText(nfLabel, { x: MARGIN + 4, y: curY - 9, size: 10, font: fontBold, color: BLACK });
  page.drawText(truncate(nfVal, 55), { x: MARGIN + 4 + nfLabelW, y: curY - 9, size: 11, font: fontBold, color: BLACK });
  curY -= clientBoxH + 5;

  // TABELA DE PRODUTOS
  const items = order.items || [];
  const numRows = Math.max(items.length, 1);
  const colWidths = { qtde: CONTENT_W * 0.10, prod: CONTENT_W * 0.22, modelo: CONTENT_W * 0.18, dimensao: CONTENT_W * 0.20, posicao: CONTENT_W * 0.15, base: CONTENT_W * 0.15 };
  const colHdrs = ['QTDE.', 'PROD.', 'MODELO', 'DIMENSAO', 'POSICAO', 'BASE'];
  const colKeys = ['qtde', 'prod', 'modelo', 'dimensao', 'posicao', 'base'];
  const rowH = 16, hdrRowH = 16;

  let colX = MARGIN;
  page.drawRectangle({ x: MARGIN, y: curY - hdrRowH + 4, width: CONTENT_W, height: hdrRowH, color: GRAY_BG, borderColor: BLACK, borderWidth: 0.5 });
  colKeys.forEach((key, i) => {
    if (i > 0) page.drawLine({ start: { x: colX, y: curY - hdrRowH + 4 }, end: { x: colX, y: curY + 4 }, thickness: 0.5, color: BLACK });
    const tw = fontBold.widthOfTextAtSize(colHdrs[i], 9);
    page.drawText(colHdrs[i], { x: colX + (colWidths[key] - tw) / 2, y: curY - 9, size: 9, font: fontBold, color: BLACK });
    colX += colWidths[key];
  });
  page.drawLine({ start: { x: MARGIN + CONTENT_W, y: curY - hdrRowH + 4 }, end: { x: MARGIN + CONTENT_W, y: curY + 4 }, thickness: 0.5, color: BLACK });
  curY -= hdrRowH;

  for (let i = 0; i < numRows; i++) {
    const item = items[i] || {};
    colX = MARGIN;
    page.drawRectangle({ x: MARGIN, y: curY - rowH + 4, width: CONTENT_W, height: rowH, borderColor: BLACK, borderWidth: 0.5 });
    const cells = [
      { key: 'qtde', val: item.qtde || '', hl: H.qtde, ml: 8 },
      { key: 'prod', val: item.prod || '', hl: false, ml: 20 },
      { key: 'modelo', val: item.modelo || '', hl: H.modelo, ml: 18 },
      { key: 'dimensao', val: item.dimensao || '', hl: H.dimensao, ml: 18 },
      { key: 'posicao', val: item.posicao || '', hl: H.posicao, ml: 16 },
      { key: 'base', val: item.base || '', hl: H.base, ml: 18 }
    ];
    cells.forEach((cell, ci) => {
      if (ci > 0) page.drawLine({ start: { x: colX, y: curY - rowH + 4 }, end: { x: colX, y: curY + 4 }, thickness: 0.5, color: BLACK });
      const dv = truncate(cell.val, cell.ml);
      if (dv) {
        const tw = fontBold.widthOfTextAtSize(dv, 8.5);
        const cw = colWidths[cell.key];
        const tx = colX + (cw - tw) / 2;
        if (cell.hl) { const hw = Math.min(tw + 6, cw - 2); page.drawRectangle({ x: colX + (cw - hw) / 2, y: curY - 9, width: hw, height: 12, color: YELLOW }); }
        page.drawText(dv, { x: tx, y: curY - 8, size: 8.5, font: fontBold, color: BLACK });
      }
      colX += colWidths[cell.key];
    });
    page.drawLine({ start: { x: MARGIN + CONTENT_W, y: curY - rowH + 4 }, end: { x: MARGIN + CONTENT_W, y: curY + 4 }, thickness: 0.5, color: BLACK });
    curY -= rowH;
  }
  curY -= 6;

  // CONDICOES (Grupo DATA DA ENTREGA)
  const condBoxH = 18;
  page.drawRectangle({ x: MARGIN, y: curY - condBoxH + 4, width: CONTENT_W, height: condBoxH, borderColor: BLACK, borderWidth: 0.5 });
  const conds = [
    { label: 'DATA DA ENTREGA: ', val: order.data_entrega || '--/--/----', hl: H.entrega },
    { label: 'FORMA DE PGTO: ', val: order.forma_pagamento || '', hl: false },
    { label: 'PRAZO DE PGTO: ', val: order.prazo_pagamento || '', hl: false }
  ];
  const csW = CONTENT_W / 3;
  conds.forEach((cond, i) => {
    const cx = MARGIN + csW * i + 4;
    if (i > 0) page.drawLine({ start: { x: MARGIN + csW * i, y: curY - condBoxH + 4 }, end: { x: MARGIN + csW * i, y: curY + 4 }, thickness: 0.5, color: BLACK });
    const lw = fontBold.widthOfTextAtSize(cond.label, 8.5);
    page.drawText(cond.label, { x: cx, y: curY - 9, size: 8.5, font: fontBold, color: BLACK });
    if (cond.hl && cond.val) { const vw = fontBold.widthOfTextAtSize(cond.val, 8.5); page.drawRectangle({ x: cx + lw - 1, y: curY - 10, width: vw + 4, height: 12, color: YELLOW }); }
    page.drawText(truncate(cond.val, 20), { x: cx + lw, y: curY - 9, size: 8.5, font: fontBold, color: BLACK });
  });
  curY -= condBoxH + 4;

  // INFORMAÇÕES ADICIONAIS (Logo abaixo do grupo DATA DA ENTREGA)
  const obsText = order.observacoes ? String(order.observacoes).trim() : '';
  const obsBoxH = 18;
  page.drawRectangle({ x: MARGIN, y: curY - obsBoxH + 4, width: CONTENT_W, height: obsBoxH, borderColor: BLACK, borderWidth: 0.5 });
  const obsLabel = 'INFORMAÇÕES ADICIONAIS: ';
  const obsLabelW = fontBold.widthOfTextAtSize(obsLabel, 8.5);
  page.drawText(obsLabel, { x: MARGIN + 4, y: curY - 9, size: 8.5, font: fontBold, color: BLACK });
  if (obsText) {
    const truncatedObs = truncate(obsText, 80);
    const obsValW = fontBold.widthOfTextAtSize(truncatedObs, 8.5);
    if (H.observacoes) {
      page.drawRectangle({ x: MARGIN + 4 + obsLabelW - 1, y: curY - 10, width: Math.min(obsValW + 4, CONTENT_W - obsLabelW - 8), height: 12, color: YELLOW });
    }
    page.drawText(truncatedObs, { x: MARGIN + 4 + obsLabelW, y: curY - 9, size: 8.5, font: fontBold, color: BLACK });
  }
  curY -= obsBoxH + 4;

  // FRETE
  const freteLabel = 'FRETE: ';
  const freteLabelW = fontBold.widthOfTextAtSize(freteLabel, 9.5);
  page.drawText(freteLabel, { x: MARGIN, y: curY, size: 9.5, font: fontBold, color: BLACK });
  page.drawText(truncate(order.frete || '', 40), { x: MARGIN + freteLabelW, y: curY, size: 9.5, font: fontRegular, color: BLACK });
  curY -= 10;

  // FOTO
  const photoAreaH = curY - bottomLimit;
  if (order.photo_filename && photoAreaH > 20) {
    const photoPath = path.join(__dirname, 'uploads', order.photo_filename);
    if (fs.existsSync(photoPath)) {
      try {
        const photoBytes = fs.readFileSync(photoPath);
        let embImg = null;

        // Detect type by magic bytes (first 4 bytes)
        const isPng = photoBytes[0] === 0x89 && photoBytes[1] === 0x50 && photoBytes[2] === 0x4E && photoBytes[3] === 0x47;
        const isJpg = photoBytes[0] === 0xFF && photoBytes[1] === 0xD8;

        if (isPng) {
          try { embImg = await pdfDoc.embedPng(photoBytes); } catch (e) {
            console.error('embedPng falhou:', e.message);
            try { embImg = await pdfDoc.embedJpg(photoBytes); } catch (e2) { console.error('embedJpg fallback falhou:', e2.message); }
          }
        } else if (isJpg) {
          try { embImg = await pdfDoc.embedJpg(photoBytes); } catch (e) {
            console.error('embedJpg falhou:', e.message);
            try { embImg = await pdfDoc.embedPng(photoBytes); } catch (e2) { console.error('embedPng fallback falhou:', e2.message); }
          }
        } else {
          // Unknown format: try JPG first, then PNG
          console.warn('Formato de imagem desconhecido (magic bytes:', photoBytes[0], photoBytes[1], ') — tentando JPG/PNG...');
          try { embImg = await pdfDoc.embedJpg(photoBytes); } catch (e) {
            try { embImg = await pdfDoc.embedPng(photoBytes); } catch (e2) { console.error('Nenhum formato de embed funcionou para a foto:', e2.message); }
          }
        }

        if (embImg) {
          const dims = embImg.scaleToFit(CONTENT_W, photoAreaH);
          page.drawImage(embImg, {
            x: MARGIN + (CONTENT_W - dims.width) / 2,
            y: bottomLimit + (photoAreaH - dims.height) / 2,
            width: dims.width, height: dims.height
          });
          console.log(`Foto embedada com sucesso: ${order.photo_filename} (${dims.width.toFixed(0)}x${dims.height.toFixed(0)})`);
        } else {
          console.warn('Foto não pôde ser embedada no PDF:', order.photo_filename);
        }
      } catch (err) { console.error('Photo error:', err.message); }
    } else { console.warn('Foto não encontrada no servidor:', photoPath); }
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { generateServiceOrderPdf };
