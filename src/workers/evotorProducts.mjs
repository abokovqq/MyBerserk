// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorProducts.mjs
import '../env.js';
import { q } from '../db.js';

const TOKEN     = process.env.EVOTOR_ACCESS_TOKEN;
const STORE_ID  = process.env.STORE_ID;
const DEVICE_ID = process.env.DEVICE_ID;
const API_BASE  = (process.env.API_URL || 'https://api.evotor.ru').replace(/\/+$/, '');

if (!TOKEN || !STORE_ID || !DEVICE_ID) {
  console.log('evotorProductsWorker: missing .env variables');
  process.exit(0);
}

const API_URL = `${API_BASE}/stores/${STORE_ID}/products`;

// ===============================
// helpers
// ===============================
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ===============================
// FETCH ALL PRODUCTS WITH CURSOR
// ===============================
async function fetchAllProducts() {
  const out = [];
  let cursor = null;

  while (true) {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);

    const url = params.toString() ? `${API_URL}?${params}` : API_URL;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      console.log(`evotorProductsWorker: HTTP ${res.status}:`, await res.text());
      break;
    }

    const data = await res.json();
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data.items)
      ? data.items
      : [];

    out.push(...items);

    cursor = data?.paging?.next_cursor || null;
    if (!cursor) break;
  }

  return out;
}

// ===============================
// UPSERT В evotor_products
// ===============================
async function saveProducts(products) {
  if (!products.length) return 0;

  let saved = 0;

  // ВАЖНО: поле id (auto_increment PK) не заполняем!
  const sql = `
    INSERT INTO evotor_products (
      store_id,
      device_id,
      product_id,
      name,
      article_number,
      code,
      barcodes,
      type,
      parent_id,
      measure_name,
      tax,
      price,
      cost_price,
      allow_to_sell,
      is_age_limited,
      is_excisable,
      classification_code,
      description,
      quantity,
      quantity_new,
      user_id,
      attributes_choices,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name                = VALUES(name),
      article_number      = VALUES(article_number),
      code                = VALUES(code),
      barcodes            = VALUES(barcodes),
      type                = VALUES(type),
      parent_id           = VALUES(parent_id),
      measure_name        = VALUES(measure_name),
      tax                 = VALUES(tax),
      price               = VALUES(price),
      cost_price          = VALUES(cost_price),
      allow_to_sell       = VALUES(allow_to_sell),
      is_age_limited      = VALUES(is_age_limited),
      is_excisable        = VALUES(is_excisable),
      classification_code = VALUES(classification_code),
      description         = VALUES(description),
      quantity            = VALUES(quantity),
      quantity_new        = VALUES(quantity_new),
      user_id             = VALUES(user_id),
      attributes_choices  = VALUES(attributes_choices),
      updated_at          = VALUES(updated_at)
  `;

  for (const p of products) {
    // product_id – основной ключ (в связке с store_id)
    const productId = p.id || p.uuid || p.product_id;
    if (!productId) continue;

    // barcodes → JSON или NULL
    let barcodesJson = null;
    if (Array.isArray(p.barcodes)) {
      barcodesJson = JSON.stringify(p.barcodes);
    } else if (typeof p.barcode === 'string' && p.barcode.trim() !== '') {
      barcodesJson = JSON.stringify([p.barcode.trim()]);
    } else if (typeof p.barcodes === 'string' && p.barcodes.trim() !== '') {
      const arr = p.barcodes
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      barcodesJson = JSON.stringify(arr);
    } else {
      barcodesJson = null; // чтобы не было пустой строки в JSON-колонке
    }

    // attributes_choices → JSON или NULL
    let attrsJson = null;
    if (p.attributes_choices !== undefined && p.attributes_choices !== null) {
      attrsJson = JSON.stringify(p.attributes_choices);
    }

    // allow_to_sell → tinyint/null
    let allowToSell = null;
    if (typeof p.allow_to_sell === 'boolean') {
      allowToSell = p.allow_to_sell ? 1 : 0;
    } else if (p.allow_to_sell !== undefined && p.allow_to_sell !== null) {
      allowToSell = Number(!!p.allow_to_sell);
    } else if (typeof p.allowToSell === 'boolean') {
      allowToSell = p.allowToSell ? 1 : 0;
    }

    const params = [
      STORE_ID,                 // store_id
      DEVICE_ID,                // device_id
      productId,                // product_id
      p.name || '',             // name
      p.article_number || null, // article_number
      p.code || null,           // code
      barcodesJson,             // barcodes (JSON)
      p.type || null,           // type
      p.parent_id || null,      // parent_id
      p.measure_name || null,   // measure_name
      p.tax || null,            // tax
      numOrNull(p.price),       // price
      numOrNull(p.cost_price),  // cost_price
      allowToSell,              // allow_to_sell
      p.is_age_limited ? 1 : 0, // is_age_limited
      p.is_excisable ? 1 : 0,   // is_excisable
      p.classification_code || null, // classification_code
      p.description || null,    // description
      numOrNull(p.quantity),    // quantity
      numOrNull(p.quantity_new),// quantity_new
      p.user_id || null,        // user_id
      attrsJson,                // attributes_choices (JSON)
      p.created_at
        ? p.created_at.replace('T', ' ').slice(0, 23)
        : null,                 // created_at
      p.updated_at
        ? p.updated_at.replace('T', ' ').slice(0, 23)
        : null,                 // updated_at
    ];

    try {
      await q(sql, params);
      saved++;
    } catch (e) {
      console.log(
        'evotorProductsWorker: SQL error:',
        e.message,
        'product_id:',
        productId
      );
    }
  }

  return saved;
}

// ===============================
// MAIN
// ===============================
(async () => {
  try {
    const products = await fetchAllProducts();
    const saved = await saveProducts(products);

    console.log(
      `evotorProductsWorker: fetched=${products.length}, saved_or_updated=${saved}`
    );
  } catch (e) {
    console.log('evotorProductsWorker: fatal error:', e);
  } finally {
    process.exit(0);
  }
})();
