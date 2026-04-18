// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorProductsByGroupsConsole.mjs

import '../env.js';
import { q } from '../db.js';

const TZ = process.env.TZ || 'Europe/Moscow';

// ===== целевые группы =====
// Названия должны совпадать с evotor_product_groups.name
const TARGET_GROUPS = ['еда', 'снэки', 'напитки', 'энергетики'];

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

const sessionNumberArg = getArg('sessionNumber', null);
const sessionIdArg = getArg('sessionId', null);
const preferOpen = boolArg('preferOpen', true);

// ===== utils =====
function toTZ(d) {
  if (!d) return null;
  const s = new Date(d).toLocaleString('ru-RU', { timeZone: TZ });
  const r = new Date(s);
  return Number.isNaN(r.getTime()) ? null : r;
}

function dateLabel(d) {
  const dd = toTZ(d);
  return dd
    ? dd.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
    : '';
}

function timeLabel(d) {
  const dd = toTZ(d);
  return dd
    ? dd.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : '??';
}

const intStr = v => String(Math.round(Number(v) || 0));

// ===== поиск смен =====
async function findOpen() {
  return (
    await q(`
      SELECT * FROM evotor_sessions
      WHERE evotor_type='OPEN_SESSION'
        AND NOT EXISTS (
          SELECT 1 FROM evotor_sessions c
          WHERE c.session_id = evotor_sessions.session_id
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

// ===== загрузка товаров через JOIN групп =====
async function loadProductsByGroups(sessionId) {
  const placeholders = TARGET_GROUPS.map(() => '?').join(', ');

  return await q(
    `
    SELECT
      es.product_id,
      es.product_name,
      SUM(es.quantity)     AS qty,
      SUM(es.result_sum)   AS sum_total,
      SUM(es.discount_sum) AS sum_discount,
      MAX(COALESCE(p.quantity_new, p.quantity)) AS stock,
      g.name AS group_name
    FROM evotor_sales es
    LEFT JOIN evotor_products p
      ON es.product_id = p.product_id
    LEFT JOIN evotor_product_groups g
      ON p.parent_id = g.group_id
    WHERE es.session_id = ?
      AND g.name IN (${placeholders})
    GROUP BY es.product_id, es.product_name, g.name
    ORDER BY g.name ASC, sum_total DESC, es.product_name ASC
    `,
    [sessionId, ...TARGET_GROUPS]
  );
}


// ===== вывод таблицы =====
function printProductsConsole(session, products) {
  const sessionNumber = session.session_number;

  console.log(`\nТовары по группам: ${TARGET_GROUPS.join(', ')}`);
  console.log(`Смена №${sessionNumber}\n`);

  if (!products.length) {
    console.log('Нет товаров указанных групп за эту смену.');
    return;
  }

  const header = ['ГРУППА', 'ТОВАР', 'КОЛ', 'СУММА', 'СКИДКА', 'ОСТ'];
  const rows = products.map(p => [
    p.group_name || '',
    p.product_name || '',
    intStr(p.qty),
    intStr(p.sum_total),
    intStr(p.sum_discount),
    intStr(p.stock),
  ]);

  // вычисление ширины столбцов
  const all = [header, ...rows];
  const colWidths = header.map((_, i) =>
    Math.max(...all.map(r => String(r[i]).length))
  );

  const fmt = r =>
    r.map((c, i) => String(c).padEnd(colWidths[i] + 2)).join('');

  console.log(fmt(header));
  console.log('-'.repeat(colWidths.reduce((a, b) => a + b + 2, 0)));

  rows.forEach(r => console.log(fmt(r)));

  // totals
  const totalQty = rows.reduce((s, r) => s + Number(r[2]), 0);
  const totalSum = rows.reduce((s, r) => s + Number(r[3]), 0);
  const totalDisc = rows.reduce((s, r) => s + Number(r[4]), 0);

  console.log('\nИТОГО:');
  console.log(`Кол-во: ${totalQty}`);
  console.log(`Сумма:  ${totalSum}`);
  console.log(`Скидка: ${totalDisc}`);
}

// ===== main =====
async function main() {
  try {
    const session = await resolveSession();

    if (!session) {
      console.error('❗ Не удалось определить смену Evotor.');
      return;
    }

    const products = await loadProductsByGroups(session.session_id);

    printProductsConsole(session, products);
  } catch (err) {
    console.error('Ошибка:', err);
  }
}

main();
