// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/inventoryToSheet.mjs
// Обновление листа Data из Evotor + очистка листа "Расхождение" + управление флагом INVENT_CLEAR_ON_START

import '../env.js';
import { q } from '../db.js';
import { google } from 'googleapis';
import fs from 'node:fs';

const TZ = process.env.TZ || 'Europe/Moscow';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const DATA_SHEET =
  (process.env.GOOGLE_SHEETS_DATA_SHEET ||
    process.env.GOOGLE_SHEETS_SHEET_NAME ||
    'Data').replace(/"/g, '');

const DIFF_SHEET =
  (process.env.GOOGLE_SHEETS_DIFF_SHEET_NAME || 'Расхождение').replace(/"/g, '');

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

// ----- Telegram sendMessage -----
async function sendMessage(chatId, text) {
  if (!TELEGRAM_TOKEN) {
    console.error('sendMessage: TELEGRAM_BOT_TOKEN не задан в .env');
    return;
  }

  if (!chatId) {
    console.error('sendMessage: chatId пустой');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append('text', text);

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  let json;
  try {
    json = await res.json();
  } catch (e) {
    console.error('sendMessage: не удалось распарсить ответ Telegram', e);
    return;
  }

  if (!json.ok) {
    console.error('sendMessage: ошибка Telegram', json);
  } else {
    console.log('sendMessage: отправлено, message_id=', json.result?.message_id);
  }
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
      const match = line.match(/^(\s*INVENT_CLEAR_ON_START\s*=\s*)([^#\r\n]*)(.*)$/);

      if (!match) {
        return line;
      }

      changed = true;

      const prefix = match[1];
      const tail = match[3] || '';

      return `${prefix}${vStr}${tail}`;
    });

    if (!changed) {
      updated.push(`${KEY}=${vStr}`);
      console.log('setInventClearOnStart: key not found, added');
    }

    fs.writeFileSync(ENV_FILE, updated.join('\n'));
    console.log(`setInventClearOnStart: ${KEY} set to ${vStr} in .env`);
  } catch (e) {
    console.error('setInventClearOnStart: failed to update .env', e);
  }
}

// ----- Google Sheets helpers -----
function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

async function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;

  console.log('Google client_email =', clientEmail || '<undefined>');

  if (!clientEmail || !rawKey) {
    throw new Error('Нет GOOGLE_SHEETS_CLIENT_EMAIL или GOOGLE_SHEETS_PRIVATE_KEY в .env');
  }

  const privateKey = rawKey.replace(/\\n/g, '\n');

  console.log('Google private_key length =', privateKey.length);
  console.log(
    'Google private_key starts with =',
    privateKey.slice(0, 30).split('\n')[0]
  );

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  await auth.getClient();
  console.log('GoogleAuth client obtained OK');

  return google.sheets({ version: 'v4', auth });
}

async function getSheetInfo(sheets, sheetNameToFind) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
  });

  const sheetsList = res.data.sheets || [];

  let found = sheetsList.find(
    s => s.properties?.title === sheetNameToFind
  );

  if (!found) {
    found = sheetsList.find(
      s => String(s.properties?.title || '').toLowerCase() === String(sheetNameToFind).toLowerCase()
    );

    if (found) {
      console.log(
        `getSheetInfo: лист "${sheetNameToFind}" найден как "${found.properties.title}" без учёта регистра`
      );
    }
  }

  if (!found) {
    const titles = sheetsList
      .map(s => s.properties?.title)
      .filter(Boolean)
      .join(', ');

    throw new Error(`Лист "${sheetNameToFind}" не найден в таблице. Доступные листы: ${titles}`);
  }

  return {
    sheetId: found.properties.sheetId,
    title: found.properties.title,
    rowCount: found.properties.gridProperties?.rowCount || 1,
    columnCount: found.properties.gridProperties?.columnCount || 1,
  };
}

async function ensureSheetSize(sheets, sheetInfo, requiredRows, requiredCols) {
  const newRowCount = Math.max(sheetInfo.rowCount, requiredRows);
  const newColCount = Math.max(sheetInfo.columnCount, requiredCols);

  if (
    newRowCount === sheetInfo.rowCount &&
    newColCount === sheetInfo.columnCount
  ) {
    console.log(
      `ensureSheetSize: resize не нужен, rows=${sheetInfo.rowCount}, cols=${sheetInfo.columnCount}`
    );
    return;
  }

  console.log(
    `ensureSheetSize: resize листа "${sheetInfo.title}" rows ${sheetInfo.rowCount} -> ${newRowCount}, cols ${sheetInfo.columnCount} -> ${newColCount}`
  );

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: sheetInfo.sheetId,
              gridProperties: {
                rowCount: newRowCount,
                columnCount: newColCount,
              },
            },
            fields: 'gridProperties.rowCount,gridProperties.columnCount',
          },
        },
      ],
    },
  });
}

// ----- Загрузка продуктов из БД Evotor -----
async function loadProductsFromDb() {
  const sql = `
    SELECT
      p.name,
      p.quantity,
      p.price,
      g.name AS group_name
    FROM evotor_products p
    LEFT JOIN evotor_product_groups g
      ON p.parent_id = g.group_id
    WHERE p.type = 'NORMAL'
      AND p.allow_to_sell = 1
    ORDER BY g.name, p.name
  `;

  const rows = await q(sql);

  return rows.map(r => ({
    group: r.group_name || '',
    name: r.name || '',
    qty: Number(r.quantity ?? 0),
    price: Number(r.price ?? 0),
  }));
}

// ----- Обновление листа Data -----
async function updateDataSheet(sheets, products) {
  if (!SPREADSHEET_ID) {
    throw new Error('Нет GOOGLE_SHEETS_SPREADSHEET_ID в .env');
  }

  if (!products.length) {
    throw new Error('В базе не найдено ни одного товара. Лист Data не очищаю.');
  }

  const sheetInfo = await getSheetInfo(sheets, DATA_SHEET);

  console.log(`inventoryToSheet: actual Data sheet title = ${sheetInfo.title}`);

  const values = [];

  values.push(['Группа', 'Наименование', 'Эвотор', 'Инвент', 'Расхожд', 'Цена']);

  const firstRow = 2;

  products.forEach((p, idx) => {
    const rowNum = firstRow + idx;
    const diffFormula = `=D${rowNum}-C${rowNum}`;

    values.push([
      p.group,
      p.name,
      p.qty,
      0,
      diffFormula,
      p.price,
    ]);
  });

  const totalRows = values.length;
  const requiredRows = Math.max(totalRows, 2);
  const requiredCols = 6;

  await ensureSheetSize(sheets, sheetInfo, requiredRows, requiredCols);

  const clearLastRow = Math.max(sheetInfo.rowCount, totalRows, 2);
  const sheetName = quoteSheetName(sheetInfo.title);

  console.log(`inventoryToSheet: Data clear range = ${sheetName}!A2:F${clearLastRow}`);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A2:F${clearLastRow}`,
    requestBody: {},
  });

  console.log(`inventoryToSheet: Data update range = ${sheetName}!A1:F${totalRows}`);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1:F${totalRows}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values,
    },
  });

  console.log('inventoryToSheet: products =', products.length);
  console.log('inventoryToSheet: Data done, rows =', totalRows - 1);
}

// ----- Очистка листа Расхождение при старте новой инвентаризации -----
async function clearDiffSheet(sheets) {
  if (!SPREADSHEET_ID) {
    throw new Error('Нет GOOGLE_SHEETS_SPREADSHEET_ID в .env');
  }

  const sheetInfo = await getSheetInfo(sheets, DIFF_SHEET);
  const sheetName = quoteSheetName(sheetInfo.title);

  const clearLastRow = Math.max(sheetInfo.rowCount, 1);
  const clearLastCol = 'H';

  console.log(`inventoryToSheet: actual Diff sheet title = ${sheetInfo.title}`);
  console.log(`inventoryToSheet: Diff clear range = ${sheetName}!A1:${clearLastCol}${clearLastRow}`);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1:${clearLastCol}${clearLastRow}`,
    requestBody: {},
  });

  console.log(`inventoryToSheet: Diff sheet "${sheetInfo.title}" cleared`);
}

// ----- main -----
async function run() {
  const flag = String(process.env.INVENT_CLEAR_ON_START || '0').trim();

  console.log('inventoryToSheet: TZ =', TZ);
  console.log('inventoryToSheet: DATA_SHEET from env =', DATA_SHEET);
  console.log('inventoryToSheet: DIFF_SHEET from env =', DIFF_SHEET);
  console.log('inventoryToSheet: INVENT_CLEAR_ON_START =', flag);

  if (flag !== '1') {
    console.log('inventoryToSheet: flag != 1, Evotor sync skipped');

    if (CHAT_ID) {
      await sendMessage(
        CHAT_ID,
        'Идёт инвентаризация. Повторное обновление данных возможно только после окончания инвентаризации.'
      );
    }

    return;
  }

  const products = await loadProductsFromDb();
  console.log('inventoryToSheet: products loaded from DB =', products.length);

  const sheets = await getSheetsClient();

  await updateDataSheet(sheets, products);

  await clearDiffSheet(sheets);

  // Только после успешной записи Data и очистки Расхождения запрещаем повторное обновление
  setInventClearOnStart(0);
}

run()
  .then(() => process.exit(0))
  .catch(async err => {
    console.error('inventoryToSheet: error', err);

    if (CHAT_ID) {
      try {
        await sendMessage(
          CHAT_ID,
          'Ошибка обновления таблицы инвентаризации. Подробности в логе.'
        );
      } catch (e) {
        console.error('inventoryToSheet: не удалось отправить сообщение об ошибке', e);
      }
    }

    process.exit(1);
  });