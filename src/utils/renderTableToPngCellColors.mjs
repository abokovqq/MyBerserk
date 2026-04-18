import sharp from 'sharp';

/* ===================== FIXED LAYOUT CONSTANTS ===================== */

const FONT_FAMILY = 'Inter, Arial, sans-serif';
const FONT_SIZE = 12;

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 26;

const CELL_PADDING_X = 12;

const BORDER_RADIUS = 14;
const OUTER_PADDING = 16;
const BORDER_WIDTH = 1;

// БЫЛО: 2
// СТАЛО: 3 (выше чёткость, больше размер файла)
const SCALE = 3;

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

function approxTextWidthPx(text, fontSize) {
  return Math.ceil(String(text).length * fontSize * 0.58);
}

function normalizeColor(c, fallback = '#ffffff') {
  const s = String(c || '').trim();
  return s || fallback;
}

/**
 * @param {string[][]} table 2D array: first row = header, next rows = body
 * @param {object} opts
 * @param {number[]} opts.colWidthsFixed if provided -> use exact widths for all columns
 * @param {string[][]} opts.cellBgColors body-only matrix [bodyRow][col]
 * @param {object|null} opts.legend optional { dayColor, nightColor, labels?:{title,day,night} }
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function renderTableToPngCellColors(table, opts = {}) {
  const {
    outPath,
    colMinWidths = [],
    colWidthsFixed = null,
    cellBgColors = [],

    legend = null,

    headerBg = '#F3F4F6',
    gridColor = '#E5E7EB',
    textColor = '#111827',
    headerTextColor = '#111827',
  } = opts;

  if (!Array.isArray(table) || table.length < 2) {
    throw new Error('renderTableToPngCellColors: table должен содержать header и хотя бы 1 строку');
  }

  const header = table[0];
  const body = table.slice(1);
  const cols = header.length;

  // --- ширины колонок ---
  let colWidths;

  if (Array.isArray(colWidthsFixed) && colWidthsFixed.length === cols) {
    colWidths = colWidthsFixed.map(x => Math.max(40, Number(x || 0)));
  } else {
    colWidths = Array.from({ length: cols }).map((_, i) => Math.max(70, Number(colMinWidths[i] || 0)));

    const allRows = [header, ...body];
    for (let c = 0; c < cols; c++) {
      let maxW = colWidths[c];
      for (const r of allRows) {
        const w = approxTextWidthPx(r[c] ?? '', FONT_SIZE) + CELL_PADDING_X * 2;
        if (w > maxW) maxW = w;
      }
      colWidths[c] = maxW;
    }
  }

  const headerH = HEADER_HEIGHT;

  const rowHeights = body.map(() => ROW_HEIGHT);
  const bodyH = rowHeights.reduce((a, b) => a + b, 0);

  const legendH = legend ? ROW_HEIGHT : 0;

  const tableW = colWidths.reduce((a, b) => a + b, 0);
  const tableH = headerH + bodyH + legendH;

  const x0 = OUTER_PADDING;
  const y0 = OUTER_PADDING;
  const W = tableW + OUTER_PADDING * 2;
  const H = tableH + OUTER_PADDING * 2;

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

  svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`;

  // card
  svg += `<rect x="${x0}" y="${y0}" width="${tableW}" height="${tableH}"
            rx="${BORDER_RADIUS}" ry="${BORDER_RADIUS}"
            fill="#ffffff" stroke="${gridColor}" stroke-width="${BORDER_WIDTH}"
            filter="url(#shadow)"/>`;

  // header bg
  svg += `<rect x="${x0}" y="${y0}" width="${tableW}" height="${headerH}"
            rx="${BORDER_RADIUS}" ry="${BORDER_RADIUS}"
            fill="${headerBg}" stroke="none"/>`;
  svg += `<rect x="${x0}" y="${y0 + headerH - BORDER_RADIUS}" width="${tableW}" height="${BORDER_RADIUS}"
            fill="${headerBg}" stroke="none"/>`;

  // header texts + vertical lines
  let cx = x0;
  for (let c = 0; c < cols; c++) {
    const w = colWidths[c];
    const tx = cx + CELL_PADDING_X;
    const ty = y0 + headerH / 2 + FONT_SIZE / 2 - BASELINE_TWEAK;
    svg += `<text class="hdr" x="${tx}" y="${ty}">${esc(header[c])}</text>`;

    if (c < cols - 1) {
      svg += `<line x1="${cx + w}" y1="${y0}" x2="${cx + w}" y2="${y0 + tableH}"
                    stroke="${gridColor}" stroke-width="${BORDER_WIDTH}"/>`;
    }

    cx += w;
  }

  // line under header
  svg += `<line x1="${x0}" y1="${y0 + headerH}" x2="${x0 + tableW}" y2="${y0 + headerH}"
                stroke="${gridColor}" stroke-width="${BORDER_WIDTH}"/>`;

  // body rows
  let ry = y0 + headerH;

  for (let r = 0; r < body.length; r++) {
    const rh = rowHeights[r];

    let x = x0;
    for (let c = 0; c < cols; c++) {
      const w = colWidths[c];
      const bg = normalizeColor(cellBgColors?.[r]?.[c], '#ffffff');

      svg += `<rect x="${x}" y="${ry}" width="${w}" height="${rh}" fill="${bg}" stroke="none"/>`;

      const isLast = (c === cols - 1);
      const baseX = isLast ? (x + w - CELL_PADDING_X) : (x + CELL_PADDING_X);
      const align = isLast ? 'end' : 'start';
      const ty = ry + rh / 2 + FONT_SIZE / 2 - BASELINE_TWEAK;

      svg += `<text class="txt" x="${baseX}" y="${ty}" text-anchor="${align}">${esc(body[r][c])}</text>`;

      x += w;
    }

    svg += `<line x1="${x0}" y1="${ry + rh}" x2="${x0 + tableW}" y2="${ry + rh}"
                  stroke="${gridColor}" stroke-width="${BORDER_WIDTH}"/>`;

    ry += rh;
  }

  // legend row
  if (legend) {
    const rh = ROW_HEIGHT;
    const title = legend.labels?.title ?? 'Легенда:';
    const dayLabel = legend.labels?.day ?? 'Д';
    const nightLabel = legend.labels?.night ?? 'Н';

    const dayColor = legend.dayColor || '#FFEB3B';
    const nightColor = legend.nightColor || '#BDBDBD';

    svg += `<rect x="${x0}" y="${ry}" width="${tableW}" height="${rh}" fill="#ffffff" stroke="none"/>`;

    const ty = ry + rh / 2 + FONT_SIZE / 2 - BASELINE_TWEAK;
    svg += `<text class="hdr" x="${x0 + CELL_PADDING_X}" y="${ty}">${esc(title)}</text>`;

    const sq = 16;
    const gap = 10;
    let lx = x0 + CELL_PADDING_X + approxTextWidthPx(title, FONT_SIZE) + 14;

    svg += `<rect x="${lx}" y="${ry + (rh - sq) / 2}" width="${sq}" height="${sq}" rx="4" ry="4" fill="${dayColor}" stroke="${gridColor}" stroke-width="1"/>`;
    svg += `<text class="hdr" x="${lx + sq + 6}" y="${ty}">${esc(dayLabel)}</text>`;
    lx += sq + 6 + approxTextWidthPx(dayLabel, FONT_SIZE) + gap;

    svg += `<rect x="${lx}" y="${ry + (rh - sq) / 2}" width="${sq}" height="${sq}" rx="4" ry="4" fill="${nightColor}" stroke="${gridColor}" stroke-width="1"/>`;
    svg += `<text class="hdr" x="${lx + sq + 6}" y="${ty}">${esc(nightLabel)}</text>`;

    svg += `<line x1="${x0}" y1="${ry + rh}" x2="${x0 + tableW}" y2="${ry + rh}"
                  stroke="${gridColor}" stroke-width="${BORDER_WIDTH}"/>`;
  }

  svg += `</svg>`;

  const svgBuf = Buffer.from(svg, 'utf8');

  // Важное: повышаем density и делаем png без “мыла”
  const density = 96 * SCALE;

  const pngBuf = await sharp(svgBuf, { density })
    .png({ compressionLevel: 9, effort: 10 })
    .toBuffer();

  if (outPath) {
    await sharp(pngBuf).png().toFile(outPath);
  }

  return pngBuf;
}
