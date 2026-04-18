import 'dotenv/config';
import { q } from '../db.js';
import { send } from '../tg.js';
import { kbCleaning } from '../keyboards.js';
import { gizmoGet, pickFirst } from '../gizmo.js';

// --- тестовый режим ---
const TEST_MODE = String(process.env.TG_TEST_MODE || '').toLowerCase() === 'true';

function envNum(key, def = null) {
  const v = process.env[key];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// выбираем чат
let CHAT = TEST_MODE ? envNum('TG_CHAT_TEST') : envNum('TG_CHAT_CLEAN');

console.log('[cleaning] start, TEST_MODE=', TEST_MODE, 'CHAT=', CHAT);

if (!CHAT) {
  console.log('[cleaning] no chat -> exit');
  process.exit(0);
}

// !!! поменяли порядок на более логичный
const PATHS = (process.env.GIZMO_CLOSE_PATHS || '/seats/closed,/events?type=SeatClosed,/sessions?status=closed,/sessions,/usersessions?closed=true,/usersessions')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

console.log('[cleaning] PATHS =', PATHS);

const PLACE_FIELDS = (process.env.GIZMO_PLACE_FIELDS || 'placeId,seatId,place_id,seat_id,place,number')
  .split(',')
  .map(s => s.trim());

const TIME_FIELDS = (process.env.GIZMO_TIME_FIELDS || 'closedAt,endedAt,closeTime,closed_at,ended_at,finishTime')
  .split(',')
  .map(s => s.trim());

const LIMIT = Number(process.env.GIZMO_LIMIT || 200);

// 1) читаем курсор
let sinceISO = null;
try {
  const cur = await q("SELECT v FROM kv_store WHERE k='gizmo:close_since'");
  console.log('[cleaning] cursor row =', cur);
  if (cur.length) {
    sinceISO = cur[0].v;
  } else {
    sinceISO = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    console.log('[cleaning] cursor not found, init sinceISO =', sinceISO);
  }
} catch (e) {
  console.error('[cleaning] ERROR reading cursor:', e);
  sinceISO = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  console.log('[cleaning] fallback sinceISO =', sinceISO);
}

console.log('[cleaning] sinceISO =', sinceISO);

// 2) кандидаты
const queryTail = `since=${encodeURIComponent(sinceISO)}&limit=${LIMIT}`;
const candidates = PATHS.map(p =>
  p.includes('?') ? `${p}&${queryTail}` : `${p}?${queryTail}`
);

console.log('[cleaning] candidates =', candidates);

let list = null;

// 3) опрашиваем по очереди
for (const path of candidates) {
  console.log('[cleaning] fetch path =', path);
  try {
    const data = await gizmoGet(path);
    console.log('[cleaning] response type =', Array.isArray(data) ? 'array' : typeof data);

    if (Array.isArray(data)) {
      console.log('[cleaning] got array, len =', data.length);
      list = data;
      break;
    }
    if (data && Array.isArray(data.items)) {
      console.log('[cleaning] got data.items, len =', data.items.length);
      list = data.items;
      break;
    }

    console.log('[cleaning] path returned unexpected structure');
  } catch (e) {
    console.error('[cleaning] ERROR fetch', path, e.message || e);
  }
}

// если ничего не получили — явно пишем и выходим
if (!list) {
  console.log('[cleaning] no list from any candidate -> EXIT. likely wrong GIZMO_CLOSE_PATHS');
  process.exit(0);
}

console.log('[cleaning] total events =', list.length);

// безопасное сравнение iso
function isNewer(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a > b;
}

let lastISO = sinceISO;

// 4) обрабатываем события
for (const ev of list) {
  const placeRaw = pickFirst(ev, PLACE_FIELDS);
  const placeId = Number(placeRaw);

  const timeRaw = pickFirst(ev, TIME_FIELDS);
  let closedAtISO = null;
  if (typeof timeRaw === 'string') {
    closedAtISO = timeRaw;
  } else if (timeRaw && typeof timeRaw === 'object') {
    closedAtISO = timeRaw.iso || timeRaw.date || null;
  }

  if (!placeId) {
    console.log('[cleaning] skip: no placeId, ev=', ev);
    continue;
  }
  if (!closedAtISO) {
    console.log('[cleaning] skip: no closedAt, ev=', ev);
    continue;
  }

  console.log('[cleaning] event:', { placeId, closedAtISO });

  try {
    const res = await q(
      "INSERT IGNORE INTO cleaning_tasks (place_id, closed_at) VALUES (?, ?)",
      [placeId, new Date(closedAtISO)]
    );
    console.log('[cleaning] insert result =', res);

    if (res.insertId) {
      const markup = JSON.stringify(kbCleaning(res.insertId));
      console.log('[cleaning] sending tg message to', CHAT, 'taskId=', res.insertId);
      await send(
        CHAT,
        `Место #${placeId} закрыто. Уборка?`,
        { reply_markup: markup }
      );
    } else {
      console.log('[cleaning] duplicate/ignored for', placeId, closedAtISO);
    }
  } catch (e) {
    console.error('[cleaning] ERROR insert/send for event', { placeId, closedAtISO }, e);
  }

  if (isNewer(closedAtISO, lastISO)) {
    lastISO = closedAtISO;
  }
}

console.log('[cleaning] lastISO after loop =', lastISO);

// 5) обновляем курсор
if (lastISO !== sinceISO) {
  try {
    await q(
      "REPLACE INTO kv_store (k, v) VALUES ('gizmo:close_since', ?)",
      [lastISO]
    );
    console.log('[cleaning] cursor updated to', lastISO);
  } catch (e) {
    console.error('[cleaning] ERROR updating cursor:', e);
  }
} else {
  console.log('[cleaning] cursor not changed');
}
