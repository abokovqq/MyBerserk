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

/* ======================= TG PHOTO ======================= */

async function sendPhoto({ chatId, filePath }) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан');

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const buffer = await fs.promises.readFile(filePath);
  const blob = new Blob([buffer]);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', blob, 'evotor_products.png');

  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(await res.text());
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

  // ⬇️ ГЛАВНОЕ ИЗМЕНЕНИЕ:
  // название группы → заголовок таблицы
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

  await renderTableToPngColorRows(table, {
    outPath,
    colMinWidths: [COL_WIDTH_NAME, COL_WIDTH_STOCK],
    rowBgColors,
  });

  await sendPhoto({ chatId, filePath: outPath });
  await fs.promises.unlink(outPath).catch(() => {});
}

/* ======================= MAIN ======================= */

async function main() {
  try {
    if (!chatId) return;

    for (const g of GROUPS) {
      await renderAndSendGroup(g);
    }
  } catch (e) {
    const errText = String(e?.stack || e?.message || e);

    console.error('evotorProductsAllReport error:', errText);

    try {
      await fs.promises.mkdir('/home/a/abokovsa/berserkclub.ru/MyBerserk/logs', { recursive: true });
      await fs.promises.appendFile(
        '/home/a/abokovsa/berserkclub.ru/MyBerserk/logs/evotorProductsAllReport.log',
        `[${new Date().toISOString()}] ERROR\n${errText}\n\n`
      );
    } catch {}

    try {
      await send(
        chatId,
        `❗ Ошибка при формировании отчёта по товарам.\n\n${errText.slice(0, 3000)}`
      );
    } catch {}
  }
}

main();
