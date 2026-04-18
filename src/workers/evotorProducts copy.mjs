// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorProductsReport.mjs

import '../env.js';
import fs from 'fs';
import { q } from '../db.js';
import { send } from '../tg.js';
import { renderTableToPngWrap } from './tableRenderWrap.mjs';

const TZ = process.env.TZ || 'Europe/Moscow';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function envNum(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const clean = raw.split('#')[0].trim();
  const n = Number(clean);
  return Number.isNaN(n) ? null : n;
}

const DEFAULT_CHAT_ID = envNum('TG_CHAT_TEST');

// =====================
// отправка фото
// =====================
async function sendPhoto({ chatId, filePath, caption = '' }) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  if (!chatId) throw new Error('chatId не задан');

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;

  const buffer = await fs.promises.readFile(filePath);
  const blob = new Blob([buffer]);
  const form = new FormData();

  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('parse_mode', 'Markdown');
  form.append('photo', blob, 'evotor_products.png');

  const res = await fetch(url, { method: 'POST', body: form });
  const txt = await res.text();
  if (!res.ok) throw new Error(`TG sendPhoto ${res.status}: ${txt}`);

  console.log('TG sendPhoto OK:', txt);
}

// ===== CLI =====
const argv = process.argv.slice(2);
function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a === `--${name}` || a.startsWith(pref));
  if (!found) return def;
  if (found === `--${name}`) return def;
  return found.slice(pref.length);
}
function boolArg(name, def = false) {
  const v = getArg(name, null);
  if (v === null) return def;
  return ['1', 'true', 'yes', 'y'].includes(String(v).toLowerCase());
}

const chatId =
  Number(getArg('chatId', DEFAULT_CHAT_ID)) || DEFAULT_CHAT_ID;

const sessionNumberArg = getArg('sessionNumber', null);
const sessionIdArg     = getArg('sessionId', null);
const preferOpen       = boolArg('preferOpen', true);

// ===== utils =====
function toTZ(d) {
  if (!d) return null;
  const dt = new Date(d);
  const s = dt.toLocaleString('ru-RU', { timeZone: TZ });
  const out = new Date(s);
  return Number.isNaN(out.getTime()) ? null : out;
}

function timeLabel(d) {
  const dd = toTZ(d);
  if (!dd) return '';
  return dd.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ДД.ММ без года
function dateLabel(d) {
  const dd = toTZ(d);
  if (!dd) return '';
  const day = String(dd.getDate()).padStart(2, '0');
  const month = String(dd.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

// int строка
function intStr(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n));
}

// wrap имени по пробелам
function splitName(str, maxLen) {
  const out = [];
  let rest = String(str || '').trim();
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  if (!out.length) out.push('');
  return out;
}

// ===== session resolve =====
async function findOpenSession() {
  const rows = await q(`
    SELECT s.session_id, s.session_number, s.close_date
    FROM evotor_sessions s
    WHERE s.evotor_type='OPEN_SESSION'
      AND NOT EXISTS (
        SELECT 1 FROM evotor_sessions c
        WHERE c.session_id=s.session_id
          AND c.evotor_type='CLOSE_SESSION'
      )
    ORDER BY s.close_date DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

async function findLastClosedSession() {
  const rows = await q(`
    SELECT session_id, session_number, close_date
    FROM evotor_sessions
    WHERE evotor_type='CLOSE_SESSION'
    ORDER BY close_date DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

async function findBySessionNumber(n) {
  const closed = await q(`
    SELECT session_id, session_number, close_date
    FROM evotor_sessions
    WHERE evotor_type='CLOSE_SESSION' AND session_number=?
    LIMIT 1
  `,[n]);
  if (closed.length) return closed[0];

  const open = await q(`
    SELECT session_id, session_number, close_date
    FROM evotor_sessions
    WHERE evotor_type='OPEN_SESSION' AND session_number=?
    LIMIT 1
  `,[n]);
  return open[0] || null;
}

async function findBySessionId(id) {
  const closed = await q(`
    SELECT session_id, session_number, close_date
    FROM evotor_sessions
    WHERE evotor_type='CLOSE_SESSION' AND session_id=?
    LIMIT 1
  `,[id]);
  if (closed.length) return closed[0];

  const open = await q(`
    SELECT session_id, session_number, close_date
    FROM evotor_sessions
    WHERE evotor_type='OPEN_SESSION' AND session_id=?
    LIMIT 1
  `,[id]);
  return open[0] || null;
}

async function resolveSession() {
  if (sessionIdArg) {
    const s = await findBySessionId(sessionIdArg);
    if (s) return s;
  }

  if (sessionNumberArg) {
    const s = await findBySessionNumber(sessionNumberArg);
    if (s) return s;
  }

  if (preferOpen) {
    const s = await findOpenSession();
    if (s) return s;
  }

  return await findLastClosedSession();
}

async function loadSessionTimes(sessionId) {
  const rows = await q(`
    SELECT evotor_type, close_date
    FROM evotor_sessions
    WHERE session_id=?
  `,[sessionId]);

  let opened = null, closed = null;
  for (const r of rows) {
    if (r.evotor_type === 'OPEN_SESSION') {
      if (!opened || new Date(r.close_date) < new Date(opened))
        opened = r.close_date;
    }
    if (r.evotor_type === 'CLOSE_SESSION') {
      if (!closed || new Date(r.close_date) > new Date(closed))
        closed = r.close_date;
    }
  }
  return { opened_at: opened, closed_at: closed };
}

async function loadSalesTimes(sessionId) {
  const rows = await q(`
    SELECT MIN(close_date) AS min_close,
           MAX(close_date) AS max_close
    FROM evotor_sales
    WHERE session_id=?
  `,[sessionId]);
  return rows[0] || {};
}

// ===== products =====
async function loadProducts(sessionId) {
  const rows = await q(`
    SELECT
      es.product_id,
      es.product_name,
      SUM(es.quantity) AS qty,
      SUM(es.result_sum) AS sum_total,
      SUM(es.discount_sum) AS sum_discount,
      MAX(COALESCE(p.quantity_new, p.quantity)) AS stock
    FROM evotor_sales es
    LEFT JOIN evotor_products p
      ON es.product_id=p.product_id
    WHERE es.session_id=?
      AND (es.product_type='NORMAL'
        OR (es.product_type IS NULL AND p.type='NORMAL'))
    GROUP BY es.product_id, es.product_name
    ORDER BY sum_total DESC, es.product_name ASC
  `,[sessionId]);
  return rows;
}

// ===== main =====
async function main() {
  try {
    const session = await resolveSession();
    if (!session) {
      await send(chatId, '❗ Нет подходящей смены для отчёта по товарам.');
      return;
    }

    const { session_id, session_number } = session;

    const times    = await loadSessionTimes(session_id);
    const products = await loadProducts(session_id);

    let opened = times.opened_at;
    let closed = times.closed_at;

    if (!opened && !closed) {
      const st = await loadSalesTimes(session_id);
      if (st.min_close) opened = st.min_close;
      if (st.max_close) closed = st.max_close;
    }

    const d  = opened ? dateLabel(opened) : (closed ? dateLabel(closed) : '');
    const t1 = timeLabel(opened);
    const t2 = timeLabel(closed);

    // caption одной строкой: "(ДД.ММ ЧЧ:ММ–ЧЧ:ММ)"
    let capExtra = '';
    if (d || t1 || t2) {
      const parts = [];
      if (d) parts.push(d);
      if (t1 || t2) parts.push(`${t1 || '??'}–${t2 || '…'}`);
      capExtra = ` (${parts.join(' ')})`;
    }

    const caption =
      `*Отчёт по товарам Evotor за кассовую смену ${session_number}${capExtra}*`;

    if (!products.length) {
      await send(chatId, `${caption}\n\nНет продаж по товарам.`);
      return;
    }

    // ===== формируем таблицу =====
    const header = ['ТОВАР', 'КОЛ', 'СУММ', 'СКИД', 'ОСТ'];
    const MAX_LEN = 20;

    let totalQty  = 0;
    let totalSum  = 0;
    let totalDisc = 0;

    const body = products.map(p => {
      const nameLines = splitName(p.product_name, MAX_LEN);
      const nameCell  = nameLines.join('\n');

      const qty  = Number(p.qty || 0);
      const sum  = Number(p.sum_total || 0);
      const disc = Number(p.sum_discount || 0);

      totalQty  += qty;
      totalSum  += sum;
      totalDisc += disc;

      return [
        nameCell,
        intStr(qty),
        intStr(sum),
        intStr(disc),
        intStr(p.stock),
      ];
    });

    // последняя строка — итоги
    const totalsRow = [
      'Сумма',
      intStr(totalQty),
      intStr(totalSum),
      intStr(totalDisc),
      '',
    ];
    body.push(totalsRow);

    const table = [header, ...body];
    const outPath = `/tmp/evotor_products_${session_number}.png`;

    const pngPath = renderTableToPngWrap(table, {
      outPath,
      colMinWidths: [180, 60, 70, 70, 60],
    });

    console.log('evotorProductsReport: rows=', table.length);
    await sendPhoto({ chatId, filePath: pngPath, caption });

    try { await fs.promises.unlink(outPath); } catch {}

  } catch (e) {
    console.error('evotorProductsReport error:', e);
    try {
      await send(chatId, '❗ Ошибка при формировании отчёта по товарам.');
    } catch {}
  }
}

main();
