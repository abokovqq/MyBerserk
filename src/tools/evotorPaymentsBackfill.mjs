// /src/tools/evotorPaymentsBackfill.mjs

import '../env.js';
import { q } from '../db.js';

const API_BASE = 'https://api.evotor.ru';

const STORE_ID  = process.env.STORE_ID;
const DEVICE_ID = process.env.DEVICE_ID;
const TOKEN     = process.env.EVOTOR_ACCESS_TOKEN;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Отсутствует ${name} в .env`);
    process.exit(1);
  }
}

requireEnv('STORE_ID', STORE_ID);
requireEnv('DEVICE_ID', DEVICE_ID);
requireEnv('EVOTOR_ACCESS_TOKEN', TOKEN);

// --- Загрузка страниц SELL-документов из Эвотора ---

async function fetchPage({ since, cursor }) {
  const p = new URLSearchParams();

  if (cursor) {
    p.set('cursor', cursor);
  } else if (since) {
    p.set('since', since);
  }

  // сразу просим только SELL
  p.set('type', 'SELL');

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
    throw new Error(`Evotor error: ${res.status} ${res.statusText}\n${text}`);
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

// --- Определение типа платежа для конкретной позиции ---

/**
 * payments  — массив body.payments из документа
 * p         — позиция (body.positions[i])
 *
 * Правила:
 *  - если есть print_group_id у позиции — сначала ищем платежи с тем же print_group_id
 *  - из найденных берём первый ненулевой type
 *  - если по print_group_id не нашли — берём первый ненулевой type из всех payments
 *  - если нет ни одного type — возвращаем null
 */
function resolvePaymentTypeForPosition(payments, p) {
  if (!Array.isArray(payments) || payments.length === 0) return null;

  const pgId = p.print_group_id || null;
  let relevant = payments;

  if (pgId) {
    const byPrintGroup = payments.filter(pay => pay.print_group_id === pgId);
    if (byPrintGroup.length) {
      relevant = byPrintGroup;
    }
  }

  // первый ненулевой type среди релевантных
  for (const pay of relevant) {
    if (pay && pay.type) return pay.type;
  }

  // запасной вариант — первый type среди всех payments
  for (const pay of payments) {
    if (pay && pay.type) return pay.type;
  }

  return null;
}

// --- Обновление одной позиции в MySQL ---

async function updatePaymentTypeForPosition(doc, p, paymentType) {
  if (!paymentType) return 0;

  let whereSql;
  let whereParams;

  if (p.uuid) {
    // Основной случай — по uuid
    whereSql = 'evotor_doc_id = ? AND position_uuid = ?';
    whereParams = [doc.id, p.uuid];
  } else {
    // Редкий fallback, если uuid нет
    whereSql =
      'evotor_doc_id = ? AND position_id <=> ? AND product_id <=> ? AND sum = ?';
    whereParams = [doc.id, p.id ?? null, p.product_id || null, p.sum ?? 0];
  }

  const sql = `
    UPDATE evotor_sales
    SET payments_type = ?
    WHERE ${whereSql}
      AND (payments_type IS NULL OR payments_type = '')
  `;

  const params = [paymentType, ...whereParams];

  try {
    const res = await q(sql, params);
    // res может быть разным в зависимости от драйвера, поэтому просто возвращаем "успех"
    return 1;
  } catch (err) {
    console.error(
      'UPDATE error for doc',
      doc.id,
      'position',
      p.uuid || p.id,
      ':',
      err.message
    );
    return 0;
  }
}

// --- Основной цикл: обходим все SELL и обновляем payments_type ---

(async () => {
  try {
    console.log('evotorPaymentsBackfill: start');

    let cursor = null;
    let totalDocs = 0;
    let totalPositions = 0;
    let totalUpdated = 0;

    while (true) {
      const { items, next } = await fetchPage({ since: null, cursor });

      if (!items.length) {
        console.log('evotorPaymentsBackfill: пустая страница, выходим');
        break;
      }

      totalDocs += items.length;
      console.log(
        `Страница: docs=${items.length}, totalDocs=${totalDocs}, cursor=${cursor}`
      );

      for (const doc of items) {
        const body = doc.body || {};
        const positions = body.positions || [];
        const payments = Array.isArray(body.payments) ? body.payments : [];

        if (!positions.length) continue;

        for (const p of positions) {
          totalPositions += 1;
          const paymentType = resolvePaymentTypeForPosition(payments, p);
          const updated = await updatePaymentTypeForPosition(
            doc,
            p,
            paymentType
          );
          totalUpdated += updated;
        }
      }

      if (!next) break;
      cursor = next;
    }

    console.log(
      `evotorPaymentsBackfill: done — docs=${totalDocs}, positions processed=${totalPositions}, rows updated=${totalUpdated}`
    );
  } catch (err) {
    console.error('evotorPaymentsBackfill error:', err.message);
    process.exit(1);
  }
})();
