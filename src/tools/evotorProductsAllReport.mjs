import '../env.js';
import fs from 'fs';
import { q } from '../db.js';
import { send } from '../tg.js';
import { renderTableToPngColorRows } from '../utils/tableRenderColorRows.mjs';

/* ===================== КОНСТАНТЫ ===================== */

const COL_WIDTH_NAME  = 150;
const COL_WIDTH_STOCK = 50;

const GROUPS = ['еда', 'снэки', 'напитки', 'энергетики'];

const COLOR_RED    = '#FFE1E1';
const COLOR_YELLOW = '#FFF3D6';
const COLOR_GREEN  = '#DFF6E8';

const LOG_DIR  = '/home/a/abokovsa/berserkclub.ru/MyBerserk/logs';
const LOG_PATH = `${LOG_DIR}/evotorProductsAllReport.log`;

const TG_SEND_RETRIES = 5;
const TG_SEND_TIMEOUT_MS = 60_000;

/* ==================================================== */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function envNum(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const clean = raw.split('#')[0].trim();
  const n = Number(clean);
  return Number.isNaN(n) ? null : n;
}

const DEFAULT_CHAT_ID = envNum('TG_CHAT_MAIN');

/* ======================= TIME / LOG ======================= */

function nowMoscow() {
  const d = new Date();

  const base = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d).replace(' ', 'T');

  return `${base}.${String(d.getMilliseconds()).padStart(3, '0')}+03:00`;
}

async function appendLog(text) {
  try {
    await fs.promises.mkdir(LOG_DIR, { recursive: true });
    await fs.promises.appendFile(LOG_PATH, `${text}\n`);
  } catch {}
}

function errorToLog(err) {
  const cause = err?.cause;

  return [
    `${err?.name || 'Error'}: ${err?.message || String(err)}`,

    cause
      ? [
          'cause:',
          `name=${cause.name || ''}`,
          `code=${cause.code || ''}`,
          `errno=${cause.errno || ''}`,
          `syscall=${cause.syscall || ''}`,
          `hostname=${cause.hostname || ''}`,
          `address=${cause.address || ''}`,
          `port=${cause.port || ''}`,
          `message=${cause.message || ''}`,
        ].join(' ')
      : '',

    err?.stack || '',
  ].filter(Boolean).join('\n');
}

async function logErrorBlock(title, err) {
  const text = `[${nowMoscow()}] ${title}\n${errorToLog(err)}\n`;

  console.error(text);
  await appendLog(text);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ======================= TG PHOTO ======================= */

async function fetchWithTimeout(url, options = {}, timeoutMs = TG_SEND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function sendPhoto({ chatId, filePath }) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан');

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const buffer = await fs.promises.readFile(filePath);

  let lastErr = null;

  for (let attempt = 1; attempt <= TG_SEND_RETRIES; attempt++) {
    try {
      const blob = new Blob([buffer], { type: 'image/png' });

      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('photo', blob, 'evotor_products.png');

      const startText =
        `[${nowMoscow()}] sendPhoto: attempt=${attempt}/${TG_SEND_RETRIES}, ` +
        `file=${filePath}, size=${buffer.length}`;

      console.log(startText);
      await appendLog(startText);

      const res = await fetchWithTimeout(url, {
        method: 'POST',
        body: form,
      });

      const text = await res.text();

      if (!res.ok) {
        throw new Error(`Telegram sendPhoto failed: HTTP ${res.status} ${text}`);
      }

      const okText = `[${nowMoscow()}] sendPhoto: OK attempt=${attempt}`;
      console.log(okText);
      await appendLog(okText);

      return JSON.parse(text);
    } catch (err) {
      lastErr = err;

      await logErrorBlock(
        `sendPhoto failed: attempt=${attempt}/${TG_SEND_RETRIES}`,
        err
      );

      if (attempt < TG_SEND_RETRIES) {
        const delayMs = 3000 * attempt;
        const retryText = `[${nowMoscow()}] sendPhoto: retry after ${delayMs}ms`;

        console.log(retryText);
        await appendLog(retryText);

        await sleep(delayMs);
      }
    }
  }

  throw lastErr;
}

/* ======================= CLI ======================= */

const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  return found ? found.slice(pref.length) : def;
}

const chatId = Number(getArg('chatId', DEFAULT_CHAT_ID)) || DEFAULT_CHAT_ID;

/* ======================= UTILS ======================= */

const intStr = v => String(Math.round(Number(v) || 0));

function wrapName(txt, maxLen = 32) {
  const out = [];
  let s = String(txt || '').trim();

  while (s.length > maxLen) {
    let cut = s.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    out.push(s.slice(0, cut));
    s = s.slice(cut).trimStart();
  }

  if (s.length) out.push(s);

  return out.length ? out : [''];
}

/* ======================= ЦВЕТА ======================= */

function stockToColor(stock, group) {
  const x = Number(stock) || 0;

  if (x === 0) return COLOR_RED;

  if (group === 'еда') {
    if (x <= 5) return COLOR_YELLOW;
    return COLOR_GREEN;
  }

  if (x < 10) return COLOR_YELLOW;
  return COLOR_GREEN;
}

/* ======================= SCHEMA ======================= */

let PRODUCTS_SCHEMA = null;

async function getEvotorProductsSchema() {
  if (PRODUCTS_SCHEMA) return PRODUCTS_SCHEMA;

  const cols = await q(`SHOW COLUMNS FROM evotor_products`);
  const names = new Set(cols.map(c => c.Field));

  const pick = arr => arr.find(c => names.has(c)) || null;

  PRODUCTS_SCHEMA = {
    nameCol:   pick(['product_name', 'name', 'title']),
    qtyNewCol: pick(['quantity_new']),
    qtyCol:    pick(['quantity']),
    allowCol:  pick(['allow_to_sell']),
    typeCol:   pick(['type']),
    parentCol: pick(['parent_id']),
  };

  return PRODUCTS_SCHEMA;
}

/* ======================= LOAD ======================= */

async function loadProductsByGroup(groupNameLower) {
  const s = await getEvotorProductsSchema();

  const stockExpr = s.qtyNewCol
    ? `COALESCE(p.\`${s.qtyNewCol}\`, p.\`${s.qtyCol}\`, 0)`
    : `COALESCE(p.\`${s.qtyCol}\`, 0)`;

  return await q(
    `
    SELECT
      p.product_id,
      p.\`${s.nameCol}\` AS product_name,
      ${stockExpr} AS stock
    FROM evotor_products p
    LEFT JOIN evotor_product_groups g
      ON p.\`${s.parentCol}\` = g.group_id
    WHERE LOWER(g.name) = ?
      AND p.\`${s.allowCol}\` = 1
      AND LOWER(p.\`${s.typeCol}\`) = 'normal'
    ORDER BY stock DESC, product_name ASC
    `,
    [groupNameLower]
  );
}

/* ======================= RENDER ======================= */

async function renderAndSendGroup(groupName) {
  const rows = await loadProductsByGroup(groupName);

  if (!rows.length) return;

  const table = [[groupName.toUpperCase(), 'ОСТАТОК']];
  const rowBgColors = [];

  for (const r of rows) {
    table.push([
      wrapName(r.product_name).join('\n'),
      intStr(r.stock),
    ]);

    rowBgColors.push(stockToColor(r.stock, groupName));
  }

  const outPath = `/tmp/evotor_products_${groupName}.png`;

  try {
    await renderTableToPngColorRows(table, {
      outPath,
      colMinWidths: [COL_WIDTH_NAME, COL_WIDTH_STOCK],
      rowBgColors,
    });

    await sendPhoto({ chatId, filePath: outPath });
  } finally {
    await fs.promises.unlink(outPath).catch(() => {});
  }
}

/* ======================= MAIN ======================= */

async function main() {
  try {
    if (!chatId) return;

    const startText = `[${nowMoscow()}] evotorProductsAllReport: start`;
    console.log(startText);
    await appendLog(startText);

    for (const g of GROUPS) {
      const groupText = `[${nowMoscow()}] evotorProductsAllReport: group=${g}`;
      console.log(groupText);
      await appendLog(groupText);

      await renderAndSendGroup(g);
    }

    const finishText = `[${nowMoscow()}] evotorProductsAllReport: finish`;
    console.log(finishText);
    await appendLog(finishText);
  } catch (e) {
    const errText = errorToLog(e);

    console.error('evotorProductsAllReport error:', errText);

    await appendLog(
      `[${nowMoscow()}] ERROR\n${errText}\n`
    );

    try {
      await send(
        chatId,
        `❗ Ошибка при формировании отчёта по товарам`
      );
    } catch {}
  }
}

main();