// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/utils/tableRenderColorRows.mjs
// PNG рендер таблицы без Chromium: генерим SVG и конвертим в PNG через sharp.
//
// ВАЖНО: ширина колонок передаётся из вызывающего кода через opts.colMinWidths,
// а всё, что касается шрифта/высоты строк — ЗДЕСЬ ЖЁСТКО ФИКСИРОВАНО константами.

import sharp from 'sharp';

/* ===================== FIXED LAYOUT CONSTANTS ===================== */

// шрифт (фикс)
const FONT_FAMILY = 'Inter, Arial, sans-serif';
const FONT_SIZE = 12;

// высоты (фикс)
const ROW_HEIGHT = 20;      // высота каждой строки тела
const HEADER_HEIGHT = 24;   // высота заголовка таблицы

// отступы (фикс)
const CELL_PADDING_X = 14;

// визуальный стиль (фикс)
const BORDER_RADIUS = 14;
const OUTER_PADDING = 16;
const BORDER_WIDTH = 1;
const SCALE = 2; // retina

// тонкая настройка baseline (фикс)
const BASELINE_TWEAK = 2;

/* ================================================================ */

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toLines(cell) {
  const s = String(cell ?? '');
  return s.split('\n');
}

function approxTextWidthPx(text, fontSize) {
  // стабильная оценка ширины без метрик шрифта (лат/кир)
  return Math.ceil(String(text).length * fontSize * 0.58);
}

export async function renderTableToPngColorRows(table, opts = {}) {
  const {
    outPath,
    colMinWidths = [],
    rowBgColors = [],

    // цвета (можно переопределять при желании)
    headerBg = '#F3F4F6',
    gridColor = '#E5E7EB',
    textColor = '#111827',
    headerTextColor = '#111827',
  } = opts;

  if (!outPath) throw new Error('renderTableToPngColorRows: outPath required');
  if (!Array.isArray(table) || table.length < 2) {
    throw new Error('renderTableToPngColorRows: table должен содержать header и хотя бы 1 строку');
  }

  const header = table[0];
  const body = table.slice(1);
  const cols = header.length;

  // --- расчёт ширин колонок ---
  // База: colMinWidths (фиксируем минималку), затем подстраиваемся по ширине текста
  const colWidths = Array.from({ length: cols }).map((_, i) => Math.max(80, Number(colMinWidths[i] || 0)));

  const allRows = [header, ...body];
  for (let c = 0; c < cols; c++) {
    let maxW = colWidths[c];
    for (const r of allRows) {
      const lines = toLines(r[c]);
      for (const line of lines) {
        const w = approxTextWidthPx(line, FONT_SIZE) + CELL_PADDING_X * 2;
        if (w > maxW) maxW = w;
      }
    }
    colWidths[c] = maxW;
  }

  const tableW = colWidths.reduce((a, b) => a + b, 0);
  const headerH = HEADER_HEIGHT;

  // фиксированная высота строк
  const rowHeights = body.map(() => ROW_HEIGHT);
  const bodyH = rowHeights.reduce((a, b) => a + b, 0);
  const tableH = headerH + bodyH;

  // внешние размеры
  const x0 = OUTER_PADDING;
  const y0 = OUTER_PADDING;
  const W = tableW + OUTER_PADDING * 2;
  const H = tableH + OUTER_PADDING * 2;

  // --- SVG сборка ---
  let svg = '';
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;

  svg += `<defs>
    <style>
      .txt{ font-family:${esc(FONT_FAMILY)}; font-size:${FONT_SIZE}px; fill:${textColor}; }
      .hdr{ font-family:${esc(FONT_FAMILY)}; font-size:${FONT_SIZE}px; font-weight:700; fill:${headerTextColor}; }
    </style>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="rgba(17,24,39,0.10)"/>
    </filter>
  </defs>`;

  // фон
  svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`;

  // card
  svg += `<rect x="${x0}" y="${y0}" width="${tableW}" height="${tableH}"
            rx="${BORDER_RADIUS}" ry="${BORDER_RADIUS}"
            fill="#ffffff" stroke="${gridColor}" stroke-width="${BORDER_WIDTH}"
            filter="url(#shadow)"/>`;

  // header bg (с верхним радиусом)
  svg += `<rect x="${x0}" y="${y0}" width="${tableW}" height="${headerH}"
            rx="${BORDER_RADIUS}" ry="${BORDER_RADIUS}"
            fill="${headerBg}" stroke="none"/>`;

  // убираем нижнее закругление у header-полосы
  svg += `<rect x="${x0}" y="${y0 + headerH - BORDER_RADIUS}" width="${tableW}" height="${BORDER_RADIUS}"
            fill="${headerBg}" stroke="none"/>`;

  // вертикальные линии + header text
  let cx = x0;
  for (let c = 0; c < cols; c++) {
    const w = colWidths[c];

    // header text (вертикально по центру)
    const tx = cx + CELL_PADDING_X;
    const ty = y0 + headerH / 2 + FONT_SIZE / 2 - BASELINE_TWEAK;
    svg += `<text class="hdr" x="${tx}" y="${ty}">${esc(header[c])}</text>`;

    // вертикальная линия (кроме последней)
    if (c < cols - 1) {
      svg += `<line x1="${cx + w}" y1="${y0}" x2="${cx + w}" y2="${y0 + tableH}"
                    stroke="${gridColor}" stroke-width="${BORDER_WIDTH}"/>`;
    }

    cx += w;
  }

  // горизонтальная линия под header
  svg += `<line x1="${x0}" y1="${y0 + headerH}" x2="${x0 + tableW}" y2="${y0 + headerH}"
                stroke="${gridColor}" stroke-width="${BORDER_WIDTH}"/>`;

  // body rows
  let ry = y0 + headerH;

  for (let r = 0; r < body.length; r++) {
    const rh = rowHeights[r];
    const bg = rowBgColors[r] || '#ffffff';

    // фон строки
    svg += `<rect x="${x0}" y="${ry}" width="${tableW}" height="${rh}" fill="${bg}" stroke="none"/>`;

    // ячейки текста
    let x = x0;
    for (let c = 0; c < cols; c++) {
      const cell = body[r][c];
      const lines = toLines(cell);

      const isLast = (c === cols - 1); // обычно "остаток" справа
      const baseX = isLast ? (x + colWidths[c] - CELL_PADDING_X) : (x + CELL_PADDING_X);
      const align = isLast ? 'end' : 'start';

      // ФИКС высоты строки: если строк несколько — они могут выйти за пределы.
      // В твоих отчётах это ок, потому что wrapName уже подрезает/переносит разумно.
      // Если надо — сделаем обрезку до 1 строки с "…".
      for (let li = 0; li < lines.length; li++) {
        const tx = baseX;
        // центрируем первую строку по вертикали, остальные идут ниже
        const ty0 = ry + rh / 2 + FONT_SIZE / 2 - BASELINE_TWEAK;
        const ty = ty0 + li * (FONT_SIZE + 4);
        svg += `<text class="txt" x="${tx}" y="${ty}" text-anchor="${align}">${esc(lines[li])}</text>`;
      }

      x += colWidths[c];
    }

    // линия снизу строки
    svg += `<line x1="${x0}" y1="${ry + rh}" x2="${x0 + tableW}" y2="${ry + rh}"
                  stroke="${gridColor}" stroke-width="${BORDER_WIDTH}"/>`;

    ry += rh;
  }

  svg += `</svg>`;

  // --- SVG -> PNG ---
  const buf = Buffer.from(svg, 'utf8');
  await sharp(buf, { density: 72 * SCALE }).png().toFile(outPath);
}
