// /src/workers/evotorSales.mjs
// Evotor → MySQL (evotor_sales)
// - SELL + PAYBACK (в ОДИН ПРОХОД, без отдельных циклов по типам)
// - Источник документов: device или cloud (опционально)
//    .env: EVOTOR_DOC_SOURCE=device|cloud  (default: device)
//    argv: --source=device|cloud           (перебивает .env)
// - device: /stores/{store}/devices/{device}/documents
// - cloud:  /stores/{store}/documents
// - полный документ добираем по тому же источнику
// - LOAD_ALL_SALES=true: полный прогон (от новых к старым через until + cursor), с защитой от "лимита 1000"
// - LOAD_ALL_SALES=false: инкрементально с backfill 10 минут
// - тестовый режим: --number=XXXX или --doc-id=UUID
// - 429: ждём x-ratelimit-reset + 2 минуты буфер и делаем 1 retry, второй 429 — стоп
// - 503: мягкий retry до 3 раз
// - OPTIMIZATION: НЕ качаем full-doc, если item.type не SELL/PAYBACK (режет запросы)
// - progress-лог

import '../env.js';
import { q } from '../db.js';

const API_BASE = 'https://api.evotor.ru';

const STORE_ID  = process.env.STORE_ID;
const DEVICE_ID = process.env.DEVICE_ID;
const TOKEN     = process.env.EVOTOR_ACCESS_TOKEN;

const LOAD_ALL_SALES =
  String(process.env.LOAD_ALL_SALES || '').toLowerCase() === 'true';

// -------------------- argv --------------------
const argv = process.argv.slice(2);
function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  return found ? found.slice(pref.length) : def;
}
const ONLY_NUMBER = getArg('number', null); // evotor_number
const ONLY_DOC_ID = getArg('doc-id', null); // evotor_doc_id (uuid)

const SOURCE_ARG = (getArg('source', '') || '').trim().toLowerCase();
const SOURCE_ENV = (String(process.env.EVOTOR_DOC_SOURCE || 'device')).trim().toLowerCase();
const DOC_SOURCE = (SOURCE_ARG || SOURCE_ENV || 'device');
const USE_DEVICE = DOC_SOURCE === 'device';

function requireEnv(name, value) {
  if (!value) {
    console.error(`Отсутствует ${name} в .env`);
    process.exit(1);
  }
}

requireEnv('STORE_ID', STORE_ID);
requireEnv('EVOTOR_ACCESS_TOKEN', TOKEN);
if (USE_DEVICE) requireEnv('DEVICE_ID', DEVICE_ID);

if (!['device', 'cloud'].includes(DOC_SOURCE)) {
  console.error(`Некорректный источник EVOTOR_DOC_SOURCE/--source: "${DOC_SOURCE}". Нужно device|cloud`);
  process.exit(1);
}

console.log(`evotorSales: doc source = ${DOC_SOURCE}`);

// Типы, которые сохраняем
const ALLOWED_TYPES = new Set(['SELL', 'PAYBACK']);

// Backfill для инкремента
const BACKFILL_MS = 10 * 60 * 1000;

// Страховка на случай скрытого лимита выдачи списка
const HARD_LIMIT_GUARD = 1000;

// ===== Progress logging =====
const PROGRESS_EVERY_DOCS = 50;
const PROGRESS_EVERY_MS   = 15_000;

class Progress {
  constructor(label) {
    this.label = label;
    this.startedAt = Date.now();
    this.lastLogAt = 0;
    this.total = null;
    this.processedDocs = 0;
    this.savedDocs = 0;
    this.insertedRows = 0;
    this.pages = 0;
    this.skippedByType = 0;
  }

  setTotalMaybe(n) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) this.total = v;
  }

  tickDoc({ savedDoc = false, insertedRows = 0, skipped = false } = {}) {
    this.processedDocs += 1;
    if (savedDoc) this.savedDocs += 1;
    if (skipped) this.skippedByType += 1;
    this.insertedRows += Number(insertedRows || 0);

    const now = Date.now();
    const needByDocs = (this.processedDocs % PROGRESS_EVERY_DOCS) === 0;
    const needByTime = (now - this.lastLogAt) >= PROGRESS_EVERY_MS;

    if (needByDocs || needByTime) {
      this.log(now);
      this.lastLogAt = now;
    }
  }

  log(now = Date.now()) {
    const elapsedSec = Math.max(1, (now - this.startedAt) / 1000);
    const rate = this.processedDocs / elapsedSec;

    let etaStr = '—';
    if (this.total != null && this.total >= this.processedDocs) {
      const remain = this.total - this.processedDocs;
      const etaSec = remain / Math.max(0.0001, rate);
      etaStr = formatEta(etaSec);
    }

    console.log(
      `[progress ${this.label}] docs=${this.processedDocs}` +
      (this.total != null ? `/${this.total}` : '') +
      `, savedDocs=${this.savedDocs}, skippedByType=${this.skippedByType}, insertedRows=${this.insertedRows}` +
      `, rate=${rate.toFixed(2)} docs/s, ETA=${etaStr}` +
      `, delay=${requestDelayMs}ms` +
      (cooldownUntilTs > Date.now() ? `, cooldown=${new Date(cooldownUntilTs).toISOString()}` : '')
    );
  }
}

function formatEta(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m ${ss}s`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

// -------------------- utils --------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// -------------------- DB --------------------
async function getLastCloseDateMs() {
  const rows = await q(`
    SELECT UNIX_TIMESTAMP(MAX(close_date)) * 1000 AS ts
    FROM evotor_sales
  `);
  return rows?.[0]?.ts ? Number(rows[0].ts) : null;
}

// ===== throttling / cooldown =====
let requestDelayMs = 600;
const REQUEST_DELAY_MIN = 250;
const REQUEST_DELAY_MAX = 600_000;
let cooldownUntilTs = 0;

// -------------------- Evotor API --------------------
async function evotorGet(url, attempt = 1) {
  const t = Date.now();
  if (cooldownUntilTs > t) {
    await sleep(cooldownUntilTs - t);
  }

  await sleep(requestDelayMs);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Authorization': TOKEN,
      'Accept': 'application/vnd.evotor.v2+json',
    },
  });

  if (res.status === 429) {
    const remaining = res.headers?.get?.('x-ratelimit-remaining') || '';
    const resetRaw  = res.headers?.get?.('x-ratelimit-reset') || '';
    const retryAfter = res.headers?.get?.('retry-after') || '';
    const raw = await res.text().catch(() => '');

    console.error('================ EVOTOR 429 RAW =================');
    console.error(`url: ${url}`);
    if (remaining) console.error(`x-ratelimit-remaining: ${remaining}`);
    if (resetRaw)  console.error(`x-ratelimit-reset: ${resetRaw}`);
    if (retryAfter) console.error(`retry-after: ${retryAfter}`);
    console.error('----- body -----');
    console.error(raw || '(empty body)');
    console.error('=================================================');

    if (attempt === 1) {
      const resetSec = Number(resetRaw);
      const baseMs = (Number.isFinite(resetSec) && resetSec > 0)
        ? resetSec * 1000
        : 20 * 60 * 1000;

      const waitMs = baseMs + 2 * 60 * 1000; // +2 минуты буфер
      cooldownUntilTs = Date.now() + waitMs;

      console.warn(
        `Evotor 429: wait ${Math.ceil(waitMs / 1000)}s then retry 1/1 ` +
        `(cooldown until ${new Date(cooldownUntilTs).toISOString()})`
      );

      await sleep(waitMs);
      return evotorGet(url, 2);
    }

    throw new Error('Evotor error: 429 Too Many Requests (second hit, stop)');
  }

  if (res.status === 503 && attempt <= 3) {
    const backoff = 2000 * attempt;
    console.warn(`Evotor 503, retry ${attempt}/3 (sleep=${backoff}ms)`);
    await sleep(backoff);
    return evotorGet(url, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Evotor error: ${res.status} ${res.statusText}\n${text}`);
  }

  if (cooldownUntilTs && cooldownUntilTs <= Date.now()) cooldownUntilTs = 0;
  requestDelayMs = clamp(requestDelayMs - 10, REQUEST_DELAY_MIN, REQUEST_DELAY_MAX);

  return await res.json();
}

// -------------------- URL builders (device/cloud) --------------------
function listDocsUrl({ since, until, cursor }) {
  const p = new URLSearchParams();

  if (cursor) {
    p.set('cursor', cursor);
  } else {
    if (since != null) p.set('since', String(since));
    if (until != null) p.set('until', String(until));
    // type НЕ ставим — берём всё, фильтруем по item.type
  }

  if (USE_DEVICE) {
    return `${API_BASE}/stores/${STORE_ID}/devices/${DEVICE_ID}/documents?${p.toString()}`;
  }
  return `${API_BASE}/stores/${STORE_ID}/documents?${p.toString()}`;
}

function docFullUrl(docId) {
  if (USE_DEVICE) {
    return `${API_BASE}/stores/${STORE_ID}/devices/${DEVICE_ID}/documents/${docId}`;
  }
  return `${API_BASE}/stores/${STORE_ID}/documents/${docId}`;
}

// -------------------- fetchers --------------------
async function fetchPage({ since, until, cursor }) {
  const url = listDocsUrl({ since, until, cursor });
  const data = await evotorGet(url);

  if (!Array.isArray(data.items)) {
    throw new Error('Ответ Эвотор не содержит items[]');
  }

  const totalCount =
    data?.paging?.total_count ?? data?.paging?.total ?? data?.paging?.totalCount ?? null;

  return {
    items: data.items,
    next: data?.paging?.next_cursor || null,
    totalCount,
  };
}

async function fetchDocFull(docId) {
  return await evotorGet(docFullUrl(docId));
}

// -------------------- find by number (минимум запросов) --------------------
async function findDocIdByNumber(evotorNumber) {
  const target = Number(evotorNumber);
  if (!Number.isFinite(target)) throw new Error(`Некорректный --number=${evotorNumber}`);

  let until = Date.now() + 1;

  while (true) {
    let cursor = null;
    let gotAny = 0;
    let minCloseMs = null;

    while (true) {
      const { items, next } = await fetchPage({ since: null, until, cursor });
      gotAny += items.length;

      for (const it of items) {
        if (Number(it?.number) === target) {
          return { docId: it.id, type: it?.type || null };
        }
        const cd = it?.close_date ? new Date(it.close_date).getTime() : null;
        if (cd != null) minCloseMs = (minCloseMs == null) ? cd : Math.min(minCloseMs, cd);
      }

      if (!next) break;
      cursor = next;
    }

    if (gotAny === 0) break;

    if (gotAny >= HARD_LIMIT_GUARD && minCloseMs != null) {
      until = minCloseMs - 1;
      continue;
    }

    break;
  }

  return null;
}

// -------------------- Save --------------------
function getAffectedRows(res) {
  if (res && typeof res.affectedRows === 'number') return res.affectedRows;
  if (Array.isArray(res)) {
    for (const x of res) {
      if (x && typeof x.affectedRows === 'number') return x.affectedRows;
      if (Array.isArray(x)) {
        for (const y of x) if (y && typeof y.affectedRows === 'number') return y.affectedRows;
      }
    }
  }
  return 0;
}

async function saveDoc(doc) {
  if (!doc || !ALLOWED_TYPES.has(doc.type)) return { insertedRows: 0, saved: false };

  const body = doc.body || {};
  const positions = Array.isArray(body.positions) ? body.positions : [];
  if (positions.length === 0) return { insertedRows: 0, saved: true };

  const payments = Array.isArray(body.payments) ? body.payments : [];

  function paymentMatchesPrintGroup(pay, pgId) {
    if (!pgId) return true;
    const parts = Array.isArray(pay?.parts) ? pay.parts : [];
    return parts.some(x => x?.print_group_id === pgId);
  }

  function resolvePaymentTypeForPosition(pos) {
    if (!payments.length) return null;
    const pgId = pos?.print_group_id || null;

    if (pgId) {
      const matched = payments.filter(pay => paymentMatchesPrintGroup(pay, pgId));
      for (const pay of matched) if (pay?.type) return pay.type;
    }

    for (const pay of payments) if (pay?.type) return pay.type;
    return null;
  }

  const sql = `
    INSERT IGNORE INTO evotor_sales (
      evotor_doc_id,
      evotor_number,
      evotor_type,
      close_date,
      time_zone_offset,
      session_id,
      session_number,
      close_user_id,
      device_id,
      store_id,
      user_id,

      position_uuid,
      position_id,
      product_id,
      product_code,
      product_name,
      product_type,
      measure_name,
      quantity,
      price,
      sum,
      cost_price,
      result_price,
      result_sum,
      tax_type,
      tax_sum,
      tax_result_sum,
      discount_sum,
      discount_percent,
      discount_type,
      print_group_id,
      settlement_method_type,
      payments_type,
      created_at
    ) VALUES ?
  `;

  const values = positions.map(p => {
    const disc = p.doc_distributed_discount || {};
    const tax  = p.tax || {};
    const sm   = p.settlement_method || {};
    const paymentsType = resolvePaymentTypeForPosition(p);

    return [
      doc.id,
      doc.number,
      doc.type,
      doc.close_date ? new Date(doc.close_date) : null,
      doc.time_zone_offset ?? 0,
      doc.session_id || null,
      doc.session_number ?? null,
      doc.close_user_id || null,
      doc.device_id || null,
      doc.store_id || null,
      doc.user_id || null,

      p.uuid || null,
      p.id ?? null,
      p.product_id || null,
      p.code || null,
      p.product_name || null,
      p.product_type || null,
      p.measure_name || null,
      p.quantity ?? 0,
      p.price ?? 0,
      p.sum ?? 0,

      p.cost_price ?? 0,
      p.result_price ?? 0,
      p.result_sum ?? 0,

      tax.type || null,
      tax.sum ?? 0,
      tax.result_sum ?? 0,

      disc.discount_sum ?? 0,
      disc.discount_percent ?? 0,
      disc.discount_type || null,

      p.print_group_id || null,
      sm.type || null,
      paymentsType || null,

      doc.created_at ? new Date(doc.created_at) : new Date(),
    ];
  });

  const res = await q(sql, [values]);
  return { insertedRows: getAffectedRows(res), saved: true };
}

// -------------------- Runs (ONE PASS) --------------------
async function runAll() {
  const prog = new Progress('ALL');

  let until = Date.now() + 1;
  let totalDocs = 0;
  let totalInsertedRows = 0;

  while (true) {
    let cursor = null;
    let batchDocs = 0;
    let minCloseMs = null;

    while (true) {
      const { items, next, totalCount } = await fetchPage({ since: null, until, cursor });
      prog.pages += 1;
      prog.setTotalMaybe(totalCount);

      batchDocs += items.length;

      for (const item of items) {
        // 🔥 ОПТИМИЗАЦИЯ: если тип не SELL/PAYBACK — не качаем full-doc
        const t = String(item?.type || '').toUpperCase();
        if (!ALLOWED_TYPES.has(t)) {
          prog.tickDoc({ savedDoc: false, insertedRows: 0, skipped: true });
          const cd0 = item?.close_date ? new Date(item.close_date).getTime() : null;
          if (cd0 != null) minCloseMs = (minCloseMs == null) ? cd0 : Math.min(minCloseMs, cd0);
          continue;
        }

        const docFull = await fetchDocFull(item.id);

        const cd = docFull?.close_date ? new Date(docFull.close_date).getTime() : null;
        if (cd != null) minCloseMs = (minCloseMs == null) ? cd : Math.min(minCloseMs, cd);

        const r = await saveDoc(docFull);
        totalInsertedRows += r.insertedRows;
        prog.tickDoc({ savedDoc: r.saved, insertedRows: r.insertedRows, skipped: false });
      }

      if (!next) break;
      cursor = next;
    }

    totalDocs += batchDocs;

    if (batchDocs === 0) break;

    if (batchDocs >= HARD_LIMIT_GUARD && minCloseMs != null) {
      until = minCloseMs - 1;
      console.log(`evotorSales: continue older, until=${until} (${new Date(until).toISOString()})`);
      continue;
    }

    break;
  }

  prog.log();
  return { docs: totalDocs, insertedRows: totalInsertedRows };
}

async function runIncremental(since) {
  const prog = new Progress('INC');

  let cursor = null;
  let docs = 0;
  let insertedRows = 0;

  while (true) {
    const { items, next, totalCount } = await fetchPage({ since, until: null, cursor });
    prog.pages += 1;
    prog.setTotalMaybe(totalCount);

    docs += items.length;

    for (const item of items) {
      const t = String(item?.type || '').toUpperCase();
      if (!ALLOWED_TYPES.has(t)) {
        prog.tickDoc({ savedDoc: false, insertedRows: 0, skipped: true });
        continue;
      }

      const docFull = await fetchDocFull(item.id);
      const r = await saveDoc(docFull);
      insertedRows += r.insertedRows;
      prog.tickDoc({ savedDoc: r.saved, insertedRows: r.insertedRows, skipped: false });
    }

    if (!next) break;
    cursor = next;
  }

  prog.log();
  return { docs, insertedRows };
}

// -------------------- Main --------------------
(async () => {
  try {
    // --- single-doc mode ---
    if (ONLY_DOC_ID || ONLY_NUMBER) {
      let docId = ONLY_DOC_ID;

      if (!docId) {
        const found = await findDocIdByNumber(ONLY_NUMBER);
        if (!found) {
          console.log(`Документ с evotor_number=${ONLY_NUMBER} не найден`);
          process.exit(0);
        }
        docId = found.docId;
      }

      const docFull = await fetchDocFull(docId);
      const r = await saveDoc(docFull);

      console.log(`evotorSales: single-doc mode`);
      console.log(`doc_id=${docId}, type=${docFull?.type}, number=${docFull?.number}`);
      console.log(`positions_in_doc=${Array.isArray(docFull?.body?.positions) ? docFull.body.positions.length : 0}`);
      console.log(`saved=${r.saved}, rows inserted=${r.insertedRows}`);
      process.exit(0);
    }

    if (LOAD_ALL_SALES) {
      console.log('evotorSales: LOAD_ALL_SALES=true → загружаем ВСЕ документы (ONE PASS)');
      const r = await runAll();
      console.log(`evotorSales: done — docs=${r.docs}, rows inserted=${r.insertedRows}`);
      return;
    }

    const last = await getLastCloseDateMs();
    if (!last) {
      console.log('evotorSales: таблица пустая → включи LOAD_ALL_SALES=true для первичной полной загрузки');
      return;
    }

    const since = Math.max(0, last - BACKFILL_MS);
    console.log(`evotorSales: incremental with backfill since=${since} (${new Date(since).toISOString()})`);

    const r = await runIncremental(since);
    console.log(`evotorSales: done — docs=${r.docs}, rows inserted=${r.insertedRows}`);
  } catch (err) {
    console.error('evotorSales error:', err?.message || String(err));
  }
})();
