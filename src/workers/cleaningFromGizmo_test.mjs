// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/cleaningFromGizmo_test.mjs
import 'dotenv/config';
import { q } from '../db.js';
import { send } from '../tg.js';
import { chat } from '../config.js';

const CHAT = chat('CLEAN');
const TZ = process.env.TZ || 'Europe/Moscow';

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

// можно передать номер смены
let MANUAL_SHIFT_ID = getArg('shiftId', null);
if (!MANUAL_SHIFT_ID && argv.length) {
  const maybeNum = Number(argv[0]);
  if (!Number.isNaN(maybeNum) && String(maybeNum) === argv[0]) {
    MANUAL_SHIFT_ID = maybeNum;
  }
}

// параметры теста
const TEST_PLACE = getArg('testPlace', 'PC199');          // по умолчанию PC199
const TEST_USER  = getArg('testUser', 'Тест (проверка)'); // подпись в сообщении

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

// ===== 2. ОДНО ТЕСТОВОЕ СООБЩЕНИЕ =====
const closedAt  = nowTZ();
const timeLabel = timeLabelTZ(closedAt);

const placeId      = TEST_PLACE;           // что запишем в cleaning_tasks.place_id
const displayPlace = formatPlace(placeId); // "PC115" → "№15"
const userName     = TEST_USER;

// создаём строку в cleaning_tasks (session_id = NULL, статус open)
const ins = await q(
  `INSERT INTO cleaning_tasks
     (place_id, shift_id, session_id, closed_at, status, created_at, updated_at)
   VALUES (?, ?, NULL, ?, 'open', NOW(), NOW())`,
  [placeId, ACTIVE_SHIFT_ID, closedAt]
);
const taskId = ins.insertId;

if (!taskId) {
  console.log(`[${TZ}] ⛔ Не удалось вставить тестовую задачу`);
  process.exit(1);
}

const kb = {
  inline_keyboard: [[
    { text: '🧹 Убрано',   callback_data: `cleaning:done:${taskId}` },
    { text: '🚫 Не нужно', callback_data: `cleaning:noneed:${taskId}` },
    { text: '⏳ Не успел', callback_data: `cleaning:late:${taskId}` }
  ]]
};

const msg = `<b>${displayPlace}</b> ${userName} <b>${timeLabel}</b>\n❓ Статус уборки`;

try {
  await send(CHAT, msg, {
    reply_markup: JSON.stringify(kb),
    parse_mode: 'HTML',
  });
  console.log(
    `[${TZ}] ✅ Отправлено ТЕСТОВОЕ сообщение — task ${taskId}, shiftId ${ACTIVE_SHIFT_ID}`
  );
} catch (e) {
  console.log(
    `[${TZ}] ⛔ Ошибка отправки ТЕСТОВОГО сообщения в Telegram:`,
    e.message || e
  );
  process.exit(1);
}

process.exit(0);
