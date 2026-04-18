// /src/workers/evotorZRefundBackfill.mjs

import '../env.js';
import { q } from '../db.js';

const API_BASE = 'https://api.evotor.ru';

const STORE_ID  = process.env.STORE_ID;
const DEVICE_ID = process.env.DEVICE_ID;
const TOKEN     = process.env.EVOTOR_ACCESS_TOKEN;

function requireEnv(name, value) {
  if (!value) {
    console.error(`evotorZRefundBackfill: отсутствует ${name} в .env`);
    process.exit(1);
  }
}

requireEnv('STORE_ID', STORE_ID);
requireEnv('DEVICE_ID', DEVICE_ID);
requireEnv('EVOTOR_ACCESS_TOKEN', TOKEN);

// ====== одна страница Z_REPORT из Эвотора ======
async function fetchPage({ cursor }) {
  const p = new URLSearchParams();

  if (cursor) {
    p.set('cursor', cursor);
  }

  // берем только Z_REPORT
  p.set('type', 'Z_REPORT');

  const url =
    `${API_BASE}/stores/${STORE_ID}/devices/${DEVICE_ID}/documents?` +
    p.toString();

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Authorization': TOKEN,
      'Accept': 'application/vnd.evotor.v2+json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `evotorZRefundBackfill: HTTP ${res.status} ${res.statusText}\n${text}`
    );
  }

  const data = await res.json();

  if (!Array.isArray(data.items)) {
    throw new Error('evotorZRefundBackfill: ожидали data.items массив');
  }

  return {
    items: data.items,
    next: data.next_cursor || null,
  };
}

// аккуратный парсер возвратов из body.sales_back
function extractRefunds(body) {
  const b = body || {};

  // общая сумма возвратов продаж
  const total = typeof b.sales_back?.summ === 'number'
    ? b.sales_back.summ
    : 0;

  let cash = 0;
  let electron = 0;

  const sections = Array.isArray(b.sales_back?.sections)
    ? b.sales_back.sections
    : [];

  for (const s of sections) {
    if (!s) continue;

    const name = s.name;
    const num  = s.number;
    const val  = typeof s.value === 'number' ? s.value : 0;

    // НАЛИЧНЫМИ
    if (name === 'НАЛИЧНЫМИ' || num === 1) {
      cash = val;
    }

    // БЕЗНАЛИЧНЫМИ / ПЛАТ.КАРТОЙ
    if (name === 'БЕЗНАЛИЧНЫМИ' || name === 'ПЛАТ.КАРТОЙ' || num === 2) {
      electron = val;
    }
  }

  return {
    total,
    cash,
    electron,
  };
}

// ====== обновление одной строки в evotor_z_reports ======
async function updateRefundsForDoc(doc) {
  const body = doc.body || {};
  const refunds = extractRefunds(body);

  const sql = `
    UPDATE evotor_z_reports
       SET z_refund_total    = ?,
           z_refund_cash     = ?,
           z_refund_electron = ?
     WHERE evotor_doc_id = ?
     LIMIT 1
  `;

  const res = await q(sql, [
    refunds.total,
    refunds.cash,
    refunds.electron,
    doc.id,
  ]);

  const affected =
    res && typeof res.affectedRows === 'number'
      ? res.affectedRows
      : 0;

  return affected;
}

// ====== основной цикл ======
(async () => {
  try {
    let cursor = null;
    let docsSeen = 0;
    let rowsUpdated = 0;

    console.log('evotorZRefundBackfill: старт');

    while (true) {
      const { items, next } = await fetchPage({ cursor });

      if (!items.length && !next) break;

      for (const doc of items) {
        docsSeen++;
        try {
          const updated = await updateRefundsForDoc(doc);
          rowsUpdated += updated;
        } catch (e) {
          console.error(
            `evotorZRefundBackfill: ошибка при обновлении doc_id=${doc.id}:`,
            e.message
          );
        }
      }

      if (!next) break;
      cursor = next;
    }

    console.log(
      `evotorZRefundBackfill: done — docs_seen=${docsSeen}, rows_updated=${rowsUpdated}`
    );
  } catch (err) {
    console.error('evotorZRefundBackfill: fatal error:', err.message);
  } finally {
    process.exit(0);
  }
})();
