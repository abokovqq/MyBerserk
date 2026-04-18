// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorLastSell.mjs
// Универсальная проверка подгрузки Evotor -> SQL по номеру документа (любой type)

import '../env.js';
import { q } from '../db.js';
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

function getDocNumberArg() {
  const byFlag =
    getArg('doc', null) ??
    getArg('number', null) ??
    getArg('sell', null); // оставим совместимость со старым названием

  if (byFlag !== null && String(byFlag).trim() !== '') return String(byFlag).trim();

  const pos = argv.find(a => !String(a).startsWith('--'));
  if (pos && String(pos).trim() !== '') return String(pos).trim();

  return null;
}

// ------------------- EVOTOR FETCH -------------------

async function fetchDocuments() {
  const url = `${API_BASE}/stores/${STORE_ID}/devices/${DEVICE_ID}/documents`;

  const res = await fetch(url, {
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

  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.documents)) return data.documents;

  throw new Error('Неожиданный формат ответа от Эвотор (не нашли массив документов)');
}

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

function findLastDoc(docs) {
  if (!docs.length) return null;
  const arr = [...docs];
  arr.sort((a, b) => docTs(b) - docTs(a));
  return arr[0] || null;
}

function findDocByNumber(docs, number) {
  const target = String(number).trim();

  const exact = docs.find(d => String(d.number ?? '').trim() === target);
  if (exact) return exact;

  const tNum = Number(target);
  if (!Number.isNaN(tNum)) {
    const byNum = docs.find(d => Number(d.number) === tNum);
    if (byNum) return byNum;
  }
  return null;
}

// ------------------- PRETTY PRINT API DOC -------------------

function fmtDate(d) {
  if (!d) return '';
  try {
    const dt = (d instanceof Date) ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toISOString().replace('T', ' ').replace('Z', 'Z');
  } catch {
    return String(d);
  }
}

function printDocFromApi(doc) {
  console.log('');
  console.log('='.repeat(110));
  console.log(`EVOTOR DOC (из API) №${doc.number} | id=${doc.id} | type=${doc.type}`);
  console.log('='.repeat(110));
  console.log(`close_date        : ${fmtDate(doc.close_date)}`);
  console.log(`created_at        : ${fmtDate(doc.created_at)}`);
  console.log(`time_zone_offset  : ${doc.time_zone_offset ?? ''}`);
  console.log(`session_id        : ${doc.session_id ?? ''}`);
  console.log(`session_number    : ${doc.session_number ?? ''}`);
  console.log(`close_user_id     : ${doc.close_user_id ?? ''}`);
  console.log(`device_id         : ${doc.device_id ?? ''}`);
  console.log(`store_id          : ${doc.store_id ?? ''}`);
  console.log(`user_id           : ${doc.user_id ?? ''}`);
  console.log('');

  const body = doc.body || {};
  console.log('--- body ---');
  console.log(util.inspect(body, { depth: 10, colors: true, maxArrayLength: 300 }));
  console.log('='.repeat(110));
  console.log('');
}

// ------------------- SAVE TO SQL (если есть positions) -------------------

async function saveDocIfHasPositions(doc) {
  const body = doc.body || {};
  const positions = body.positions || [];

  if (!Array.isArray(positions) || positions.length === 0) {
    console.log(`Документ №${doc.number} (type=${doc.type}) без body.positions — в evotor_sales не пишем.`);
    return { saved: false, positions: 0 };
  }

  const paymentsJson        = JSON.stringify(body.payments || []);
  const docDiscountsJson    = JSON.stringify(body.doc_discounts || []);
  const printGroupsJson     = JSON.stringify(body.print_groups || []);
  const posPrintResultsJson = JSON.stringify(body.pos_print_results || []);

  const sql = `
    INSERT INTO evotor_sales (
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
      measure_name,
      quantity,
      price,
      sum,
      discount_sum,
      discount_percent,
      discount_type,
      payments_json,
      doc_discounts_json,
      print_groups_json,
      pos_print_results_json,
      created_at
    ) VALUES ?
    ON DUPLICATE KEY UPDATE
      evotor_type             = VALUES(evotor_type),
      quantity               = VALUES(quantity),
      price                  = VALUES(price),
      sum                    = VALUES(sum),
      discount_sum           = VALUES(discount_sum),
      discount_percent       = VALUES(discount_percent),
      discount_type          = VALUES(discount_type),
      payments_json          = VALUES(payments_json),
      doc_discounts_json     = VALUES(doc_discounts_json),
      print_groups_json      = VALUES(print_groups_json),
      pos_print_results_json = VALUES(pos_print_results_json),
      close_date             = VALUES(close_date),
      updated_at             = CURRENT_TIMESTAMP
  `;

  const values = positions.map(p => {
    const disc = p.doc_distributed_discount || {};
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
      p.measure_name || null,
      p.quantity ?? 0,
      p.price ?? 0,
      p.sum ?? 0,

      disc.discount_sum ?? 0,
      disc.discount_percent ?? 0,
      disc.discount_type || null,

      paymentsJson,
      docDiscountsJson,
      printGroupsJson,
      posPrintResultsJson,

      doc.created_at ? new Date(doc.created_at) : new Date(),
    ];
  });

  await q(sql, [values]);

  console.log(`Сохранили ${positions.length} позиций по документу №${doc.number} (type=${doc.type}, doc_id=${doc.id})`);
  return { saved: true, positions: positions.length };
}

// ------------------- PRINT FROM SQL -------------------

function safeJsonParse(s) {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return t; }
}

function num(x) {
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

async function printDocFromSql(evotorNumber) {
  const rows = await q(
    `
    SELECT
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
      measure_name,
      quantity,
      price,
      sum,
      discount_sum,
      discount_percent,
      discount_type,

      payments_json,
      doc_discounts_json,
      print_groups_json,
      pos_print_results_json,

      created_at,
      updated_at
    FROM evotor_sales
    WHERE evotor_number = ?
    ORDER BY position_id, position_uuid
    `,
    [String(evotorNumber)]
  );

  if (!rows || rows.length === 0) {
    console.log(`В SQL не найдено строк в evotor_sales по evotor_number=${evotorNumber}`);
    return;
  }

  const h = rows[0];

  console.log('');
  console.log('='.repeat(110));
  console.log(`EVOTOR DOC (из SQL evotor_sales) №${h.evotor_number} | doc_id=${h.evotor_doc_id} | type=${h.evotor_type}`);
  console.log('='.repeat(110));
  console.log(`close_date        : ${fmtDate(h.close_date)}`);
  console.log(`time_zone_offset  : ${h.time_zone_offset}`);
  console.log(`session_id        : ${h.session_id ?? ''}`);
  console.log(`session_number    : ${h.session_number ?? ''}`);
  console.log(`close_user_id     : ${h.close_user_id ?? ''}`);
  console.log(`device_id         : ${h.device_id ?? ''}`);
  console.log(`store_id          : ${h.store_id ?? ''}`);
  console.log(`user_id           : ${h.user_id ?? ''}`);
  console.log(`created_at        : ${fmtDate(h.created_at)}`);
  console.log(`updated_at        : ${fmtDate(h.updated_at)}`);
  console.log('');

  const payments = safeJsonParse(h.payments_json) ?? [];
  const docDiscounts = safeJsonParse(h.doc_discounts_json) ?? [];
  const printGroups = safeJsonParse(h.print_groups_json) ?? [];
  const posPrintResults = safeJsonParse(h.pos_print_results_json) ?? [];

  console.log('--- payments_json ---');
  console.log(util.inspect(payments, { depth: 10, colors: true, maxArrayLength: 200 }));
  console.log('');

  console.log('--- doc_discounts_json ---');
  console.log(util.inspect(docDiscounts, { depth: 10, colors: true, maxArrayLength: 200 }));
  console.log('');

  console.log('--- print_groups_json ---');
  console.log(util.inspect(printGroups, { depth: 10, colors: true, maxArrayLength: 200 }));
  console.log('');

  console.log('--- pos_print_results_json ---');
  console.log(util.inspect(posPrintResults, { depth: 10, colors: true, maxArrayLength: 200 }));
  console.log('');

  console.log('--- POSITIONS ---');
  console.log(
    [
      'pos_id'.padStart(6),
      'qty'.padStart(8),
      'price'.padStart(10),
      'sum'.padStart(12),
      'disc_sum'.padStart(10),
      'disc_%'.padStart(7),
      'code'.padEnd(10),
      'name'
    ].join(' | ')
  );
  console.log('-'.repeat(110));

  let totalSum = 0;
  let totalDisc = 0;
  let totalQty = 0;

  for (const r of rows) {
    const qtty = num(r.quantity);
    const pr   = num(r.price);
    const sm   = num(r.sum);
    const ds   = num(r.discount_sum);
    const dp   = num(r.discount_percent);

    totalQty += qtty;
    totalSum += sm;
    totalDisc += ds;

    console.log(
      [
        String(r.position_id ?? '').padStart(6),
        qtty.toFixed(3).padStart(8),
        pr.toFixed(2).padStart(10),
        sm.toFixed(2).padStart(12),
        ds.toFixed(2).padStart(10),
        dp.toFixed(2).padStart(7),
        String(r.product_code ?? '').slice(0, 10).padEnd(10),
        String(r.product_name ?? '')
      ].join(' | ')
    );
  }

  console.log('-'.repeat(110));
  console.log(`ИТОГО позиций: ${rows.length}`);
  console.log(`ИТОГО qty     : ${totalQty.toFixed(3)}`);
  console.log(`ИТОГО sum     : ${totalSum.toFixed(2)}`);
  console.log(`ИТОГО discount: ${totalDisc.toFixed(2)}`);
  console.log(`ИТОГО (sum-discount): ${(totalSum - totalDisc).toFixed(2)}`);
  console.log('='.repeat(110));
  console.log('');
}

// ------------------- MAIN -------------------

(async () => {
  try {
    const docNumber = getDocNumberArg();
    const docs = await fetchDocuments();

    if (!docs.length) {
      console.log('Документы не найдены (пустой список Evotor documents).');
      return;
    }

    const doc = docNumber ? findDocByNumber(docs, docNumber) : findLastDoc(docs);

    if (!doc) {
      console.log(docNumber
        ? `Документ с номером ${docNumber} не найден в Evotor documents.`
        : 'Не удалось определить последний документ.');
      if (docNumber) await printDocFromSql(docNumber);
      return;
    }

    // всегда показываем, что пришло из API
    printDocFromApi(doc);

    // пишем в SQL только если есть позиции
    const { saved } = await saveDocIfHasPositions(doc);

    // если сохранили — выводим всю инфу из SQL (проверка подгрузки)
    if (saved) {
      await printDocFromSql(doc.number);
    }
  } catch (err) {
    console.error('Ошибка выполнения скрипта:', err?.message || err);
  }
})();
