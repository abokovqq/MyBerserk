// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/evotorOfd.mjs
import '../env.js';
import { q } from '../db.js';

const TOKEN     = process.env.EVOTOR_ACCESS_TOKEN;
const STORE_ID  = process.env.STORE_ID;
const DEVICE_ID = process.env.DEVICE_ID; // для связки/логов, в запросе OFD не нужен
const API_BASE  = (process.env.API_URL || 'https://api.evotor.ru').replace(/\/+$/, '');

const OFD_ENABLED = String(process.env.EVOTOR_OFD_ENABLED || 'true').toLowerCase() === 'true';

if (!OFD_ENABLED) {
  console.log('evotorOfdWorker: disabled via EVOTOR_OFD_ENABLED');
  process.exit(0);
}

if (!TOKEN || !STORE_ID || !DEVICE_ID) {
  console.log('evotorOfdWorker: missing .env variables (EVOTOR_ACCESS_TOKEN/STORE_ID/DEVICE_ID)');
  process.exit(0);
}

async function fetchOfdDocuments() {
  const days = Number(process.env.EVOTOR_OFD_DAYS || 7);

  const now = new Date();
  const fromDate = new Date(now.getTime() - days * 86400 * 1000);

  function formatISOEvotor(d) {
    const pad = n => String(n).padStart(2, '0');

    const Y = d.getFullYear();
    const M = pad(d.getMonth() + 1);
    const D = pad(d.getDate());
    const h = pad(d.getHours());
    const m = pad(d.getMinutes());
    const s = pad(d.getSeconds());

    // ВАЖНО: T и +03:00
    return `${Y}-${M}-${D}T${h}:${m}:${s}+03:00`;
  }

  const from = formatISOEvotor(fromDate);
  const to   = formatISOEvotor(now);

  const url =
    `${API_BASE}/api/v1/ofd/documents/${STORE_ID}` +
    `?deviceId=${encodeURIComponent(DEVICE_ID)}` +
    `&from=${encodeURIComponent(from)}` +
    `&to=${encodeURIComponent(to)}` +
    `&type=SELL`;

  console.log('evotorOfdWorker: GET', url);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Authorization': TOKEN,
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`evotorOfdWorker: OFD request failed: ${res.status} ${text}`);
  }

  return res.json();
}




async function run() {
  console.log('evotorOfdWorker: start, STORE_ID =', STORE_ID, 'DEVICE_ID =', DEVICE_ID);

  const json = await fetchOfdDocuments();

  if (!json || !Array.isArray(json.data) || !json.data.length) {
    console.log('evotorOfdWorker: no data in response');
    return;
  }

  let docs = 0;
  let itemsTotal = 0;

  for (const doc of json.data) {
    // защита от кривых ответов
    if (!doc.fiscalDriveNumber || !doc.fiscalDocumentNumber) {
      console.log('evotorOfdWorker: skip doc without FN/FD:', doc.rqId);
      continue;
    }

    // проверяем, нет ли уже такого документа
    const existing = await q(
      `SELECT id
         FROM ofd_receipts
        WHERE fiscal_drive = ?
          AND fiscal_doc   = ?`,
      [doc.fiscalDriveNumber, doc.fiscalDocumentNumber]
    );

    if (existing.length) continue;

    // вставляем чек
    const r = await q(
      `INSERT INTO ofd_receipts (
          fiscal_drive,
          fiscal_doc,
          receipt_date,
          shift_number,
          request_number,
          total_sum,
          cash_sum,
          ecash_sum,
          operation_type,
          taxation_type,
          operator_name,
          receipt_code,
          user_inn,
          user_name,
          rq_id,
          store_id,
          device_id
        ) VALUES (
          ?, ?, STR_TO_DATE(?, '%Y.%m.%d %H:%i:%s.%f'),
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`,
      [
        doc.fiscalDriveNumber,
        doc.fiscalDocumentNumber,
        doc.receiptDate,
        doc.shiftNumber || null,
        doc.requestNumber || null,
        doc.totalSum || 0,
        doc.cashTotalSum || 0,
        doc.ecashTotalSum || 0,
        doc.operationType || null,
        doc.taxationType || null,
        doc.operator || null,
        doc.receiptCode || null,
        doc.userInn || null,
        doc.user || null,
        doc.rqId || null,
        STORE_ID,
        DEVICE_ID
      ]
    );

    const receiptId = r.insertId;

    // позиции чека
    for (const item of doc.items || []) {
      await q(
        `INSERT INTO ofd_receipt_items (
            receipt_id,
            name,
            barcode,
            quantity,
            price,
            sum,
            nds_no
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          receiptId,
          item.name || '',
          item.barcode || '',
          item.quantity || 0,
          item.price || 0,
          item.sum || 0,
          item.ndsNo || 0
        ]
      );
      itemsTotal++;
    }

    docs++;
  }

  console.log(`evotorOfdWorker: imported docs=${docs}, items=${itemsTotal}`);
}

run().catch(err => {
  console.error('evotorOfdWorker error:', err);
  process.exit(1);
});
