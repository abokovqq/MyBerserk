// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/inventoryDiffReport.mjs
// Формирование листа "Расхождение" + PNG + робустная отправка в Telegram + управление INVENT_CLEAR_ON_START

import '../env.js';
import { google } from 'googleapis';
import fs from 'node:fs';
import { createCanvas } from 'canvas';

const PROJECT_ROOT = '/home/a/abokovsa/berserkclub.ru/MyBerserk';
const ENV_FILE = `${PROJECT_ROOT}/.env`;
const TMP_DIR = `${PROJECT_ROOT}/tmp`;
const LOCK_FILE = `${TMP_DIR}/inventoryDiffReport.lock`;

const TZ = process.env.TZ || 'Europe/Moscow';
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const SRC_SHEET =
  (process.env.GOOGLE_SHEETS_SHEET_NAME ||
    process.env.GOOGLE_SHEETS_DATA_SHEET ||
    'Data').replace(/"/g, '');

const DIFF_SHEET =
  (process.env.GOOGLE_SHEETS_DIFF_SHEET_NAME || 'Расхождение').replace(/"/g, '');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const GOOGLE_TIMEOUT_MS = 90000;
const TELEGRAM_TIMEOUT_MS = 120000;
const GOOGLE_ATTEMPTS = 4;
const TELEGRAM_ATTEMPTS = 4;


const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  if (!found) return def;
  return found.substring(pref.length);
}

const CHAT_ID = getArg('chatId', null);

function stamp() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: TZ,
    hour12: false,
  });
}

function log(...args) {
  console.log(`[${stamp()}]`, ...args);
}

function errlog(...args) {
  console.error(`[${stamp()}]`, ...args);
}

process.on('unhandledRejection', err => {
  errlog('UNHANDLED_REJECTION:', err?.stack || err?.message || err);
});

process.on('uncaughtException', err => {
  errlog('UNCAUGHT_EXCEPTION:', err?.stack || err?.message || err);
  process.exit(1);
});

process.on('SIGHUP', () => {
  errlog('SIGHUP received and ignored');
});

process.on('SIGTERM', () => {
  errlog('SIGTERM received');
  process.exit(143);
});

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function parseNumber(value) {
  if (value == null || value === '') return 0;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const s = String(value)
    .replace(/\s+/g, '')
    .replace(',', '.')
    .trim();

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function shortRaw(raw, limit = 1000) {
  return String(raw ?? '').substring(0, limit);
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(err) {
  const msg = String(err?.message || err || '').toLowerCase();

  return (
    err?.name === 'AbortError' ||
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('socket') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('eai_again') ||
    msg.includes('network')
  );
}

async function fetchTextRetry(label, attempts, timeoutMs, makeOptions) {
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      log(`${label}: attempt ${attempt}/${attempts}`);

      const options = await makeOptions();
      const res = await fetch(options.url, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });

      const raw = await res.text();

      if (!res.ok) {
        const e = new Error(`${label}: HTTP ${res.status}, body=${shortRaw(raw)}`);
        e.httpStatus = res.status;
        e.raw = raw;

        if (attempt < attempts && isRetryableHttpStatus(res.status)) {
          lastErr = e;
          errlog(`${label}: retryable HTTP error on attempt ${attempt}:`, e.message);
          await sleep(1500 * attempt);
          continue;
        }

        throw e;
      }

      return raw;
    } catch (e) {
      lastErr = e;

      if (attempt < attempts && isRetryableError(e)) {
        errlog(`${label}: retryable error on attempt ${attempt}:`, e?.message || e);
        await sleep(1500 * attempt);
        continue;
      }

      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || new Error(`${label}: failed`);
}

async function fetchJsonRetry(label, attempts, timeoutMs, makeOptions) {
  const raw = await fetchTextRetry(label, attempts, timeoutMs, makeOptions);

  try {
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    throw new Error(`${label}: bad json, body=${shortRaw(raw)}`);
  }
}

function parseLock(raw) {
  const s = String(raw ?? '').trim();

  if (!s) {
    return {
      pid: null,
      startedAtMs: null,
      raw: '',
    };
  }

  try {
    const json = JSON.parse(s);
    const pid = Number.parseInt(json?.pid, 10);
    const startedAtMs = json?.startedAt ? Date.parse(json.startedAt) : null;

    return {
      pid: pid > 0 ? pid : null,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
      raw: s,
    };
  } catch {
    const pid = Number.parseInt(s, 10);

    return {
      pid: pid > 0 ? pid : null,
      startedAtMs: null,
      raw: s,
    };
  }
}

function isPidAlive(pid) {
  if (!(pid > 0)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  ensureTmpDir();

  if (fs.existsSync(LOCK_FILE)) {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const lock = parseLock(raw);

    if (lock.pid && isPidAlive(lock.pid)) {
      const e = new Error(`inventoryDiffReport already running, pid=${lock.pid}`);
      e.code = 'ALREADY_RUNNING';
      throw e;
    }

    log(`stale lock removed: ${LOCK_FILE}, oldPid=${lock.raw || raw.trim() || '-'}`);
    fs.unlinkSync(LOCK_FILE);
  }

  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  log(`lock acquired: ${LOCK_FILE}, pid=${process.pid}`);
}

function releaseLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;

    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const lock = parseLock(raw);

    if (lock.pid === process.pid) {
      fs.unlinkSync(LOCK_FILE);
      log(`lock released: ${LOCK_FILE}`);
    }
  } catch (e) {
    errlog('releaseLock: failed', e);
  }
}

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

function setInventClearOnStart(value) {
  const KEY = 'INVENT_CLEAR_ON_START';
  const vStr = String(value);

  try {
    if (!fs.existsSync(ENV_FILE)) {
      log('setInventClearOnStart: .env not found:', ENV_FILE);
      return false;
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
      log('setInventClearOnStart: key not found, added');
    }

    fs.writeFileSync(ENV_FILE, updated.join('\n'));

    log(`setInventClearOnStart: ${KEY} set to ${vStr} in .env`);
    return true;
  } catch (e) {
    errlog('setInventClearOnStart: failed to update .env', e);
    return false;
  }
}

async function getGoogleAuthClient() {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;

  log('getGoogleAuthClient: start');

  if (!clientEmail || !rawKey) {
    throw new Error('Нет GOOGLE_SHEETS_CLIENT_EMAIL или GOOGLE_SHEETS_PRIVATE_KEY в .env');
  }

  const privateKey = rawKey.replace(/\\n/g, '\n');

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  let lastErr = null;

  for (let attempt = 1; attempt <= GOOGLE_ATTEMPTS; attempt++) {
    try {
      log(`getGoogleAuthClient: auth.getClient attempt ${attempt}/${GOOGLE_ATTEMPTS}`);

      const authClient = await Promise.race([
        auth.getClient(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`GoogleAuth getClient timeout ${GOOGLE_TIMEOUT_MS}ms`)), GOOGLE_TIMEOUT_MS);
        }),
      ]);

      log('GoogleAuth client for diff report obtained OK');

      return authClient;
    } catch (e) {
      lastErr = e;
      errlog('getGoogleAuthClient: error:', e?.message || e);

      if (attempt < GOOGLE_ATTEMPTS) {
        await sleep(1500 * attempt);
      }
    }
  }

  throw lastErr || new Error('GoogleAuth getClient failed');
}

async function getAccessToken(authClient) {
  let lastErr = null;

  for (let attempt = 1; attempt <= GOOGLE_ATTEMPTS; attempt++) {
    try {
      log(`getAccessToken: attempt ${attempt}/${GOOGLE_ATTEMPTS}`);

      const tokenResp = await Promise.race([
        authClient.getAccessToken(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`GoogleAuth getAccessToken timeout ${GOOGLE_TIMEOUT_MS}ms`)), GOOGLE_TIMEOUT_MS);
        }),
      ]);

      const token =
        typeof tokenResp === 'string'
          ? tokenResp
          : tokenResp?.token;

      if (!token) {
        throw new Error('Не удалось получить Google access token');
      }

      return token;
    } catch (e) {
      lastErr = e;
      errlog('getAccessToken: error:', e?.message || e);

      if (attempt < GOOGLE_ATTEMPTS) {
        await sleep(1500 * attempt);
      }
    }
  }

  throw lastErr || new Error('getAccessToken failed');
}

async function googleFetchJson(authClient, label, method, url, bodyObj = null) {
  const token = await getAccessToken(authClient);

  return fetchJsonRetry(label, GOOGLE_ATTEMPTS, GOOGLE_TIMEOUT_MS, async () => ({
    url,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: bodyObj == null ? undefined : JSON.stringify(bodyObj),
  }));
}

async function getActualSheetTitle(authClient, requestedTitle) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}`
    + `?fields=sheets(properties(title))`;

  const json = await googleFetchJson(
    authClient,
    `Google Sheets metadata ${requestedTitle}`,
    'GET',
    url
  );

  const sheetsList = json?.sheets || [];

  let found = sheetsList.find(s => s?.properties?.title === requestedTitle);

  if (!found) {
    found = sheetsList.find(
      s => String(s?.properties?.title || '').toLowerCase() === String(requestedTitle).toLowerCase()
    );

    if (found) {
      log(`getActualSheetTitle: лист "${requestedTitle}" найден как "${found.properties.title}" без учёта регистра`);
    }
  }

  if (!found) {
    const titles = sheetsList
      .map(s => s?.properties?.title)
      .filter(Boolean)
      .join(', ');

    throw new Error(`Лист "${requestedTitle}" не найден. Доступные листы: ${titles}`);
  }

  return found.properties.title;
}

async function loadDataSheet(authClient, actualSrcSheet) {
  const range = `${quoteSheetName(actualSrcSheet)}!A1:F10000`;
  const encodedRange = encodeURIComponent(range);

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}`
    + `/values/${encodedRange}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`;

  log(`loadDataSheet: читаю диапазон ${range}...`);

  const json = await googleFetchJson(
    authClient,
    `Google Sheets values.get ${range}`,
    'GET',
    url
  );

  const rows = json?.values || [];

  log(`loadDataSheet: получено строк = ${rows.length}`);

  if (rows.length <= 1) {
    log('Data sheet: no data');
    return [];
  }

  const dataRows = rows.slice(1);
  const items = [];

  for (const row of dataRows) {
    const group = row[0] || '';
    const name = row[1] || '';
    const evotor = parseNumber(row[2]);
    const invent = parseNumber(row[3]);
    const price = parseNumber(row[5]);

    if (!group && !name && !evotor && !invent && !price) continue;

    const diff = round2(invent - evotor);

    if (diff !== 0) {
      items.push({
        group,
        name,
        evotor,
        invent,
        diff,
        price,
        sum: round2(diff * price),
      });
    }
  }

  log('Diff items count =', items.length);

  return items;
}

async function googleSheetsValuesUpdateRaw(authClient, range, values) {
  const encodedRange = encodeURIComponent(range);

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}`
    + `/values/${encodedRange}?valueInputOption=RAW`;

  const json = await googleFetchJson(
    authClient,
    `Google Sheets values.update ${range}`,
    'PUT',
    url,
    { values }
  );

  log(
    'googleSheetsValuesUpdateRaw: OK',
    `updatedRange=${json?.updatedRange || '-'}`,
    `updatedRows=${json?.updatedRows ?? '-'}`,
    `updatedCells=${json?.updatedCells ?? '-'}`
  );

  return json;
}

async function sendMessage(chatId, text) {
  if (!TELEGRAM_TOKEN) {
    errlog('sendMessage: TELEGRAM_BOT_TOKEN не задан в .env');
    return false;
  }

  if (!chatId) {
    errlog('sendMessage: chatId пустой');
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  try {
    const raw = await fetchTextRetry(
      'Telegram sendMessage',
      TELEGRAM_ATTEMPTS,
      TELEGRAM_TIMEOUT_MS,
      async () => {
        const body = new URLSearchParams();
        body.append('chat_id', String(chatId));
        body.append('text', text);

        return {
          url,
          method: 'POST',
          body,
        };
      }
    );

    let json = null;

    try {
      json = JSON.parse(raw);
    } catch {
      errlog('sendMessage: bad json response:', shortRaw(raw));
      return false;
    }

    if (!json.ok) {
      errlog('sendMessage: Telegram error:', JSON.stringify(json).substring(0, 1000));
      return false;
    }

    log('sendMessage: отправлено, message_id=', json.result?.message_id);
    return true;
  } catch (e) {
    errlog('sendMessage: failed:', e?.message || e);
    return false;
  }
}

async function sendTelegramFile({ method, fieldName, chatId, filePath, filename, caption }) {
  if (!TELEGRAM_TOKEN) {
    errlog(`${method}: TELEGRAM_BOT_TOKEN не задан в .env`);
    return false;
  }

  if (!chatId) {
    errlog(`${method}: chatId пустой`);
    return false;
  }

  if (!fs.existsSync(filePath)) {
    errlog(`${method}: file not found:`, filePath);
    return false;
  }

  const stat = fs.statSync(filePath);
  log(`${method}: file=${filePath}, size=${stat.size} bytes`);

  if (stat.size <= 0) {
    errlog(`${method}: file is empty`);
    return false;
  }

  const fileData = await fs.promises.readFile(filePath);
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;

  try {
    const raw = await fetchTextRetry(
      `Telegram ${method}`,
      TELEGRAM_ATTEMPTS,
      TELEGRAM_TIMEOUT_MS,
      async () => {
        const formData = new FormData();

        formData.append('chat_id', String(chatId));

        if (caption) {
          formData.append('caption', String(caption).substring(0, 1024));
        }

        formData.append(
          fieldName,
          new Blob([fileData], { type: 'image/png' }),
          filename
        );

        return {
          url,
          method: 'POST',
          body: formData,
        };
      }
    );

    let json = null;

    try {
      json = JSON.parse(raw);
    } catch {
      errlog(`${method}: bad json response:`, shortRaw(raw));
      return false;
    }

    if (!json.ok) {
      errlog(`${method}: Telegram error:`, JSON.stringify(json).substring(0, 1000));
      return false;
    }

    log(`${method}: отправлено успешно, message_id=`, json.result?.message_id);
    return true;
  } catch (e) {
    errlog(`${method}: failed:`, e?.message || e);
    return false;
  }
}

async function sendPhotoRobust(chatId, filePath, caption = '') {
  log('sendPhotoRobust: start');

  const photoSent = await sendTelegramFile({
    method: 'sendPhoto',
    fieldName: 'photo',
    chatId,
    filePath,
    filename: 'inventory_diff.png',
    caption,
  });

  if (photoSent) {
    log('sendPhotoRobust: sendPhoto OK');
    return true;
  }

  errlog('sendPhotoRobust: sendPhoto failed, trying sendDocument fallback');

  const documentSent = await sendTelegramFile({
    method: 'sendDocument',
    fieldName: 'document',
    chatId,
    filePath,
    filename: 'inventory_diff.png',
    caption: `${caption}\nPNG отправлен как файл после ошибки sendPhoto.`,
  });

  if (documentSent) {
    log('sendPhotoRobust: sendDocument fallback OK');
    return true;
  }

  errlog('sendPhotoRobust: all Telegram file sending methods failed');
  return false;
}

async function renderDiffPng(title, items, totalSum, totalSum20, quarter, outPath) {
  log(`renderDiffPng: start, items=${items.length}, outPath=${outPath}`);

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
    rows.push([
      it.group,
      it.name,
      String(it.evotor),
      String(it.invent),
      String(it.diff),
      String(it.price),
      String(it.sum),
      '',
    ]);
  }

  rows.push(['', '', '', '', '', '', '', '']);
  rows.push(['', '', '', '', '', 'Сумма', String(totalSum), '']);
  rows.push(['', '', '', '', '', 'Сумма - 20%', String(totalSum20), String(quarter)]);

  const colWidths = [130, 260, 70, 70, 80, 80, 100, 80];
  const leftPadding = 20;
  const topPadding = 20;
  const rowHeight = 28;

  const totalWidth = leftPadding * 2 + colWidths.reduce((a, b) => a + b, 0);
  const totalHeight = topPadding * 2 + rows.length * rowHeight + 10;

  log(`renderDiffPng: canvas ${totalWidth}x${totalHeight}`);

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
    const isTotalRow = r >= rows.length - 2;

    if (isTitleRow) {
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(leftPadding, y, totalWidth - leftPadding * 2, rowHeight);
    } else if (isHeaderRow) {
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(leftPadding, y, totalWidth - leftPadding * 2, rowHeight);
    } else if (isTotalRow) {
      ctx.fillStyle = '#fafafa';
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

        if (isHeaderRow || isTotalRow) {
          ctx.font = 'bold 14px sans-serif';
          ctx.fillText(cell, tx, y + rowHeight / 2);
          ctx.font = '14px sans-serif';
        } else {
          ctx.fillText(cell, tx, y + rowHeight / 2);
        }
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
    stream.on('error', reject);
  });

  const stat = fs.statSync(outPath);

  log(`Diff PNG saved to ${outPath}, size=${stat.size} bytes`);
}

async function buildDiffSheet() {
  log('inventoryDiffReport: start');
  log('inventoryDiffReport: SRC_SHEET =', SRC_SHEET);
  log('inventoryDiffReport: DIFF_SHEET =', DIFF_SHEET);
  log('inventoryDiffReport: CHAT_ID =', CHAT_ID || '<empty>');

  if (!SPREADSHEET_ID) {
    throw new Error('Нет GOOGLE_SHEETS_SPREADSHEET_ID в .env');
  }

  ensureTmpDir();

  const authClient = await getGoogleAuthClient();

  const actualSrcSheet = await getActualSheetTitle(authClient, SRC_SHEET);
  const actualDiffSheet = await getActualSheetTitle(authClient, DIFF_SHEET);

  log('inventoryDiffReport: actual SRC_SHEET =', actualSrcSheet);
  log('inventoryDiffReport: actual DIFF_SHEET =', actualDiffSheet);

  const items = await loadDataSheet(authClient, actualSrcSheet);

  const today = formatDate(nowTZ());
  const title = `ИТОГИ ИНВЕНТАРИЗАЦИИ ${today}`;

  const totalSum = round2(items.reduce((acc, it) => acc + it.sum, 0));
  const totalSum20 = round2(totalSum * 0.8);
  const quarter = round2(totalSum20 / 4);

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

  for (const it of items) {
    values.push([
      it.group,
      it.name,
      it.evotor,
      it.invent,
      it.diff,
      it.price,
      it.sum,
      '',
    ]);
  }

  values.push(['', '', '', '', '', '', '', '']);
  values.push(['', '', '', '', '', 'Сумма', totalSum, '']);
  values.push(['', '', '', '', '', 'Сумма - 20%', totalSum20, quarter]);

  const totalRows = values.length;
  const writeRange = `${quoteSheetName(actualDiffSheet)}!A1:H${totalRows}`;

  log(`inventoryDiffReport: начинаю REST-запись RAW в лист '${writeRange}'`);
  log('inventoryDiffReport: rows to write =', totalRows);
  log('inventoryDiffReport: totalSum =', totalSum);
  log('inventoryDiffReport: totalSum20 =', totalSum20);
  log('inventoryDiffReport: quarter =', quarter);

  await googleSheetsValuesUpdateRaw(authClient, writeRange, values);

  log('inventoryDiffReport: sheet updated, rows =', totalRows);

  const pngPath = `${TMP_DIR}/inventory_diff_${Date.now()}.png`;

  await renderDiffPng(
    title,
    items,
    totalSum,
    totalSum20,
    quarter,
    pngPath
  );

  if (!CHAT_ID) {
    log('CHAT_ID не передан, картинку в Telegram не отправляем');
    log('inventoryDiffReport: INVENT_CLEAR_ON_START remains 0 because CHAT_ID is empty');
    log('inventoryDiffReport: PNG saved for manual sending:', pngPath);
    return;
  }

  const sent = await sendPhotoRobust(CHAT_ID, pngPath, title);

  if (sent) {
    log('inventoryDiffReport: PNG sent to Telegram chat', CHAT_ID);
    setInventClearOnStart(1);

    try {
      if (fs.existsSync(pngPath)) {
        fs.unlinkSync(pngPath);
        log('inventoryDiffReport: tmp PNG removed:', pngPath);
      }
    } catch (e) {
      errlog('inventoryDiffReport: failed to remove tmp PNG:', e);
    }
  } else {
    errlog('inventoryDiffReport: PNG was NOT sent to Telegram chat', CHAT_ID);
    errlog('inventoryDiffReport: INVENT_CLEAR_ON_START remains 0 to protect inventory results');
    errlog('inventoryDiffReport: PNG kept for manual sending:', pngPath);

    await sendMessage(
      CHAT_ID,
      `❗ Отчёт сформирован, но картинка не отправилась.\nФайл сохранён на сервере:\n${pngPath}\n\nИнвентаризация остаётся заблокированной, чтобы не перезаписать Data.`
    );
  }

  log('inventoryDiffReport: done');
}

async function main() {
  let lockAcquired = false;

  try {
    acquireLock();
    lockAcquired = true;

    await buildDiffSheet();

    process.exitCode = 0;
  } catch (e) {
    if (e?.code === 'ALREADY_RUNNING') {
      errlog(e.message);

      if (CHAT_ID) {
        await sendMessage(
          CHAT_ID,
          'Отчёт по инвентаризации уже формируется. Повторный запуск пропущен.'
        );
      }

      process.exitCode = 0;
    } else {
      errlog('inventoryDiffReport: error', e?.stack || e?.message || e);

      if (CHAT_ID) {
        await sendMessage(
          CHAT_ID,
          '❗ Ошибка при формировании отчёта по инвентаризации. Проверь inventoryDiffReport.log'
        );
      }

      process.exitCode = 1;
    }
  } finally {
    if (lockAcquired) {
      releaseLock();
    }

    process.exit(process.exitCode || 0);
  }
}

main();