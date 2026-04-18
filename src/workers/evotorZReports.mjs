// /src/workers/evotorZReports.mjs

import '../env.js';
import { q } from '../db.js';

const API_BASE = 'https://api.evotor.ru';

const STORE_ID  = process.env.STORE_ID;
const DEVICE_ID = process.env.DEVICE_ID;
const TOKEN     = process.env.EVOTOR_ACCESS_TOKEN;

// Если LOAD_ALL_Z=true → игнорируем last close_date и тянем все Z_REPORT
const LOAD_ALL_Z =
  String(process.env.LOAD_ALL_Z || '').toLowerCase() === 'true';

function requireEnv(name, value) {
  if (!value) {
    console.error(`Отсутствует ${name} в .env`);
    process.exit(1);
  }
}

requireEnv('STORE_ID', STORE_ID);
requireEnv('DEVICE_ID', DEVICE_ID);
requireEnv('EVOTOR_ACCESS_TOKEN', TOKEN);

// ====== берем последнюю дату Z-отчета в ms ======
async function getLastZDateMs() {
  const rows = await q(`
    SELECT UNIX_TIMESTAMP(MAX(close_date)) * 1000 AS ts
    FROM evotor_z_reports
  `);
  return rows[0]?.ts ? Number(rows[0].ts) : null;
}

// ====== одна страница Z_REPORT из Эвотора ======
async function fetchPage({ since, cursor }) {
  const p = new URLSearchParams();

  if (cursor) {
    p.set('cursor', cursor);
  } else if (since) {
    p.set('since', since);
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
      `evotorZReports: HTTP ${res.status} ${res.statusText}\n${text}`
    );
  }

  const data = await res.json();

  if (!Array.isArray(data.items)) {
    throw new Error('evotorZReports: ожидали data.items массив');
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

// ====== сохраняем один Z_REPORT ======
async function saveZ(doc) {
  const body = doc.body || {};

  // --------- Маппинг сумм продаж ---------
  // общие суммы
  const zTotal   = body.total   ?? body.proceeds ?? body.revenue ?? 0;
  const zRevenue = body.revenue ?? body.proceeds ?? body.total   ?? 0;

  // продажи: наличные и безнал
  let cash     = body.cash ?? 0;
  let electron = 0;

  if (Array.isArray(body.sales?.sections)) {
    for (const s of body.sales.sections) {
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
  }

  // количество чеков
  const zSellCount   = body.quantity_sales?.quantity ?? 0;
  const zReturnCount = body.quantity_sales?.back ?? 0;

  // ===== ДОП. ИНФО О ВОЗВРАТАХ ПРОДАЖ =====
  const refunds = extractRefunds(body);
  const zRefundTotal    = refunds.total;
  const zRefundCash     = refunds.cash;
  const zRefundElectron = refunds.electron;

  // фискальные данные — у тебя прямо в body, а не в pos_print_results
  const fiscalDocumentNumber  = body.fiscal_document_number ?? null;
  const fiscalSignDocNumber   = body.fiscal_sign_doc_number ?? null;
  const fnSerialNumber        = body.fn_serial_number ?? null;
  const kktSerialNumber       = body.kkt_serial_number ?? null;
  const kktRegNumber          = body.kkt_reg_number ?? null;

  const sql = `
    INSERT IGNORE INTO evotor_z_reports (
      evotor_doc_id,
      evotor_number,
      close_date,
      time_zone_offset,
      session_id,
      session_number,
      device_id,
      store_id,
      user_id,
      z_total,
      z_revenue,
      z_cash,
      z_electron,
      z_sell_count,
      z_return_count,
      z_refund_total,
      z_refund_cash,
      z_refund_electron,
      fiscal_document_number,
      fiscal_sign_doc_number,
      fn_serial_number,
      kkt_serial_number,
      kkt_reg_number,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  await q(sql, [
    doc.id,
    doc.number,
    doc.close_date ? new Date(doc.close_date) : null,
    doc.time_zone_offset ?? 0,
    doc.session_id || null,
    doc.session_number ?? null,
    doc.device_id || null,
    doc.store_id || null,
    doc.user_id || null,

    zTotal,
    zRevenue,
    cash,
    electron,
    zSellCount,
    zReturnCount,
    zRefundTotal,
    zRefundCash,
    zRefundElectron,
    fiscalDocumentNumber,
    fiscalSignDocNumber,
    fnSerialNumber,
    kktSerialNumber,
    kktRegNumber,
    doc.created_at ? new Date(doc.created_at) : new Date(),
  ]);

  return 1;
}

// ====== основной цикл ======
(async () => {
  try {
    let since = null;

    if (!LOAD_ALL_Z) {
      const last = await getLastZDateMs();
      if (last) {
        since = last + 1;
        console.log(
          `evotorZReports: incremental since=${since} (${new Date(
            since
          ).toISOString()})`
        );
      } else {
        console.log('evotorZReports: таблица пуста → первая полная загрузка');
      }
    } else {
      console.log(
        'evotorZReports: LOAD_ALL_Z=true → полная загрузка всех Z_REPORT'
      );
    }

    let cursor = null;
    let totalDocs = 0;
    let totalSaved = 0;

    while (true) {
      const { items, next } = await fetchPage({ since, cursor });

      totalDocs += items.length;

      for (const doc of items) {
        totalSaved += await saveZ(doc);
      }

      if (!next) break;
      cursor = next;
    }

    console.log(
      `evotorZReports: done — docs=${totalDocs}, inserted (attempted)=${totalSaved}`
    );
  } catch (err) {
    console.error('evotorZReports error:', err.message);
  }
})();
