// src/tools/evotorPurchasePlanner.mjs
// Планировщик закупок по данным Evotor + FAST_SOLD + BLACKLIST(JSON, exact match)
//
// BLACKLIST файл по умолчанию:
// /home/a/abokovsa/berserkclub.ru/config/purchase_blacklist.json
// Можно переопределить:
// --blacklist=/path/to/purchase_blacklist.json
//
// Формат JSON:
// { "exact": ["Чикен Дог", "Бургер куриный", "Аскания"] }
//
// Вывод:
// ABC | REC | FAST | BOOST | ТОВАР | НЕД | ШТ/НЕД | КЛИЕНТ/НЕД | БЕРС/НЕД | ОСТ | КОНЧИТСЯ
//
// Важно:
// - знаменатель для КЛИЕНТ/НЕД и БЕРС/НЕД = weeks_available (общий), чтобы:
//   ШТ/НЕД == КЛИЕНТ/НЕД + БЕРС/НЕД (с погрешностью округления)
// - контроль целостности: qty == qty_client + qty_bers (warn если нет)
//
// Окно данных (ISO-недели):
// - --weeks=N (обяз.) = ровно N ISO-недель (пн-вс)
// - --to=YYYY-MM-DD (опционально, по умолчанию сегодня)
// => to приводим к воскресенью ISO-недели, from к понедельнику нужной недели
// => COUNT(DISTINCT YEARWEEK(...,1)) <= N
//
// Остатки:
// - берём из evotor_products.quantity
//
// Прогноз окончания:
// - скорость потребления = ШТ/НЕД (baseWeekly), БЕЗ boost
// - days_left = stock / (baseWeekly/7)
// - end_date = FORECAST_FROM + ceil(days_left) дней
// - FORECAST_FROM = текущая дата запуска скрипта, потому что ОСТ берётся текущий

import '../env.js';
import { q } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';

// ----------------------------
// CLI args
// ----------------------------
const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  return found ? found.substring(pref.length) : def;
}

const GROUP_ARG = getArg('group', null);

if (!GROUP_ARG) {
  console.log('Использование: node src/tools/evotorPurchasePlanner.mjs --group="Еда" --weeks=8 --lifeDays=7 --cap=40 --mode=analysis');
  console.log('Окно данных: --weeks=N (обяз.), --to=YYYY-MM-DD (опционально, по умолчанию сегодня)');
  process.exit(1);
}

const LIFE_DAYS = Math.max(1, Number(getArg('lifeDays', '7')) || 7);
const CAP = Number(getArg('cap', '0')) || 0;
const TOP = Math.max(0, Number(getArg('top', '0')) || 0);
const NAME_LIKE = getArg('nameLike', null);

const MODE_RAW = String(getArg('mode', 'analysis') || 'analysis').toLowerCase();
const MODE = MODE_RAW === 'planning' ? 'planning' : 'analysis';

const BLACKLIST_PATH = getArg(
  'blacklist',
  '/home/a/abokovsa/berserkclub.ru/config/purchase_blacklist.json'
);

// window: weeks + to
const WEEKS = Math.max(1, Number(getArg('weeks', '0')) || 0);

if (!WEEKS) {
  console.log('Ошибка: требуется --weeks=N (например --weeks=8)');
  process.exit(1);
}

const DATE_TO_RAW = getArg('to', null);

// ----------------------------
// Helpers
// ----------------------------
function pad(s, n) {
  s = String(s ?? '');
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}

function round2(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}

function round0(x) {
  return Math.round(Number(x));
}

function looksLikeGuid(x) {
  const s = String(x || '').trim();
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function median(arr) {
  const a = (arr || [])
    .filter(v => Number.isFinite(v))
    .sort((x, y) => x - y);

  if (!a.length) return null;

  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function toDateSafe(x) {
  if (!x) return null;
  if (x instanceof Date && !Number.isNaN(x.getTime())) return x;

  const s = String(x);

  const d1 = new Date(s);
  if (!Number.isNaN(d1.getTime())) return d1;

  const d2 = new Date(s.replace(' ', 'T'));
  if (!Number.isNaN(d2.getTime())) return d2;

  return null;
}

function diffHoursSafe(a, b) {
  const da = toDateSafe(a);
  const db = toDateSafe(b);

  if (!da || !db) return null;

  const ms = db.getTime() - da.getTime();
  if (!Number.isFinite(ms)) return null;

  const h = ms / 3600000;
  if (!Number.isFinite(h)) return null;

  return Math.max(1, h);
}

function normName(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isoDateOnlyLocal(d) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}

function parseYmdLocal(ymd) {
  if (!ymd) return null;

  const m = String(ymd).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const da = Number(m[3]);

  const d = new Date(y, mo, da, 12, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;

  return d;
}

function startOfIsoWeekLocal(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);

  const day = x.getDay(); // 0=Sun..6=Sat
  const isoOffset = (day + 6) % 7; // Mon=0..Sun=6

  const monday = new Date(x.getTime() - isoOffset * 24 * 3600 * 1000);

  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 0, 0, 0, 0);
}

function endOfIsoWeekLocal(d) {
  const monday = startOfIsoWeekLocal(d);
  const sunday = new Date(monday.getTime() + 6 * 24 * 3600 * 1000);

  return new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate(), 23, 59, 59, 999);
}

function addDaysYmd(ymd, days) {
  const d = parseYmdLocal(ymd);
  if (!d) return null;

  const x = new Date(d.getTime() + Number(days || 0) * 24 * 3600 * 1000);
  return isoDateOnlyLocal(x);
}

// ----------------------------
// Window build: ровно N ISO-недель
// ----------------------------
const toInput = DATE_TO_RAW ? parseYmdLocal(DATE_TO_RAW) : new Date();

if (!toInput) {
  console.log(`Ошибка: неверный формат --to (нужно YYYY-MM-DD). Получено: ${DATE_TO_RAW}`);
  process.exit(1);
}

const toEnd = endOfIsoWeekLocal(toInput);
const toWeekStart = startOfIsoWeekLocal(toInput);

const fromStart = new Date(toWeekStart.getTime() - (WEEKS - 1) * 7 * 24 * 3600 * 1000);
fromStart.setHours(0, 0, 0, 0);

const DATE_TO = isoDateOnlyLocal(toEnd);
const DATE_FROM = isoDateOnlyLocal(fromStart);

// Важно:
// DATE_TO — конец окна анализа.
// FORECAST_FROM — дата, от которой считаем "КОНЧИТСЯ".
// Так как ОСТ берётся текущий из evotor_products.quantity,
// прогноз окончания должен считаться от текущей даты запуска.
const FORECAST_FROM = isoDateOnlyLocal(new Date());

// ----------------------------
// BLACKLIST load (exact match)
// ----------------------------
function loadBlacklistExact(filePath) {
  try {
    const p = path.resolve(filePath);

    if (!fs.existsSync(p)) {
      return {
        set: new Set(),
        raw: [],
        ok: false,
        reason: 'file_not_found',
        path: p,
      };
    }

    const txt = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(txt);

    const arr = Array.isArray(json?.exact) ? json.exact : [];
    const raw = arr.map(x => String(x ?? '')).filter(Boolean);

    const set = new Set(raw.map(normName).filter(Boolean));

    return {
      set,
      raw,
      ok: true,
      reason: null,
      path: p,
    };
  } catch (e) {
    return {
      set: new Set(),
      raw: [],
      ok: false,
      reason: e?.message || 'parse_error',
      path: path.resolve(filePath),
    };
  }
}

const BL = loadBlacklistExact(BLACKLIST_PATH);

function isBlacklistedExact(name) {
  if (!BL.set || BL.set.size === 0) return false;
  return BL.set.has(normName(name));
}

// ----------------------------
// Resolve group_id
// ----------------------------
let groupRow = null;

if (looksLikeGuid(GROUP_ARG)) {
  const r = await q(
    `
    SELECT group_id, name
    FROM evotor_product_groups
    WHERE group_id = ?
      AND is_deleted = 0
    LIMIT 1
    `,
    [GROUP_ARG]
  );

  groupRow = r?.[0] || null;
} else {
  const r = await q(
    `
    SELECT group_id, name
    FROM evotor_product_groups
    WHERE name = ?
      AND is_deleted = 0
    LIMIT 1
    `,
    [GROUP_ARG]
  );

  groupRow = r?.[0] || null;
}

if (!groupRow) {
  console.log(`Группа не найдена: "${GROUP_ARG}".`);
  console.log('Проверь список: SELECT name, group_id FROM evotor_product_groups WHERE is_deleted=0 ORDER BY name;');
  process.exit(1);
}

const GROUP_ID = groupRow.group_id;
const GROUP_NAME = groupRow.name;

// ----------------------------
// Build WHERE
// ----------------------------
let where = `
  WHERE s.close_date IS NOT NULL
    AND COALESCE(s.quantity, 0) > 0
    AND p.parent_id = ?
`;

const params = [GROUP_ID];

if (NAME_LIKE) {
  where += ' AND s.product_name LIKE ?';
  params.push(`%${NAME_LIKE}%`);
}

// window enforced always (ISO-aligned)
where += ' AND s.close_date >= ?';
params.push(`${DATE_FROM} 00:00:00`);

where += ' AND s.close_date <= ?';
params.push(`${DATE_TO} 23:59:59`);

// ----------------------------
// 1) Totals by product (+ split) + STOCK from evotor_products.quantity
// ----------------------------
const rowsRaw = await q(
  `
  SELECT
    s.product_id,
    s.product_name,

    SUM(COALESCE(s.quantity, 0)) AS qty,
    COUNT(DISTINCT YEARWEEK(s.close_date, 1)) AS weeks_available,

    MIN(s.close_date) AS first_sale,
    MAX(s.close_date) AS last_sale,

    SUM(COALESCE(s.result_sum, 0)) AS revenue,

    SUM(
      CASE
        WHEN COALESCE(s.discount_sum, 0) = 0
        THEN COALESCE(s.quantity, 0)
        ELSE 0
      END
    ) AS qty_client,

    SUM(
      CASE
        WHEN COALESCE(s.discount_sum, 0) > 0
        THEN COALESCE(s.quantity, 0)
        ELSE 0
      END
    ) AS qty_bers,

    MAX(COALESCE(p.quantity, 0)) AS stock_qty

  FROM evotor_sales s
  INNER JOIN evotor_products p
    ON p.product_id = s.product_id
  ${where}
  GROUP BY s.product_id, s.product_name
  HAVING qty > 0
  ORDER BY qty DESC
  `,
  params
);

// exact blacklist filter
let blacklistedCount = 0;

const rows = rowsRaw.filter(r => {
  const bad = isBlacklistedExact(r.product_name);

  if (bad) {
    blacklistedCount++;
  }

  return !bad;
});

if (!rows.length) {
  console.log(`После blacklist не осталось товаров по группе "${GROUP_NAME}".`);
  process.exit(0);
}

// ----------------------------
// 2) Weekly windows for speed model (all sales)
// ----------------------------
const weeklyRaw = await q(
  `
  SELECT
    s.product_id,
    s.product_name,
    YEARWEEK(s.close_date, 1) AS yw,

    SUM(COALESCE(s.quantity, 0)) AS qty_week,

    MIN(s.close_date) AS first_ts,
    MAX(s.close_date) AS last_ts

  FROM evotor_sales s
  INNER JOIN evotor_products p
    ON p.product_id = s.product_id
  ${where}
  GROUP BY s.product_id, s.product_name, yw
  HAVING qty_week > 0
  `,
  params
);

const weekly = weeklyRaw.filter(w => !isBlacklistedExact(w.product_name));

const speedByProduct = new Map();
const allRates = [];

for (const w of weekly) {
  const pid = w.product_id;
  const qtyWeek = Number(w.qty_week || 0);
  const hours = diffHoursSafe(w.first_ts, w.last_ts);

  if (!Number.isFinite(qtyWeek) || qtyWeek <= 0) continue;
  if (!Number.isFinite(hours) || hours <= 0) continue;

  const rate = qtyWeek / hours;

  if (!Number.isFinite(rate) || rate <= 0) continue;

  allRates.push(rate);

  if (!speedByProduct.has(pid)) {
    speedByProduct.set(pid, {
      rates: [],
      fast: false,
    });
  }

  speedByProduct.get(pid).rates.push(rate);
}

let baselineRate = median(allRates);

if (!Number.isFinite(baselineRate) || baselineRate <= 0) {
  baselineRate = 1;
}

// fast flag
for (const w of weekly) {
  const pid = w.product_id;
  const qtyWeek = Number(w.qty_week || 0);
  const hours = diffHoursSafe(w.first_ts, w.last_ts);

  if (!Number.isFinite(qtyWeek) || qtyWeek <= 0) continue;
  if (!Number.isFinite(hours) || hours <= 0) continue;

  const rate = qtyWeek / hours;

  if (!Number.isFinite(rate) || rate <= 0) continue;

  if (!speedByProduct.has(pid)) {
    speedByProduct.set(pid, {
      rates: [rate],
      fast: false,
    });
  }

  const ratio = rate / baselineRate;

  if (hours <= 24 && ratio >= 1.3) {
    speedByProduct.get(pid).fast = true;
  }
}

// ----------------------------
// Metrics
// ----------------------------
let totalQtyAll = 0;
let totalRevenue = 0;

const itemsAll = rows.map(r => {
  const qty = Number(r.qty || 0);
  const weeksAvailable = Math.max(1, Number(r.weeks_available || 0));
  const revenue = Number(r.revenue || 0);

  const qtyClient = Number(r.qty_client || 0);
  const qtyBers = Number(r.qty_bers || 0);

  const stockQty = Number(r.stock_qty ?? 0);

  // контроль: qty == qty_client + qty_bers
  const split = qtyClient + qtyBers;

  if (Math.abs(qty - split) > 0.0001) {
    console.warn(`⚠ qty split mismatch: "${r.product_name}" qty=${qty} client+bers=${split}`);
  }

  totalQtyAll += qty;
  totalRevenue += revenue;

  // ШТ/НЕД (без boost)
  const baseWeekly = qty / weeksAvailable;

  // общий знаменатель weeks_available, чтобы суммы сходились
  const clientWeekly = qtyClient / weeksAvailable;
  const bersWeekly = qtyBers / weeksAvailable;

  const sp = speedByProduct.get(r.product_id);
  const productRate = sp ? median(sp.rates) : null;

  let boost = 1.0;

  if (Number.isFinite(productRate) && productRate > 0 && baselineRate > 0) {
    boost = clamp(productRate / baselineRate, 1.0, 2.0);
  }

  const fast = sp ? Boolean(sp.fast) : false;

  // закупка считается по скорректированному спросу
  const weeklyAdj = baseWeekly * boost;
  const perPeriod = weeklyAdj * (LIFE_DAYS / 7);

  // прогноз окончания по baseWeekly (без boost)
  // ВАЖНО: считаем от FORECAST_FROM, а не от DATE_TO,
  // потому что stockQty — текущий остаток из evotor_products.quantity.
  const perDay = baseWeekly / 7;

  let endDate = '-';

  if (
    Number.isFinite(stockQty) &&
    stockQty > 0 &&
    Number.isFinite(perDay) &&
    perDay > 0
  ) {
    const daysLeft = Math.ceil(stockQty / perDay);
    const d = addDaysYmd(FORECAST_FROM, daysLeft);

    if (d) {
      endDate = d;
    }
  }

  return {
    product_id: r.product_id,
    name: r.product_name,

    qty,
    revenue,
    weeks_available: weeksAvailable,

    qty_client: qtyClient,
    qty_bers: qtyBers,

    clientWeekly,
    bersWeekly,

    baseWeekly,
    weeklyAdj,
    perPeriod,

    boost,
    fast,

    first_sale: r.first_sale,
    last_sale: r.last_sale,

    stockQty,
    endDate,
  };
});

// доля по qty (нужна для ABC, не показываем)
for (const it of itemsAll) {
  it.share = totalQtyAll > 0 ? it.qty / totalQtyAll : 0;
}

// сортировка по спросу на период (скоррект.)
itemsAll.sort((a, b) => b.perPeriod - a.perPeriod);

// TOP
let items = itemsAll;

if (TOP > 0) {
  items = itemsAll.slice(0, TOP);
}

// ABC по доле qty
let cum = 0;

const abcBase = [...itemsAll].sort((a, b) => b.qty - a.qty);
const abcMap = new Map();

for (const it of abcBase) {
  cum += it.share;

  let abc = 'C';

  if (cum <= 0.80) {
    abc = 'A';
  } else if (cum <= 0.95) {
    abc = 'B';
  }

  abcMap.set(it.product_id, abc);
}

for (const it of items) {
  it.abc = abcMap.get(it.product_id) || 'C';
}

// Capacity scaling
const demandTotal = items.reduce((s, i) => s + i.perPeriod, 0);

let scale = 1;

if (CAP > 0 && demandTotal > CAP) {
  scale = CAP / demandTotal;
}

// Plan + REC
function getRec(row) {
  if (row.buyPeriod <= 0) return 'DROP';
  if (row.abc === 'A') return 'KEEP';
  if (row.buyPeriod >= 2) return 'KEEP';
  return 'OPTIONAL';
}

const plannedAll = items.map(i => {
  const need = i.perPeriod * (CAP > 0 ? scale : 1);
  const buyPeriod = Math.max(0, round0(need));

  const row = {
    ...i,
    buyPeriod,
  };

  row.rec = getRec(row);

  return row;
});

const planned = MODE === 'planning'
  ? plannedAll.filter(x => x.buyPeriod > 0)
  : plannedAll;

// ----------------------------
// Output
// ----------------------------
const minDateAll = itemsAll.reduce(
  (m, x) => (x.first_sale < m ? x.first_sale : m),
  itemsAll[0].first_sale
);

const maxDateAll = itemsAll.reduce(
  (m, x) => (x.last_sale > m ? x.last_sale : m),
  itemsAll[0].last_sale
);

console.log('\nПЛАНИРОВЩИК ЗАКУПОК (Evotor)');
console.log('============================================================');
console.log(`Группа: ${GROUP_NAME}`);
console.log(`group_id: ${GROUP_ID}`);
console.log(`Режим: ${MODE}`);

if (!BL.ok) {
  console.log(`BLACKLIST: не загружен (${BL.reason}). Файл: ${BL.path}`);
} else {
  console.log(`BLACKLIST exact: ${BL.raw.length} (исключено: ${blacklistedCount}). Файл: ${BL.path}`);
}

if (NAME_LIKE) {
  console.log(`Фильтр nameLike: "%${NAME_LIKE}%"`);
}

console.log(`Окно данных: ровно ${WEEKS} ISO-нед. (пн-вс)  (from ${DATE_FROM} -> to ${DATE_TO})`);
console.log(`Период данных (факт): ${minDateAll} -> ${maxDateAll}`);
console.log(`Прогноз окончания от: ${FORECAST_FROM} (по текущему остатку из evotor_products.quantity)`);
console.log(`Горизонт планирования (lifeDays): ${LIFE_DAYS} дней`);
console.log(`Всего продано: ${round2(totalQtyAll)} шт`);
console.log(`Выручка:       ${round2(totalRevenue)}\n`);

console.log(`Скорость: baseline_rate(median sell_rate) = ${round2(baselineRate)} шт/час`);
console.log('FAST=YES если была неделя: sale_window<=24ч и sell_rate/baseline>=1.3');

if (CAP > 0) {
  const plannedTotal = plannedAll.reduce((s, i) => s + i.buyPeriod, 0);

  console.log(`Ограничение вместимости (cap): ${CAP} шт на ${LIFE_DAYS} дней`);
  console.log(`Итоговый план (после нормализации): ${plannedTotal} шт на ${LIFE_DAYS} дней`);
  console.log('------------------------------------------------------------\n');
} else {
  console.log(`cap не задан — показываю естественный спрос на ${LIFE_DAYS} дней.\n`);
}

console.log(
  `${pad('ABC', 3)} | ${pad('REC', 8)} | ${pad('FAST', 4)} | ${pad('BOOST', 5)} | ${pad('ТОВАР', 30)} | ${pad('НЕД', 3)} | ${pad('ШТ/НЕД', 7)} | ${pad('КЛИЕНТ/НЕД', 10)} | ${pad('БЕРС/НЕД', 8)} | ${pad('ОСТ', 4)} | ${pad('КОНЧИТСЯ', 10)}`
);

console.log('-'.repeat(124));

for (const r of planned) {
  console.log(
    `${pad(r.abc, 3)} | ${pad(r.rec, 8)} | ${pad(r.fast ? 'YES' : 'NO', 4)} | ${pad(r.boost.toFixed(2), 5)} | ` +
    `${pad(r.name, 30)} | ${pad(String(r.weeks_available), 3)} | ${pad(round2(r.baseWeekly).toFixed(2), 7)} | ` +
    `${pad(round2(r.clientWeekly).toFixed(2), 10)} | ${pad(round2(r.bersWeekly).toFixed(2), 8)} | ` +
    `${pad(String(Math.max(0, round0(r.stockQty))), 4)} | ${pad(String(r.endDate), 10)}`
  );
}

console.log('\nПримечания:');
console.log('- ШТ/НЕД = qty / weeks_available (все продажи) — используется для прогноза окончания без boost.');
console.log('- КЛИЕНТ/НЕД = qty_client / weeks_available, где discount_sum=0.');
console.log('- БЕРС/НЕД = qty_bers / weeks_available, где discount_sum>0.');
console.log('- ОСТ = текущий evotor_products.quantity.');
console.log('- КОНЧИТСЯ = дата запуска скрипта + ceil(ОСТ / (ШТ/НЕД/7)) дней, если ШТ/НЕД>0 и ОСТ>0.');
console.log('- Контроль: qty == qty_client + qty_bers (warn при расхождении).');
console.log('============================================================\n');