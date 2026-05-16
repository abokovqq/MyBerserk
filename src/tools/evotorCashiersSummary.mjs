// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorCashiersSummary.mjs

import '../env.js';

const API_BASE = 'https://api.evotor.ru';

const STORE_ID      = process.env.STORE_ID;
const DEVICE_ID     = process.env.DEVICE_ID;
const DEVICE_ID_OLD = process.env.DEVICE_ID_OLD;
const TOKEN         = process.env.EVOTOR_ACCESS_TOKEN;

const TZ = process.env.TZ || 'Europe/Moscow';

const ALLOWED_TYPES = new Set(['SELL', 'PAYBACK']);

const HARD_LIMIT_GUARD = 1000;

const PROGRESS_EVERY_DOCS = 50;
const PROGRESS_EVERY_MS   = 15_000;

// -------------------- argv --------------------

const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  return found ? found.slice(pref.length) : def;
}

const DEBUG_CASHIER = argv.includes('--debug-cashier');
const ONLY_DEVICE = getArg('device', 'all'); // all|new|old

// -------------------- env --------------------

function requireEnv(name, value) {
  if (!value) {
    console.error(`Отсутствует ${name} в .env`);
    process.exit(1);
  }
}

requireEnv('STORE_ID', STORE_ID);
requireEnv('DEVICE_ID', DEVICE_ID);
requireEnv('DEVICE_ID_OLD', DEVICE_ID_OLD);
requireEnv('EVOTOR_ACCESS_TOKEN', TOKEN);

let DEVICES = [
  { key: 'new', title: 'NEW', deviceId: DEVICE_ID },
  { key: 'old', title: 'OLD', deviceId: DEVICE_ID_OLD },
];

if (ONLY_DEVICE !== 'all') {
  DEVICES = DEVICES.filter(d => d.key === ONLY_DEVICE);
  if (!DEVICES.length) {
    console.error(`Некорректный --device=${ONLY_DEVICE}. Нужно all|new|old`);
    process.exit(1);
  }
}

// -------------------- utils --------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function toMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function fmtDate(ms) {
  if (!ms) return '-';

  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));

  const p = {};
  for (const x of parts) {
    if (x.type !== 'literal') p[x.type] = x.value;
  }

  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function pickString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function normalizeName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// -------------------- throttling --------------------

let requestDelayMs = 600;

const REQUEST_DELAY_MIN = 250;
const REQUEST_DELAY_MAX = 600_000;

let cooldownUntilTs = 0;

// -------------------- Evotor API --------------------

async function evotorGet(url, attempt = 1) {
  const now = Date.now();

  if (cooldownUntilTs > now) {
    await sleep(cooldownUntilTs - now);
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
    const remaining  = res.headers?.get?.('x-ratelimit-remaining') || '';
    const resetRaw   = res.headers?.get?.('x-ratelimit-reset') || '';
    const retryAfter = res.headers?.get?.('retry-after') || '';
    const raw        = await res.text().catch(() => '');

    console.error('================ EVOTOR 429 RAW =================');
    console.error(`url: ${url}`);
    if (remaining) console.error(`x-ratelimit-remaining: ${remaining}`);
    if (resetRaw) console.error(`x-ratelimit-reset: ${resetRaw}`);
    if (retryAfter) console.error(`retry-after: ${retryAfter}`);
    console.error('----- body -----');
    console.error(raw || '(empty body)');
    console.error('=================================================');

    if (attempt === 1) {
      const resetSec = Number(resetRaw);

      const baseMs = Number.isFinite(resetSec) && resetSec > 0
        ? resetSec * 1000
        : 20 * 60 * 1000;

      const waitMs = baseMs + 2 * 60 * 1000;

      cooldownUntilTs = Date.now() + waitMs;

      console.warn(
        `Evotor 429: wait ${Math.ceil(waitMs / 1000)}s then retry 1/1 ` +
        `(cooldown until ${new Date(cooldownUntilTs).toISOString()})`
      );

      await sleep(waitMs);
      return evotorGet(url, 2);
    }

    throw new Error('Evotor error: 429 Too Many Requests повторно, стоп');
  }

  if (res.status === 503 && attempt <= 3) {
    const backoff = 2000 * attempt;
    console.warn(`Evotor 503, retry ${attempt}/3, sleep=${backoff}ms`);
    await sleep(backoff);
    return evotorGet(url, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Evotor error: ${res.status} ${res.statusText}\n${text}`);
  }

  if (cooldownUntilTs && cooldownUntilTs <= Date.now()) {
    cooldownUntilTs = 0;
  }

  requestDelayMs = clamp(requestDelayMs - 10, REQUEST_DELAY_MIN, REQUEST_DELAY_MAX);

  return await res.json();
}

// -------------------- URL --------------------

function listDocsUrl(deviceId, { until, cursor }) {
  const p = new URLSearchParams();

  if (cursor) {
    p.set('cursor', cursor);
  } else if (until != null) {
    p.set('until', String(until));
  }

  return `${API_BASE}/stores/${STORE_ID}/devices/${deviceId}/documents?${p.toString()}`;
}

function docFullUrl(deviceId, docId) {
  return `${API_BASE}/stores/${STORE_ID}/devices/${deviceId}/documents/${docId}`;
}

// -------------------- fetchers --------------------

async function fetchPage(deviceId, { until, cursor }) {
  const url = listDocsUrl(deviceId, { until, cursor });
  const data = await evotorGet(url);

  if (!Array.isArray(data.items)) {
    throw new Error('Ответ Эвотор не содержит items[]');
  }

  return {
    items: data.items,
    next: data?.paging?.next_cursor || null,
  };
}

async function fetchDocFull(deviceId, docId) {
  return await evotorGet(docFullUrl(deviceId, docId));
}

// -------------------- cashier extraction --------------------

function extractCashier(doc) {
  const body = doc?.body || {};

  const name = pickString(
    doc?.cashier_name,
    doc?.cashierName,
    doc?.user_name,
    doc?.userName,
    doc?.close_user_name,
    doc?.closeUserName,

    doc?.cashier?.name,
    doc?.user?.name,
    doc?.close_user?.name,
    doc?.closeUser?.name,
    doc?.employee?.name,
    doc?.operator?.name,

    body?.cashier_name,
    body?.cashierName,
    body?.user_name,
    body?.userName,
    body?.close_user_name,
    body?.closeUserName,
    body?.operator_name,
    body?.operatorName,

    body?.cashier?.name,
    body?.user?.name,
    body?.close_user?.name,
    body?.closeUser?.name,
    body?.employee?.name,
    body?.operator?.name,
    body?.seller?.name
  );

  if (name) {
    return normalizeName(name);
  }

  const id = pickString(
    doc?.close_user_id,
    doc?.closeUserId,
    doc?.user_id,
    doc?.userId,

    body?.close_user_id,
    body?.closeUserId,
    body?.user_id,
    body?.userId,
    body?.operator_id,
    body?.operatorId,
    body?.cashier_id,
    body?.cashierId
  );

  if (id) {
    return `ID:${id}`;
  }

  return '(кассир не найден)';
}

function debugCashierFields(doc, cashierName) {
  if (!DEBUG_CASHIER) return;

  const body = doc?.body || {};

  console.log('---------------- CASHIER DEBUG ----------------');
  console.log(`doc_id=${doc?.id}`);
  console.log(`number=${doc?.number}`);
  console.log(`type=${doc?.type}`);
  console.log(`close_date=${doc?.close_date}`);
  console.log(`resolved_cashier=${cashierName}`);
  console.log('doc.close_user_id =', doc?.close_user_id);
  console.log('doc.user_id       =', doc?.user_id);
  console.log('doc.close_user    =', doc?.close_user);
  console.log('doc.user          =', doc?.user);
  console.log('doc.cashier       =', doc?.cashier);
  console.log('doc.operator      =', doc?.operator);
  console.log('body.close_user_id =', body?.close_user_id);
  console.log('body.user_id       =', body?.user_id);
  console.log('body.close_user    =', body?.close_user);
  console.log('body.user          =', body?.user);
  console.log('body.cashier       =', body?.cashier);
  console.log('body.operator      =', body?.operator);
  console.log('------------------------------------------------');
}

// -------------------- aggregation --------------------

const summary = new Map();
const seenDocs = new Set();

function addDocToSummary(doc, deviceTitle) {
  if (!doc || !ALLOWED_TYPES.has(String(doc.type || '').toUpperCase())) return;

  if (seenDocs.has(doc.id)) return;
  seenDocs.add(doc.id);

  const closeMs = toMs(doc.close_date);
  if (!closeMs) return;

  const cashier = extractCashier(doc);
  debugCashierFields(doc, cashier);

  if (!summary.has(cashier)) {
    summary.set(cashier, {
      name: cashier,
      firstMs: closeMs,
      lastMs: closeMs,
      checks: 0,
      devices: new Set(),
    });
  }

  const row = summary.get(cashier);

  row.firstMs = Math.min(row.firstMs, closeMs);
  row.lastMs  = Math.max(row.lastMs, closeMs);
  row.checks += 1;
  row.devices.add(deviceTitle);
}

// -------------------- progress --------------------

class Progress {
  constructor(label) {
    this.label = label;
    this.startedAt = Date.now();
    this.lastLogAt = 0;
    this.docs = 0;
    this.saved = 0;
    this.skipped = 0;
    this.pages = 0;
  }

  tick({ saved = false, skipped = false } = {}) {
    this.docs += 1;
    if (saved) this.saved += 1;
    if (skipped) this.skipped += 1;

    const now = Date.now();
    const byDocs = this.docs % PROGRESS_EVERY_DOCS === 0;
    const byTime = now - this.lastLogAt >= PROGRESS_EVERY_MS;

    if (byDocs || byTime) {
      this.log();
      this.lastLogAt = now;
    }
  }

  log() {
    const elapsedSec = Math.max(1, (Date.now() - this.startedAt) / 1000);
    const rate = this.docs / elapsedSec;

    console.log(
      `[progress ${this.label}] docs=${this.docs}, sell/payback=${this.saved}, skipped=${this.skipped}, ` +
      `pages=${this.pages}, rate=${rate.toFixed(2)} docs/s, delay=${requestDelayMs}ms`
    );
  }
}

// -------------------- run device --------------------

async function runDevice(device) {
  console.log('');
  console.log(`========== DEVICE ${device.title}: ${device.deviceId} ==========`);

  const prog = new Progress(device.title);

  let until = Date.now() + 1;
  let totalDocs = 0;
  let totalAllowed = 0;

  while (true) {
    let cursor = null;
    let batchDocs = 0;
    let minCloseMs = null;

    while (true) {
      const { items, next } = await fetchPage(device.deviceId, { until, cursor });

      prog.pages += 1;
      batchDocs += items.length;

      for (const item of items) {
        const itemType = String(item?.type || '').toUpperCase();

        const itemCloseMs = toMs(item?.close_date);
        if (itemCloseMs != null) {
          minCloseMs = minCloseMs == null ? itemCloseMs : Math.min(minCloseMs, itemCloseMs);
        }

        if (!ALLOWED_TYPES.has(itemType)) {
          prog.tick({ skipped: true });
          continue;
        }

        const fullDoc = await fetchDocFull(device.deviceId, item.id);
        addDocToSummary(fullDoc, device.title);

        totalAllowed += 1;
        prog.tick({ saved: true });
      }

      if (!next) break;
      cursor = next;
    }

    totalDocs += batchDocs;

    if (batchDocs === 0) break;

    if (batchDocs >= HARD_LIMIT_GUARD && minCloseMs != null) {
      until = minCloseMs - 1;
      console.log(
        `evotorCashiersSummary: ${device.title} continue older, until=${until} ` +
        `(${new Date(until).toISOString()})`
      );
      continue;
    }

    break;
  }

  prog.log();

  console.log(
    `DEVICE ${device.title}: всего документов=${totalDocs}, чеков SELL/PAYBACK=${totalAllowed}`
  );
}

// -------------------- table output --------------------

function pad(value, width) {
  const s = String(value ?? '');
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function printSummary() {
  const rows = [...summary.values()]
    .sort((a, b) => {
      if (a.firstMs !== b.firstMs) return a.firstMs - b.firstMs;
      return a.name.localeCompare(b.name, 'ru');
    })
    .map(x => ({
      name: x.name,
      first: fmtDate(x.firstMs),
      last: fmtDate(x.lastMs),
      checks: x.checks,
      devices: [...x.devices].join(','),
    }));

  console.log('');
  console.log('================ СВОД КАССИРОВ ================');

  if (!rows.length) {
    console.log('Нет данных.');
    return;
  }

  const cols = [
    { key: 'name',   title: 'ИМЯ' },
    { key: 'first',  title: 'ДАТА 1 ЧЕКА' },
    { key: 'last',   title: 'ДАТА ПОСЛЕДНЕГО ЧЕКА' },
    { key: 'checks', title: 'ЧЕКОВ' },
    { key: 'devices', title: 'УСТР.' },
  ];

  const widths = {};

  for (const col of cols) {
    widths[col.key] = col.title.length;
  }

  for (const row of rows) {
    for (const col of cols) {
      widths[col.key] = Math.max(widths[col.key], String(row[col.key] ?? '').length);
    }
  }

  const header = cols.map(c => pad(c.title, widths[c.key])).join(' | ');
  const line = cols.map(c => '-'.repeat(widths[c.key])).join('-+-');

  console.log(header);
  console.log(line);

  for (const row of rows) {
    console.log(cols.map(c => pad(row[c.key], widths[c.key])).join(' | '));
  }

  console.log('');
  console.log(`Всего кассиров: ${rows.length}`);
  console.log(`Всего чеков SELL/PAYBACK: ${seenDocs.size}`);
}

// -------------------- main --------------------

(async () => {
  try {
    console.log('evotorCashiersSummary: start');
    console.log(`STORE_ID=${STORE_ID}`);
    console.log(`TZ=${TZ}`);
    console.log(`devices=${DEVICES.map(d => `${d.title}:${d.deviceId}`).join(', ')}`);

    for (const device of DEVICES) {
      await runDevice(device);
    }

    printSummary();

    console.log('evotorCashiersSummary: done');
  } catch (err) {
    console.error('evotorCashiersSummary error:', err?.stack || err?.message || String(err));
    process.exit(1);
  }
})();