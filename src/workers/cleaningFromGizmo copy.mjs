// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/cleaningFromGizmo.mjs
import 'dotenv/config';
import { q } from '../db.js';
import { send } from '../tg.js';
import { chat } from '../config.js';

const CHAT = chat('CLEAN');
const TZ = process.env.TZ || 'Europe/Moscow';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function nowTZ() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function formatForLog(d) {
  return d.toLocaleString('ru-RU', { timeZone: TZ });
}

function timeLabelTZ(d) {
  return d.toLocaleTimeString('ru-RU', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ===== форматирование места (как в cleaningReport.mjs) =====
function formatPlace(placeRaw) {
  const s = String(placeRaw || '').trim();
  return s.replace('PC1', '№');
}

// ===== CLI =====
const argv = process.argv.slice(2);
function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a === `--${name}` || a.startsWith(pref));
  if (!found) return def;
  if (found === `--${name}`) return def;
  return found.slice(pref.length);
}

const COUNT_ARG = getArg('count', null);
const COUNT = COUNT_ARG !== null ? Number(COUNT_ARG) : null;

let MANUAL_SHIFT_ID = getArg('shiftId', null);
if (!MANUAL_SHIFT_ID && argv.length) {
  const maybeNum = Number(argv[0]);
  if (!Number.isNaN(maybeNum) && String(maybeNum) === argv[0]) {
    MANUAL_SHIFT_ID = maybeNum;
  }
}

// ===== 1. диапазон смены =====
let ACTIVE_SHIFT_ID;
let RANGE_START;
let RANGE_END;

if (MANUAL_SHIFT_ID) {
  console.log(`🔍 [${TZ}] Ищем смену ${MANUAL_SHIFT_ID} в таблице shift_data...`);
  const rows = await q(
    'SELECT shift_id, start_time, end_time, is_active FROM shift_data WHERE shift_id = ? LIMIT 1',
    [MANUAL_SHIFT_ID]
  );
  if (!rows.length) {
    console.log(`⛔ [${TZ}] Смена ${MANUAL_SHIFT_ID} в shift_data не найдена. Выходим.`);
    process.exit(0);
  }
  const r = rows[0];
  if (!r.start_time) {
    console.log(`⛔ [${TZ}] У смены ${MANUAL_SHIFT_ID} нет start_time. Выходим.`);
    process.exit(0);
  }
  RANGE_START = new Date(r.start_time);
  RANGE_END = r.end_time ? new Date(r.end_time) : nowTZ();
  ACTIVE_SHIFT_ID = r.shift_id;
  console.log(
    `✅ [${TZ}] Смена ${ACTIVE_SHIFT_ID}: ${formatForLog(RANGE_START)} → ${formatForLog(RANGE_END)} (is_active=${r.is_active})`
  );
} else {
  console.log(`🔍 [${TZ}] Ищем АКТИВНУЮ смену (is_active=1) в shift_data...`);
  const activeRows = await q(
    'SELECT shift_id, start_time, end_time, is_active FROM shift_data WHERE is_active = 1 ORDER BY start_time DESC LIMIT 1'
  );
  if (!activeRows.length) {
    console.log(`⛔ [${TZ}] Активная смена (is_active=1) не найдена и shiftId не передан. Выходим.`);
    process.exit(0);
  }
  const r = activeRows[0];
  if (!r.start_time) {
    console.log(`⛔ [${TZ}] У активной смены нет start_time. Выходим.`);
    process.exit(0);
  }
  RANGE_START = new Date(r.start_time);
  RANGE_END = r.end_time ? new Date(r.end_time) : nowTZ();
  ACTIVE_SHIFT_ID = r.shift_id;
  console.log(
    `✅ [${TZ}] Найдена активная смена: ${ACTIVE_SHIFT_ID}: ${formatForLog(RANGE_START)} → ${formatForLog(RANGE_END)}`
  );
}

// ===== 2. Берём ВСЕ сессии из session_data за интервал =====
let sessRows = await q(
  `SELECT
     session_id,
     host_id,
     host_name,
     user_id,
     user_name,
     start_time,
     end_time
   FROM session_data
   WHERE end_time IS NOT NULL
     AND end_time BETWEEN ? AND ?
   ORDER BY end_time ASC`,
  [RANGE_START, RANGE_END]
);

if (!sessRows.length) {
  console.log(`⚠️ [${TZ}] В этом интервале нет закрытых сессий в session_data. Выходим.`);
  process.exit(0);
}

if (COUNT !== null) {
  sessRows = sessRows.slice(-COUNT);
}

console.log(
  `📋 [${TZ}] Будет обработано ${sessRows.length} закрытых сессий для смены ${ACTIVE_SHIFT_ID}`
);

// ============ 3. Вставка и отправка ============
for (const sess of sessRows) {
  const sessId   = sess.session_id;
  const hostId   = sess.host_id;
  const hostName = sess.host_name || '';
  const userId   = sess.user_id;
  let   userName = sess.user_name || null;
  const closedAt = new Date(sess.end_time);

  if (!userName) {
    userName = userId ? `id${userId}` : 'Гость';
  }
  if (userName === '6WPdS3LsO0WJKCew4JlkRQ' || userName === 'id6WPdS3LsO0WJKCew4JlkRQ') {
    userName = 'Гость';
  }

  const timeLabel = timeLabelTZ(closedAt);
  const placeId = hostName || (hostId ? `hostId ${hostId}` : 'Место');

  // 1) проверяем, есть ли такая же задача по place_id + closed_at
  const existing = await q(
    `SELECT id FROM cleaning_tasks
      WHERE place_id = ? AND closed_at = ?
      LIMIT 1`,
    [placeId, closedAt]
  );

  if (existing.length) {
    // уже отправляли раньше — просто переходим к следующей
    console.log(
      `[${TZ}] ⏩ Пропуск ${placeId} ${closedAt.toISOString()} — задача уже есть (id ${existing[0].id})`
    );
    continue;
  }

  // 2) создаём новую задачу
  const ins = await q(
    `INSERT INTO cleaning_tasks
       (place_id, shift_id, session_id, closed_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', NOW(), NOW())`,
    [placeId, ACTIVE_SHIFT_ID, sessId, closedAt]
  );
  const taskId = ins.insertId;
  if (!taskId) continue;

  const kb = {
    inline_keyboard: [[
      { text: '🧹 Убрано',   callback_data: `cleaning:done:${taskId}` },
      { text: '🚫 Не нужно', callback_data: `cleaning:noneed:${taskId}` },
      { text: '⏳ Не успел', callback_data: `cleaning:late:${taskId}` }
    ]]
  };

  // форматируем заголовок: № и время — жирным
  const displayPlace = formatPlace(placeId); // "PC115" → "№15"
  const msg = `<b>${displayPlace}</b> ${userName} <b>${timeLabel}</b>\n❓ Статус уборки`;

  try {
    await send(CHAT, msg, {
      reply_markup: JSON.stringify(kb),
      parse_mode: 'HTML',
    });
    console.log(
      `[${TZ}] ✅ Отправлено в Telegram — task ${taskId}, session ${sessId}, shiftId ${ACTIVE_SHIFT_ID}`
    );
  } catch (e) {
    if (String(e.message || '').includes('429')) {
      console.log(`[${TZ}] ⛔ Telegram 429 Too Many Requests, стопим рассылку: ${e.message}`);
      break;
    } else {
      console.log(
        `[${TZ}] ⛔ Ошибка отправки в Telegram для task ${taskId}:`,
        e.message || e
      );
    }
  }

  await sleep(900);
}

process.exit(0);
