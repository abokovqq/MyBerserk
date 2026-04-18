// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/inventoryDiffReport.mjs
// Формирование листа "Расхождение" + PNG + управление INVENT_CLEAR_ON_START

import '../env.js';
import { google } from 'googleapis';
import fs from 'node:fs';
import { createCanvas } from 'canvas';

const TZ = process.env.TZ || 'Europe/Moscow';
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SRC_SHEET =
  (process.env.GOOGLE_SHEETS_SHEET_NAME ||
    process.env.GOOGLE_SHEETS_DATA_SHEET ||
    'Data').replace(/"/g, '');
const DIFF_SHEET =
  (process.env.GOOGLE_SHEETS_DIFF_SHEET_NAME || 'Расхождение').replace(
    /"/g,
    ''
  );

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ENV_FILE = '/home/a/abokovsa/berserkclub.ru/MyBerserk/.env';

// ----- аргументы CLI -----
const argv = process.argv.slice(2);
function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  if (!found) return def;
  return found.substring(pref.length);
}

const CHAT_ID = getArg('chatId', null);

// ----- time helpers -----
function nowTZ() {
  return new Date(
    new Date().toLocaleString('en-US', {
      timeZone: TZ,
    })
  );
}
function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

// ----- работа с .env: установка INVENT_CLEAR_ON_START -----
function setInventClearOnStart(value) {
  const KEY = 'INVENT_CLEAR_ON_START';
  const vStr = String(value);

  try {
    if (!fs.existsSync(ENV_FILE)) {
      console.log('setInventClearOnStart: .env not found:', ENV_FILE);
      return;
    }
    const orig = fs.readFileSync(ENV_FILE, 'utf8');
    const lines = orig.split(/\r?\n/);
    let changed = false;

    const updated = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed.startsWith(KEY + '=')) return line;

      const hashPos = line.indexOf('#');
      let comment = '';
      if (hashPos !== -1) {
        comment = line.substring(hashPos);
      }
      changed = true;
      return KEY + '=' + vStr + (comment ? ' ' + comment : '');
    });

    if (!changed) {
      console.log('setInventClearOnStart: key not found, nothing to change');
      return;
    }

    fs.writeFileSync(ENV_FILE, updated.join('\n'));
    console.log(`setInventClearOnStart: ${KEY} set to ${vStr} in .env`);
  } catch (e) {
    console.error('setInventClearOnStart: failed to update .env', e);
  }
}

// ----- sendPhoto (локально) -----
async function sendPhoto(chatId, filePath, caption = '') {
  if (!TELEGRAM_TOKEN) {
    console.error('sendPhoto: TELEGRAM_BOT_TOKEN не задан в .env');
    return;
  }
  if (!chatId) {
    console.error('sendPhoto: chatId пустой');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;

  const fileData = await fs.promises.readFile(filePath);
  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  if (caption) formData.append('caption', caption);
  formData.append('photo', new Blob([fileData]), 'inventory_diff.png');

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  let json;
  try {
    json = await res.json();
  } catch (e) {
    console.error('sendPhoto: не удалось распарсить ответ Telegram', e);
    return;
  }

  if (!json.ok) {
    console.error('sendPhoto: ошибка Telegram', json);
  } else {
    console.log('sendPhoto: отправлено успешно, message_id=', json.result?.message_id);
  }
}

// ----- Google Sheets client -----
async function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;

  if (!clientEmail || !rawKey) {
    throw new Error(
      'Нет GOOGLE_SHEETS_CLIENT_EMAIL или GOOGLE_SHEETS_PRIVATE_KEY в .env'
    );
  }

  const privateKey = rawKey.replace(/\\n/g, '\n');

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  await auth.getClient();
  console.log('GoogleAuth client for diff report obtained OK');

  return google.sheets({ version: 'v4', auth });
}

// ----- sheetId по имени -----
async function getSheetId(sheets, title) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });

  const sheet = (meta.data.sheets || []).find(
    s => s.properties && s.properties.title === title
  );

  if (!sheet || !sheet.properties || sheet.properties.sheetId == null) {
    throw new Error(`Не найден лист "${title}" в таблице`);
  }

  return sheet.properties.sheetId;
}

// ----- очистка листа Расхождение с 3-й строки -----
async function clearDiffSheetFromRow3(sheets) {
  const sheetId = await getSheetId(sheets, DIFF_SHEET);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 2,
              startColumnIndex: 0,
            },
            cell: {},
            fields: 'userEnteredValue,userEnteredFormat',
          },
        },
      ],
    },
  });

  console.log(
    `Diff sheet "${DIFF_SHEET}": очищены значения и форматирование с 3-й строки и ниже`
  );
}

// ----- читаем Data и берём только строки с расхождением -----
async function loadDataSheet(sheets) {
  const range = `${SRC_SHEET}!A1:F10000`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values || [];

  if (rows.length <= 1) {
    console.log('Data sheet: no data (only header or empty)');
    return [];
  }

  const dataRows = rows.slice(1);
  const items = [];

  for (const row of dataRows) {
    const group = row[0] || '';
    const name = row[1] || '';
    const evotor = Number(row[2] ?? 0);
    const invent = Number(row[3] ?? 0);
    const price = Number(row[5] ?? 0);

    if (!group && !name && !evotor && !invent && !price) continue;

    const diff = invent - evotor;
    if (diff !== 0) {
      items.push({ group, name, evotor, invent, diff, price });
    }
  }

  console.log('Diff items count =', items.length);
  return items;
}

// ----- рендер PNG -----
async function renderDiffPng(title, items, totalSum, totalSum20, quarter, outPath) {
  const rows = [];

  rows.push([title, '', '', '', '', '', '', '']);
  rows.push([
    'Группа',
    'Наименование',
    'Эвотор',
    'Инвент',
    'Расхожд',
    'Цена',
    'Сумма',
    '',
  ]);

  for (const it of items) {
    const sum = it.diff * it.price;
    rows.push([
      it.group,
      it.name,
      String(it.evotor),
      String(it.invent),
      String(it.diff),
      String(it.price),
      String(sum),
      '',
    ]);
  }

  rows.push(['', '', '', '', '', '', '', '']);
  rows.push(['', '', '', '', '', 'Сумма', String(totalSum), '']);
  rows.push([
    '',
    '',
    '',
    '',
    '',
    'Сумма - 20%',
    String(totalSum20),
    String(quarter),
  ]);

  const colWidths = [130, 260, 70, 70, 80, 80, 100, 80];
  const leftPadding = 20;
  const topPadding = 20;
  const rowHeight = 28;

  const totalWidth =
    leftPadding * 2 + colWidths.reduce((a, b) => a + b, 0);
  const totalHeight = topPadding * 2 + rows.length * rowHeight + 10;

  const canvas = createCanvas(totalWidth, totalHeight);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalWidth, totalHeight);

  ctx.textBaseline = 'middle';
  ctx.font = '14px sans-serif';

  let y = topPadding;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const isTitleRow = r === 0;
    const isHeaderRow = r === 1;

    if (isTitleRow) {
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(leftPadding, y, totalWidth - leftPadding * 2, rowHeight);
    } else if (isHeaderRow) {
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(leftPadding, y, totalWidth - leftPadding * 2, rowHeight);
    }

    let x = leftPadding + 4;

    for (let c = 0; c < colWidths.length; c++) {
      const cell = row[c] != null ? String(row[c]) : '';

      ctx.fillStyle = '#000000';

      if (isTitleRow) {
        if (c === 0) {
          ctx.font = 'bold 16px sans-serif';
          ctx.fillText(cell, x, y + rowHeight / 2);
          ctx.font = '14px sans-serif';
        }
      } else {
        const isNumericCol = c >= 2;
        const textWidth = ctx.measureText(cell).width;
        const colWidth = colWidths[c];

        let tx = x;
        if (isNumericCol) {
          tx = x + colWidth - textWidth - 6;
        }

        ctx.fillText(cell, tx, y + rowHeight / 2);
      }

      x += colWidths[c];
    }

    ctx.strokeStyle = '#cccccc';
    ctx.beginPath();
    ctx.moveTo(leftPadding, y + rowHeight);
    ctx.lineTo(totalWidth - leftPadding, y + rowHeight);
    ctx.stroke();

    y += rowHeight;
  }

  let vx = leftPadding;
  ctx.strokeStyle = '#cccccc';
  for (let c = 0; c <= colWidths.length; c++) {
    ctx.beginPath();
    ctx.moveTo(vx, topPadding);
    ctx.lineTo(vx, y);
    ctx.stroke();
    if (c < colWidths.length) vx += colWidths[c];
  }

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    const stream = canvas.createPNGStream();
    stream.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });

  console.log('Diff PNG saved to', outPath);
}

// ----- формирование листа Расхождение + PNG + флаг -----
async function buildDiffSheet() {
  if (!SPREADSHEET_ID) {
    throw new Error('Нет GOOGLE_SHEETS_SPREADSHEET_ID в .env');
  }

  const sheets = await getSheetsClient();
  const items = await loadDataSheet(sheets);
  const today = formatDate(nowTZ());
  const title = `ИТОГИ ИНВЕНТАРИЗАЦИИ ${today}`;

  await clearDiffSheetFromRow3(sheets);

  const totalSum = items.reduce(
    (acc, it) => acc + it.diff * it.price,
    0
  );
  const totalSum20 = totalSum * 0.8;
  const quarter = totalSum20 / 4;

  const values = [];

  values.push([title, '', '', '', '', '', '', '']);
  values.push([
    'Группа',
    'Наименование',
    'Эвотор',
    'Инвент',
    'Расхожд',
    'Цена',
    'Сумма',
    '',
  ]);

  const firstDataRow = 3;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const rowNum = firstDataRow + i;
    values.push([
      it.group,
      it.name,
      it.evotor,
      it.invent,
      it.diff,
      it.price,
      `=E${rowNum}*F${rowNum}`,
      '',
    ]);
  }

  values.push(['', '', '', '', '', '', '', '']);
  const blankRowSheet = firstDataRow + items.length;

  const sumRowSheet = blankRowSheet + 1;
  let sumFormula = '=0';
  if (items.length > 0) {
    sumFormula = `=SUM(G${firstDataRow}:G${blankRowSheet - 1})`;
  }
  values.push(['', '', '', '', '', 'Сумма', sumFormula, '']);

  const sum20RowSheet = sumRowSheet + 1;
  const sum20Formula = `=G${sumRowSheet}*0,8`;
  const diff20Formula = `=G${sum20RowSheet}/4`;
  values.push(['', '', '', '', '', 'Сумма - 20%', sum20Formula, diff20Formula]);

  const totalRows = values.length;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${DIFF_SHEET}!A1:H${totalRows}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });

  console.log('inventoryDiffReport: sheet updated, rows =', totalRows);

  const tmpDir = '/home/a/abokovsa/berserkclub.ru/MyBerserk/tmp';
  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  } catch (e) {
    console.error('Не удалось создать tmp каталог:', e);
  }

  const pngPath = `${tmpDir}/inventory_diff_${Date.now()}.png`;

  await renderDiffPng(
    title,
    items,
    Math.round(totalSum),
    Math.round(totalSum20),
    Math.round(quarter),
    pngPath
  );

  if (CHAT_ID) {
    await sendPhoto(CHAT_ID, pngPath, title);
    console.log('inventoryDiffReport: PNG sent to Telegram chat', CHAT_ID);
  } else {
    console.log('CHAT_ID не передан, картинку в Telegram не отправляем');
  }

  // После завершения инвентаризации разрешаем новое обновление Data
  setInventClearOnStart(1);
}

// ----- запуск -----
buildDiffSheet()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('inventoryDiffReport: error', err);
    process.exit(1);
  });
