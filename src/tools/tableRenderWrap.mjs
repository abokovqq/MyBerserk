// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/tableRenderWrap.mjs
import fs from 'fs';
import { createCanvas } from 'canvas';

/**
 * renderTableToPngWrap(tableRows, options)
 *
 * options:
 *   - outPath
 *   - colMinWidths: массив мин. ширин колонок
 *   - totalsRowIndex: индекс строки, которую выделить как итоговую
 */
export function renderTableToPngWrap(
  tableRows,
  {
    outPath = '/tmp/sql_table_wrap.png',
    colMinWidths = [],
    totalsRowIndex = null,
  } = {}
) {
  if (!tableRows || !tableRows.length) {
    throw new Error('Нет данных для рендера таблицы');
  }

  const rows = tableRows;
  const colCount = rows[0].length;

  // базовые параметры
  const paddingX = 10;
  const baseRowHeight = 26;
  const charWidth = 7;

  // ---------- ширина колонок ----------
  const colWidths = new Array(colCount).fill(0);

  rows.forEach(row => {
    row.forEach((cell, idx) => {
      const text = cell == null ? '' : String(cell);
      const lines = text.split('\n');
      const maxLineLen = Math.max(...lines.map(l => l.length));
      const w = maxLineLen * charWidth + paddingX * 2;
      if (w > colWidths[idx]) colWidths[idx] = w;
    });
  });

  for (let i = 0; i < colCount; i++) {
    const minW = colMinWidths[i] || 0;
    if (colWidths[i] < minW) colWidths[i] = minW;
  }

  const totalWidth = colWidths.reduce((a, b) => a + b, 0) + 1;

  // ---------- высоты строк ----------
  const rowHeights = [];
  const rowTops = [];
  let currentY = 0;

  rows.forEach(row => {
    const maxLines = row.reduce((m, cell) => {
      const lines = String(cell || '').split('\n').length;
      return Math.max(m, lines);
    }, 1);

    const rowHeight = baseRowHeight * maxLines;
    rowHeights.push(rowHeight);
    rowTops.push(currentY);
    currentY += rowHeight;
  });

  const totalHeight = currentY + 1;

  // canvas x2
  const scale = 2;
  const canvas = createCanvas(totalWidth * scale, totalHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalWidth, totalHeight);

  ctx.textBaseline = 'middle';
  ctx.antialias = 'subpixel';

  // ---------- рисуем строки ----------
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const y = rowTops[rowIdx];
    const h = rowHeights[rowIdx];

    const isHeader = rowIdx === 0;
    const isTotals = totalsRowIndex === rowIdx;

    let bg;
    if (isHeader) bg = '#d0d0d0';
    else if (isTotals) bg = '#e0e0e0';
    else bg = rowIdx % 2 ? '#e2f0ff' : '#ffffff';

    ctx.fillStyle = bg;
    ctx.fillRect(0, y, totalWidth, h);

    let x = 0;

    for (let colIdx = 0; colIdx < colCount; colIdx++) {
      const cell = String(row[colIdx] || '');
      const lines = cell.split('\n');
      const cellWidth = colWidths[colIdx];

      // рамка
      ctx.strokeStyle = '#a0a0a0';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, cellWidth, h);

      ctx.font = (isHeader || isTotals ? 'bold ' : '') + '16px Arial';
      ctx.fillStyle = '#111';

      const lineHeight = baseRowHeight;

      lines.forEach((line, i) => {
        const textY = y + lineHeight * (i + 0.5);
        ctx.fillText(line, x + paddingX, textY);
      });

      x += cellWidth;
    }
  }

  // ---------- жирная линия над итогом ----------
  if (
    totalsRowIndex !== null &&
    totalsRowIndex > 0 &&
    totalsRowIndex < rows.length
  ) {
    const yTop = rowTops[totalsRowIndex];
    ctx.beginPath();
    ctx.moveTo(0, yTop);
    ctx.lineTo(totalWidth, yTop);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, buf);
  return outPath;
}
