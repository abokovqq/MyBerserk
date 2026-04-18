// src/workers/evotorProductGroups.mjs
import '../env.js';
import { q } from '../db.js';

const TOKEN     = process.env.EVOTOR_ACCESS_TOKEN;
const STORE_ID  = process.env.STORE_ID;
const DEVICE_ID = process.env.DEVICE_ID; // для связки, хотя группы на девайс не завязаны
const API_BASE  = (process.env.API_URL || 'https://api.evotor.ru').replace(/\/+$/, '');

if (!TOKEN || !STORE_ID || !DEVICE_ID) {
  console.log('evotorProductGroupsWorker: missing .env variables');
  process.exit(0);
}

const API_URL = `${API_BASE}/stores/${STORE_ID}/product-groups`;

// ======================================================================
// FETCH ALL GROUPS WITH CURSOR
// ======================================================================
async function getAllGroups() {
  const groups = [];
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
      const text = await res.text();
      console.log(`evotorProductGroupsWorker: HTTP ${res.status} :: ${text}`);
      break;
    }

    const data = await res.json();

    let items;
    if (Array.isArray(data)) {
      items = data;
    } else if (Array.isArray(data.items)) {
      items = data.items;
    } else {
      items = [];
    }

    groups.push(...items);
    cursor = data?.paging?.next_cursor || null;
    if (!cursor) break;
  }

  return groups;
}

// ======================================================================
// UPSERT TO DATABASE
// ======================================================================
async function saveGroups(groups) {
  if (!groups.length) return 0;

  let saved = 0;

  const sql = `
    INSERT INTO evotor_product_groups
      (store_id, device_id, group_id, name, parent_id, code, is_deleted,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name       = VALUES(name),
      parent_id  = VALUES(parent_id),
      code       = VALUES(code),
      is_deleted = VALUES(is_deleted),
      updated_at = VALUES(updated_at)
  `;

  for (const g of groups) {
    const groupId = g.id || g.uuid;
    if (!groupId) {
      // на всякий случай пропускаем странные объекты
      continue;
    }

    const created = g.created_at
      ? g.created_at.replace('T', ' ').slice(0, 23)
      : null;
    const updated = g.updated_at
      ? g.updated_at.replace('T', ' ').slice(0, 23)
      : created;

    const params = [
      STORE_ID,
      DEVICE_ID,
      groupId,
      g.name || '',
      g.parent_id || null,
      g.code || null,
      0,                // is_deleted — всё, что пришло тут, считаем актуальным
      created,
      updated,
    ];

    try {
      await q(sql, params);
      saved++;
    } catch (e) {
      console.log(
        'evotorProductGroupsWorker: SQL error:',
        e.message,
        'group_id:',
        groupId
      );
    }
  }

  return saved;
}

// ======================================================================
// MAIN
// ======================================================================
(async () => {
  try {
    const groups = await getAllGroups();
    const saved = await saveGroups(groups);

    console.log(
      `evotorProductGroupsWorker: fetched=${groups.length}, saved_or_updated=${saved}`
    );
  } catch (e) {
    console.log('evotorProductGroupsWorker: fatal error:', e.message);
  } finally {
    process.exit(0);
  }
})();
