// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/tableRender.mjs
import fs from 'fs';
import { createCanvas } from 'canvas';

/**
 * tableRows: массив строк таблицы
 *   [
 *     ['ПК', 'Админ', 'Стат', 'ВзС', 'ВрУ'],
 *     ['№013', 'Berser', 'н/н', '15.11', '11:50'],
 *     ...
 *   ]
 *
 * options:
 *   - outPath: куда сохранить PNG
 */
export function renderTableToPng(tableRows, { outPath = '/tmp/sql_table.png' } = {}) {
  if (!tableRows || !tableRows.length) {
    throw new Error('Нет данных для рендера таблицы');
  }

  const rows = tableRows;
  const colCount = rows[0].length;

  // логические размеры (до масштабирования)
  const paddingX = 10;
  const rowHeight = 26;
  const charWidth = 7; // грубая оценка ширины символа

  // считаем ширину колонок по максимальной длине текста
  const colWidths = new Array(colCount).fill(0);
  rows.forEach(row => {
    row.forEach((cell, idx) => {
      const text = cell == null ? '' : String(cell);
      const w = text.length * charWidth + paddingX * 2;
      if (w > colWidths[idx]) {
        colWidths[idx] = w;
      }
    });
  });

  // 🔧 минимальные ширины по колонкам (ПК, Админ, Стат, ВзС, ВрУ)
  const minWidths = [50, 70, 50, 50, 50];
  for (let i = 0; i < colCount; i++) {
    const minW = minWidths[i] ?? 0;
    if (colWidths[i] < minW) {
      colWidths[i] = minW;
    }
  }

  const totalWidth = colWidths.reduce((a, b) => a + b, 0) + 1;
  const totalHeight = rows.length * rowHeight + 1;

  // рисуем в x2 масштабе для чёткости
  const scale = 2;
  const canvas = createCanvas(totalWidth * scale, totalHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // фон
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalWidth, totalHeight);

  ctx.textBaseline = 'middle';
  ctx.font = '16px Arial';
  ctx.antialias = 'subpixel';

  let y = 0;
  rows.forEach((row, rowIdx) => {
    let x = 0;
    const isHeader = rowIdx === 0;
    const isOddRow = rowIdx % 2 === 1;

    // фон строки
    const rowBg = isHeader ? '#d0d0d0' : (isOddRow ? '#e2f0ff' : '#ffffff');
    ctx.fillStyle = rowBg;
    ctx.fillRect(0, y, totalWidth, rowHeight);

    row.forEach((cell, colIdx) => {
      const text = cell == null ? '' : String(cell);

      // рамка
      ctx.strokeStyle = '#a0a0a0';
      ctx.strokeRect(x, y, colWidths[colIdx], rowHeight);

      // цвет текста
      let textColor = '#111111';
      if (!isHeader && colIdx === 2 && text.trim() === 'нет') {
        textColor = '#cc0000'; // красный для "нет"
      }

      ctx.fillStyle = textColor;
      const textX = x + paddingX;
      const textY = y + rowHeight / 2;
      ctx.fillText(text, textX, textY);

      x += colWidths[colIdx];
    });

    y += rowHeight;
  });

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, buffer);
  return outPath;
}
