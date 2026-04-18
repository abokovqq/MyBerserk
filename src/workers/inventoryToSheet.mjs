// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/inventoryToSheet.mjs
// Обновление листа Data из Evotor + управление флагом INVENT_CLEAR_ON_START

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

// ----- Telegram sendMessage (локальная реализация) -----
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

// ----- Google Sheets client -----
async function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;

  console.log('Google client_email =', clientEmail || '<undefined>');
  if (!clientEmail || !rawKey) {
    throw new Error(
      'Нет GOOGLE_SHEETS_CLIENT_EMAIL или GOOGLE_SHEETS_PRIVATE_KEY в .env'
    );
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

  // чистим старые данные (только строки с 2-й)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${DATA_SHEET}!A2:F10000`,
  });

  const values = [];

  // заголовок
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

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${DATA_SHEET}!A1:F${totalRows}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });

  console.log('inventoryToSheet: products =', products.length);
  console.log('inventoryToSheet: done, rows =', totalRows - 1);
}

// ----- main -----
async function run() {
  const flag = String(process.env.INVENT_CLEAR_ON_START || '0').trim();
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

  const sheets = await getSheetsClient();
  const products = await loadProductsFromDb();
  await updateDataSheet(sheets, products);

  // после успешного обновления запрещаем повторное до конца инвентаризации
  setInventClearOnStart(0);
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('inventoryToSheet: error', err);
    process.exit(1);
  });
