import 'dotenv/config';
import { q } from '../db.js';
import { send } from '../tg.js';
import { kbCleaning } from '../keyboards.js';
import { chat } from '../config.js';
import { gizmoGet, pickFirst } from '../gizmo.js';

const CHAT = chat('CLEAN'); // при TG_TEST_MODE=true уйдёт в тест-чат

const PATHS = (process.env.GIZMO_CLOSE_PATHS || '/seats/closed')
  .split(',').map(s => s.trim()).filter(Boolean);
const PLACE_FIELDS = (process.env.GIZMO_PLACE_FIELDS || 'placeId,seatId,place_id,seat_id,place,number')
  .split(',').map(s => s.trim());
const TIME_FIELDS  = (process.env.GIZMO_TIME_FIELDS  || 'closedAt,endedAt,closeTime,closed_at,ended_at,finishTime')
  .split(',').map(s => s.trim());

const LIMIT = Number(process.env.GIZMO_LIMIT || 200);

// берём с запасом за последние 24 часа
const sinceISO = new Date(Date.now() - 24*60*60*1000).toISOString();

function getTimeISO(ev) {
  const raw = pickFirst(ev, TIME_FIELDS);
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  return raw?.iso || raw?.date || null;
}

(async () => {
  // 1) тащим по кандидатам и собираем все события
  const queryTail = `since=${encodeURIComponent(sinceISO)}&limit=${LIMIT}`;
  const candidates = PATHS.map(p => p.includes('?') ? `${p}&${queryTail}` : `${p}?${queryTail}`);
  let all = [];
  for (const path of candidates) {
    try {
      const data = await gizmoGet(path);
      if (Array.isArray(data)) all = all.concat(data);
      else if (data?.items && Array.isArray(data.items)) all = all.concat(data.items);
    } catch {
      // пропускаем неуспешные эндпоинты
    }
  }
  if (!all.length) {
    console.log('Нет закрытых мест за 24h.');
    process.exit(0);
  }

  // 2) находим САМЫЙ ПОЗДНИЙ event по времени закрытия
  all = all
    .map(ev => ({ ev, t: getTimeISO(ev) }))
    .filter(x => x.t)
    .sort((a,b) => (a.t > b.t ? 1 : -1));
  if (!all.length) {
    console.log('События есть, но нет поля времени закрытия — проверьте GIZMO_TIME_FIELDS.');
    process.exit(0);
  }
  const last = all[all.length - 1].ev;

  // 3) достаём место и время
  const placeRaw = pickFirst(last, PLACE_FIELDS);
  const closedAtISO = getTimeISO(last);
  const placeId = Number(placeRaw);

  if (!placeId || !closedAtISO) {
    console.log('Не удалось распознать placeId/closedAt — проверьте GIZMO_PLACE_FIELDS и GIZMO_TIME_FIELDS.');
    process.exit(1);
  }

  // 4) вставляем/находим задачу в cleaning_tasks и берём её id
  //    даже если уже существует запись (UNIQUE(place_id, closed_at)), достанем существующий id.
  const ins = await q(
    "INSERT INTO cleaning_tasks (place_id, closed_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)",
    [placeId, new Date(closedAtISO)]
  );
  const taskId = ins.insertId || (await (async () => {
    const rows = await q("SELECT id FROM cleaning_tasks WHERE place_id=? AND closed_at=?", [placeId, new Date(closedAtISO)]);
    return rows[0]?.id;
  })());

  if (!taskId) {
    console.log('Не удалось получить taskId для карточки.');
    process.exit(1);
  }

  // 5) отправляем карточку, НЕЗАВИСИМО от статуса в БД
  const markup = JSON.stringify(kbCleaning(taskId));
  await send(CHAT, `ТЕСТ: последнее закрытое место #${placeId} (${closedAtISO}). Уборка?`, { reply_markup: markup });

  console.log(`OK: отправлена карточка для task #${taskId}, place #${placeId}, time ${closedAtISO}`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });