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

// по умолчанию — отчётный чат
const DEFAULT_CHAT_ID = envNum('TG_CHAT_REPORT');

// ===== отправка фото =====
async function sendPhoto({ chatId, filePath, caption }) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const buffer = await fs.promises.readFile(filePath);
  const blob = new Blob([buffer]);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');
  }
  form.append('photo', blob, 'evotor_products.png');

  const res = await fetch(url, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`TG sendPhoto: ${text}`);
  console.log('TG sendPhoto OK:', text);
}

// ===== CLI =====
const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  return found ? found.slice(pref.length) : def;
}

function boolArg(name, def = false) {
  const val = getArg(name, null);
  if (val == null) return def;
  return ['1', 'true', 'yes', 'y'].includes(String(val).toLowerCase());
}

const chatId =
  Number(getArg('chatId', DEFAULT_CHAT_ID)) || DEFAULT_CHAT_ID;

const sessionNumberArg = getArg('sessionNumber', null); // "товар 53"
const sessionIdArg     = getArg('sessionId', null);     // от evotorSessions
const preferOpen       = boolArg('preferOpen', false);

// ===== utils =====
function toTZ(d) {
  if (!d) return null;
  const s = new Date(d).toLocaleString('ru-RU', { timeZone: TZ });
  const r = new Date(s);
  return Number.isNaN(r.getTime()) ? null : r;
}

function dateLabel(d) {
  const dd = toTZ(d);
  if (!dd) return '';
  return dd.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function timeLabel(d) {
  const dd = toTZ(d);
  if (!dd) return '??';
  return dd.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

const intStr = v => String(Math.round(Number(v) || 0));

// wrap-разбиение внутри одной ячейки
function wrapName(txt, maxLen = 20) {
  const out = [];
  let s = String(txt || '').trim();
  while (s.length > maxLen) {
    let cut = s.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    out.push(s.slice(0, cut));
    s = s.slice(cut).trimStart();
  }
  if (s.length) out.push(s);
  if (!out.length) out.push('');
  return out;
}

// ===== поиск смен =====
async function findOpen() {
  return (
    await q(`
      SELECT * FROM evotor_sessions
      WHERE evotor_type='OPEN_SESSION'
        AND NOT EXISTS (
          SELECT 1 FROM evotor_sessions c
          WHERE c.session_id=evotor_sessions.session_id
            AND c.evotor_type='CLOSE_SESSION'
        )
      ORDER BY close_date DESC
      LIMIT 1
    `)
  )[0];
}

async function findClosed() {
  return (
    await q(`
      SELECT * FROM evotor_sessions
      WHERE evotor_type='CLOSE_SESSION'
      ORDER BY close_date DESC
      LIMIT 1
    `)
  )[0];
}

async function findByNumber(num) {
  const closed = (
    await q(
      `
      SELECT * FROM evotor_sessions
      WHERE evotor_type='CLOSE_SESSION'
        AND session_number=?
      ORDER BY close_date DESC
      LIMIT 1
      `,
      [num]
    )
  )[0];
  if (closed) return closed;

  return (
    await q(
      `
      SELECT * FROM evotor_sessions
      WHERE evotor_type='OPEN_SESSION'
        AND session_number=?
      ORDER BY close_date DESC
      LIMIT 1
      `,
      [num]
    )
  )[0];
}

async function findById(id) {
  const closed = (
    await q(
      `
      SELECT * FROM evotor_sessions
      WHERE evotor_type='CLOSE_SESSION'
        AND session_id=?
      ORDER BY close_date DESC
      LIMIT 1
      `,
      [id]
    )
  )[0];
  if (closed) return closed;

  return (
    await q(
      `
      SELECT * FROM evotor_sessions
      WHERE evotor_type='OPEN_SESSION'
        AND session_id=?
      ORDER BY close_date DESC
      LIMIT 1
      `,
      [id]
    )
  )[0];
}

async function resolveSession() {
  if (sessionIdArg) {
    const s = await findById(sessionIdArg);
    if (s) return s;
  }

  if (sessionNumberArg) {
    const s = await findByNumber(sessionNumberArg);
    if (s) return s;
  }

  if (preferOpen) {
    const s = await findOpen();
    if (s) return s;
  }

  return await findClosed();
}

// ===== загрузка товаров =====
async function loadProducts(sessionId) {
  return await q(
    `
    SELECT
      es.product_id,
      es.product_name,
      SUM(es.quantity)       AS qty,
      SUM(es.result_sum)     AS sum_total,
      SUM(es.discount_sum)   AS sum_discount,
      MAX(COALESCE(p.quantity_new, p.quantity)) AS stock
    FROM evotor_sales es
    LEFT JOIN evotor_products p
      ON es.product_id = p.product_id
    LEFT JOIN evotor_product_groups g
      ON p.parent_id = g.group_id
    WHERE es.session_id = ?
      AND LOWER(g.name) IN ('еда','снэки','напитки','энергетики')
    GROUP BY es.product_id, es.product_name
    ORDER BY sum_total DESC, es.product_name ASC
    `,
    [sessionId]
  );
}

// ===== main =====
async function main() {
  try {
    if (!chatId) {
      console.error('evotorProductsReport: chatId не задан');
      return;
    }

    const session = await resolveSession();

    if (!session) {
      await send(
        chatId,
        '❗ Не удалось определить кассовую смену Evotor для отчёта по товарам.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const sessionId     = session.session_id;
    const sessionNumber = session.session_number;

    const products = await loadProducts(sessionId);
    if (!products.length) {
      await send(
        chatId,
        `*Товары* за смену *${sessionNumber}*\n\nНет продаж по товарам.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const d = dateLabel(session.close_date || new Date());
    const t = timeLabel(session.close_date || new Date());

    const caption = [
      `*Товары* за смену *${sessionNumber}*`,
      `${d} ${t}`,
    ].join('\n');

    const header = ['ТОВАР', 'КОЛ', 'СУММ', 'СКИД', 'ОСТ'];

    let totalQty  = 0;
    let totalSum  = 0;
    let totalDisc = 0;

    const body = [];

    for (const p of products) {
      const lines    = wrapName(p.product_name, 20);
      const nameCell = lines.join('\n');

      const qty   = Number(p.qty)          || 0;
      const sum   = Number(p.sum_total)    || 0;
      const disc  = Number(p.sum_discount) || 0;
      const stock = Number(p.stock)        || 0;

      totalQty  += qty;
      totalSum  += sum;
      totalDisc += disc;

      body.push([
        nameCell,
        intStr(qty),
        intStr(sum),
        intStr(disc),
        intStr(stock),
      ]);
    }

    body.push([
      'Сумма',
      intStr(totalQty),
      intStr(totalSum),
      intStr(totalDisc),
      '',
    ]);

    const table = [header, ...body];

    const outPath = `/tmp/evotor_products_${sessionNumber}.png`;

    renderTableToPngWrap(table, {
      outPath,
      colMinWidths: [170, 60, 70, 70, 60],
      totalsRowIndex: table.length - 1,
    });

    await sendPhoto({ chatId, filePath: outPath, caption });

    try {
      await fs.promises.unlink(outPath);
    } catch (e) {
      console.log('unlink error (ok):', e.message);
    }
  } catch (e) {
    console.error('evotorProductsReport error:', e);
    try {
      if (chatId) {
        await send(
          chatId,
          '❗ Ошибка при формировании отчёта по товарам Evotor.',
          { parse_mode: 'Markdown' }
        );
      }
    } catch {}
  }
}

main();
