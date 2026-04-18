// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorLastDocs.mjs
// Вывод в консоль N последних документов Evotor + суммы по операциям (doc_sum / positions_sum / payments_sum)
// + опциональный 2-й аргумент ДАТА (как строка YYYY-MM-DD) — показывает документы только за этот день.
//
// Usage:
//   node src/tools/evotorLastDocs.mjs --count=30
//   node src/tools/evotorLastDocs.mjs --count=30 --date=2025-12-01
//   node src/tools/evotorLastDocs.mjs 30 2025-12-01

import '../env.js';

const API_BASE = 'https://api.evotor.ru';

const STORE_ID  = process.env.STORE_ID;
const DEVICE_ID = process.env.DEVICE_ID;
const TOKEN     = process.env.EVOTOR_ACCESS_TOKEN;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Отсутствует переменная окружения ${name} в .env (${name})`);
    process.exit(1);
  }
}

requireEnv('STORE_ID', STORE_ID);
requireEnv('DEVICE_ID', DEVICE_ID);
requireEnv('EVOTOR_ACCESS_TOKEN', TOKEN);

// ------------------- ARGS -------------------

const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  if (!found) return def;
  return found.substring(pref.length);
}

function getCountArg(def = 30) {
  const byFlag = getArg('count', null) ?? getArg('n', null) ?? getArg('limit', null);

  // 1-й позиционный аргумент (не --something)
  const pos = argv.find(a => !String(a).startsWith('--') && !/^\d{4}-\d{2}-\d{2}$/.test(String(a)));

  const raw = (byFlag ?? pos ?? '').toString().trim();
  if (!raw) return def;

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), 5000);
}

function getMaxPagesArg(def = 300) {
  const raw = (getArg('maxPages', null) ?? '').toString().trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), 2000);
}

function getDateArg() {
  // --date=YYYY-MM-DD или 2-й позиционный аргумент вида YYYY-MM-DD
  const byFlag = (getArg('date', null) ?? '').toString().trim();
  const posDate = argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(String(a)));

  const raw = (byFlag || posDate || '').toString().trim();
  if (!raw) return null;

  // день "как есть" (локальная дата сервера)
  const d = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;

  const from = d.getTime();
  const to = from + 24 * 60 * 60 * 1000 - 1;

  return { raw, from, to };
}

// ------------------- DATE / SORT -------------------

function docTs(d) {
  const raw =
    d.close_date ||
    d.created_at ||
    d.created ||
    d.moment ||
    d.date ||
    null;

  const t = raw ? new Date(raw).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function fmtDate(raw) {
  if (!raw) return '';
  try {
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return String(raw);
    return dt.toISOString().replace('T', ' ').replace('Z', 'Z');
  } catch {
    return String(raw);
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickFirstNumber(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function calcSums(doc) {
  const body = doc?.body || {};

  const positions = Array.isArray(body.positions) ? body.positions : [];
  const payments  = Array.isArray(body.payments) ? body.payments : [];

  const positionsSum = positions.reduce((acc, p) => acc + num(p?.sum), 0);

  const paymentsSum = payments.reduce((acc, p) => {
    const val =
      p?.sum ??
      p?.amount ??
      p?.value ??
      p?.pay_amount ??
      p?.paid ??
      null;

    return acc + num(val);
  }, 0);

  const docSumHint = pickFirstNumber(body, [
    'sum',
    'total',
    'result_sum',
    'amount',
    'payback_sum',
    'cash_sum',
    'card_sum',
    'total_sum',
  ]);

  return { docSumHint, positionsSum, paymentsSum };
}

// ------------------- EVOTOR PAGED FETCH -------------------

async function fetchDocumentsPage(cursor = null) {
  const url = new URL(`${API_BASE}/stores/${STORE_ID}/devices/${DEVICE_ID}/documents`);
  if (cursor) url.searchParams.set('cursor', cursor);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Authorization': TOKEN,
      'Accept': 'application/vnd.evotor.v2+json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ошибка запроса: ${res.status} ${res.statusText}\n${text}`);
  }

  const data = await res.json();

  const items = Array.isArray(data.items)
    ? data.items
    : (Array.isArray(data) ? data : (Array.isArray(data.documents) ? data.documents : []));

  const nextCursor = data?.paging?.next_cursor ?? null;

  return { items, nextCursor };
}

// держим только top-K самых свежих по timestamp
function pushTopK(top, doc, K) {
  top.push(doc);
  if (top.length > K * 3) {
    top.sort((a, b) => docTs(b) - docTs(a));
    top.length = K;
  }
}

// ------------------- MAIN -------------------

(async () => {
  try {
    const count = getCountArg(30);
    const maxPages = getMaxPagesArg(300);
    const dateFilter = getDateArg(); // null или {raw, from, to}

    const top = [];
    let cursor = null;
    let pages = 0;
    let totalFetched = 0;

    while (pages < maxPages) {
      const { items, nextCursor } = await fetchDocumentsPage(cursor);

      pages += 1;
      totalFetched += items.length;

      for (const d of items) {
        if (dateFilter) {
          const ts = docTs(d);
          if (ts < dateFilter.from || ts > dateFilter.to) continue;
        }
        pushTopK(top, d, count);
      }

      if (!nextCursor) break;
      cursor = nextCursor;
    }

    top.sort((a, b) => docTs(b) - docTs(a));
    top.length = Math.min(top.length, count);

    if (!top.length) {
      console.log(
        dateFilter
          ? `Документы не найдены за дату ${dateFilter.raw}.`
          : 'Документы не найдены (пустой список Evotor documents).'
      );
      return;
    }

    let totalDocHint = 0;
    let totalPosSum  = 0;
    let totalPaySum  = 0;

    console.log('');
    console.log(
      `EVOTOR: последние документы` +
      ` (N=${top.length}, запрошено=${count}` +
      (dateFilter ? `, date=${dateFilter.raw}` : '') +
      `, страниц=${pages}, fetched=${totalFetched})`
    );
    console.log('='.repeat(140));
    console.log(
      [
        '#'.padStart(3),
        'number'.padStart(6),
        'type'.padEnd(18),
        'date'.padEnd(24),
        'pos'.padStart(3),
        'pay'.padStart(3),
        'doc_sum'.padStart(12),
        'pos_sum'.padStart(12),
        'pay_sum'.padStart(12),
        'id'
      ].join(' | ')
    );
    console.log('-'.repeat(140));

    for (let i = 0; i < top.length; i++) {
      const d = top[i];
      const dt = d.close_date || d.created_at || d.created || d.moment || d.date || '';
      const body = d.body || {};
      const positions = Array.isArray(body.positions) ? body.positions.length : 0;
      const payments = Array.isArray(body.payments) ? body.payments.length : 0;

      const { docSumHint, positionsSum, paymentsSum } = calcSums(d);

      if (docSumHint !== null) totalDocHint += docSumHint;
      totalPosSum += positionsSum;
      totalPaySum += paymentsSum;

      console.log(
        [
          String(i + 1).padStart(3),
          String(d.number ?? '').padStart(6),
          String(d.type ?? '').padEnd(18).slice(0, 18),
          fmtDate(dt).padEnd(24).slice(0, 24),
          String(positions).padStart(3),
          String(payments).padStart(3),
          (docSumHint === null ? '' : docSumHint.toFixed(2)).padStart(12),
          positionsSum.toFixed(2).padStart(12),
          paymentsSum.toFixed(2).padStart(12),
          String(d.id ?? '')
        ].join(' | ')
      );
    }

    console.log('-'.repeat(140));
    console.log(
      `TOTAL doc_sum_hint: ${totalDocHint.toFixed(2)}   | TOTAL positions_sum: ${totalPosSum.toFixed(2)}   | TOTAL payments_sum: ${totalPaySum.toFixed(2)}`
    );
    console.log('='.repeat(140));
    console.log('');
  } catch (err) {
    console.error('Ошибка выполнения скрипта:', err?.message || err);
  }
})();
