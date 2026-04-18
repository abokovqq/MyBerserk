// /src/tools/evotorPaybackLoadAll.mjs
// Заливка документов PAYBACK в evotor_sales через STORE endpoint:
// GET /stores/{store-id}/documents?type=PAYBACK
// Без DEVICE_ID / DEVICE_ID_OLD. Без инкрементальной логики по базе.

import '../env.js';
import { q } from '../db.js';

const API_BASE = 'https://api.evotor.ru';

const STORE_ID = process.env.STORE_ID;
const TOKEN    = process.env.EVOTOR_ACCESS_TOKEN;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Отсутствует ${name} в .env`);
    process.exit(1);
  }
}

requireEnv('STORE_ID', STORE_ID);
requireEnv('EVOTOR_ACCESS_TOKEN', TOKEN);

const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  if (!found) return def;
  return found.substring(pref.length);
}

// --since=0 (по умолчанию) или --since=1760000000000 или --since=2025-11-01
function parseSinceMs() {
  const raw = getArg('since', null);
  if (raw === null || raw === '') return 0;

  if (/^\d+$/.test(raw)) return Number(raw);

  const d = new Date(raw);
  const ms = d.getTime();
  if (Number.isNaN(ms)) {
    console.error(`Неверный --since=${raw}. Используй ms или дату (например 2025-11-01).`);
    process.exit(1);
  }
  return ms;
}

async function fetchPage({ since, cursor }) {
  const p = new URLSearchParams();

  if (cursor) {
    p.set('cursor', cursor);
  } else {
    p.set('since', String(since));
  }

  p.set('type', 'PAYBACK');

  const url = `${API_BASE}/stores/${STORE_ID}/documents?` + p.toString();

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Authorization': TOKEN,
      'Accept': 'application/vnd.evotor.v2+json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Evotor error (store=${STORE_ID}): ${res.status} ${res.statusText}\n${text}`);
  }

  const data = await res.json();

  if (!Array.isArray(data.items)) {
    throw new Error('Ответ Эвотор не содержит items[]');
  }

  return {
    items: data.items,
    next: data.next_cursor || null,
  };
}

async function savePayback(doc) {
  if (!doc || doc.type !== 'PAYBACK') return 0;

  const body = doc.body || {};
  const positions = Array.isArray(body.positions) ? body.positions : [];
  if (positions.length === 0) return 0;

  const payments = Array.isArray(body.payments) ? body.payments : [];

  function resolvePaymentTypeForPosition(p) {
    if (!payments.length) return null;

    const pgId = p.print_group_id || null;
    let relevant = payments;

    if (pgId) {
      const byPrintGroup = payments.filter(pay => pay?.print_group_id === pgId);
      if (byPrintGroup.length) relevant = byPrintGroup;
    }

    for (const pay of relevant) {
      if (pay && pay.type) return pay.type;
    }
    for (const pay of payments) {
      if (pay && pay.type) return pay.type;
    }
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
      doc.device_id || null,          // теперь приходит из doc (может быть старый/новый)
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

  await q(sql, [values]);
  return values.length;
}

(async () => {
  try {
    const since = parseSinceMs(); // default 0
    console.log(`evotorPaybackLoadAll: start store=${STORE_ID} since=${since} (${new Date(since).toISOString()})`);

    let cursor = null;
    let totalDocs = 0;
    let totalPositions = 0;

    while (true) {
      const { items, next } = await fetchPage({ since, cursor });
      totalDocs += items.length;

      for (const doc of items) {
        totalPositions += await savePayback(doc);
      }

      if (!next) break;
      cursor = next;
    }

    console.log(
      `evotorPaybackLoadAll: done — docs=${totalDocs}, positions inserted (attempted)=${totalPositions}`
    );
  } catch (err) {
    console.error('evotorPaybackLoadAll error:', err.message);
    process.exitCode = 1;
  }
})();
