// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorDocDump.mjs
// Вывод ВСЕХ данных по одному документу Evotor (любой type) — ищет по number или id,
// листает документы по paging.next_cursor пока не найдёт.
//
// Usage:
//   node src/tools/evotorDocDump.mjs 1150
//   node src/tools/evotorDocDump.mjs --number=1150
//   node src/tools/evotorDocDump.mjs --id=b8ea08e5-972d-4ab4-b64f-3381e96104be
//   node src/tools/evotorDocDump.mjs --number=1150 --maxPages=800

import '../env.js';
import util from 'node:util';

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

function getMaxPagesArg(def = 500) {
  const raw = String(getArg('maxPages', '') || '').trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), 5000);
}

function getNeedle() {
  const id = String(getArg('id', '') || '').trim();
  if (id) return { by: 'id', value: id };

  const num = String(getArg('number', '') || getArg('doc', '') || '').trim();
  if (num) return { by: 'number', value: num };

  const pos = argv.find(a => !String(a).startsWith('--'));
  const p = String(pos || '').trim();
  if (p) return { by: 'number', value: p };

  return null;
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

function matchDoc(doc, needle) {
  if (!doc || !needle) return false;

  if (needle.by === 'id') {
    return String(doc.id ?? '').trim() === needle.value;
  }

  // by number
  const target = String(needle.value).trim();

  // строковое сравнение
  if (String(doc.number ?? '').trim() === target) return true;

  // числовое сравнение (на случай "1150" vs 1150)
  const tNum = Number(target);
  if (!Number.isNaN(tNum)) {
    const dNum = Number(doc.number);
    if (!Number.isNaN(dNum) && dNum === tNum) return true;
  }

  return false;
}

// ------------------- HELPERS / SUMS -------------------

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

  return { docSumHint, positionsSum, paymentsSum, positionsCount: positions.length, paymentsCount: payments.length };
}

// ------------------- MAIN -------------------

(async () => {
  try {
    const needle = getNeedle();
    const maxPages = getMaxPagesArg(500);

    if (!needle) {
      console.log('Нужно указать документ: --number=1150 или --id=<uuid> (или просто 1150 позиционно).');
      process.exit(1);
    }

    let cursor = null;
    let pages = 0;
    let fetched = 0;
    let found = null;

    while (pages < maxPages) {
      const { items, nextCursor } = await fetchDocumentsPage(cursor);
      pages += 1;
      fetched += items.length;

      found = items.find(d => matchDoc(d, needle)) || null;
      if (found) break;

      if (!nextCursor) break;
      cursor = nextCursor;
    }

    if (!found) {
      console.log(`Документ не найден: ${needle.by}=${needle.value}. pages=${pages}, fetched=${fetched}`);
      return;
    }

    const dt = found.close_date || found.created_at || found.created || found.moment || found.date || '';

    console.log('');
    console.log('='.repeat(120));
    console.log(`EVOTOR DOC DUMP: ${needle.by}=${needle.value}`);
    console.log(`number=${found.number ?? ''} | type=${found.type ?? ''} | id=${found.id ?? ''} | date=${fmtDate(dt)}`);
    console.log(`store_id=${found.store_id ?? ''} | device_id=${found.device_id ?? ''} | session_number=${found.session_number ?? ''}`);
    console.log(`pages_scanned=${pages} | fetched=${fetched}`);
    console.log('='.repeat(120));

    const sums = calcSums(found);
    console.log(`positions_count=${sums.positionsCount} | payments_count=${sums.paymentsCount}`);
    console.log(`doc_sum_hint=${sums.docSumHint === null ? '' : sums.docSumHint.toFixed(2)} | positions_sum=${sums.positionsSum.toFixed(2)} | payments_sum=${sums.paymentsSum.toFixed(2)}`);
    console.log('='.repeat(120));
    console.log('');

    // ВЕСЬ документ целиком (включая body)
    console.log(util.inspect(found, { depth: 20, colors: true, maxArrayLength: 500 }));

    console.log('');
    console.log('='.repeat(120));
    console.log('Если нужно прям "без ограничений", увеличь depth/maxArrayLength в util.inspect.');
    console.log('='.repeat(120));
    console.log('');
  } catch (err) {
    console.error('Ошибка выполнения скрипта:', err?.message || err);
  }
})();
