// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/cleaningFromGizmo.mjs
import 'dotenv/config';
import { q } from '../db.js';
import { chat } from '../config.js';

const CHAT = chat('CLEAN');
const TZ = process.env.TZ || 'Europe/Moscow';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

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

function hasFlag(name) {
  return argv.includes(`--${name}`);
}

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a === `--${name}` || a.startsWith(pref));
  if (!found) return def;
  if (found === `--${name}`) return def;
  return found.slice(pref.length);
}

const FORCE = hasFlag('force');

const COUNT_ARG = getArg('count', null);
const COUNT = COUNT_ARG !== null ? Number(COUNT_ARG) : null;

let MANUAL_SHIFT_ID = getArg('shiftId', null) || getArg('shift', null);
if (!MANUAL_SHIFT_ID && argv.length) {
  const maybeNum = Number(argv[0]);
  if (!Number.isNaN(maybeNum) && String(maybeNum) === argv[0]) {
    MANUAL_SHIFT_ID = maybeNum;
  }
}

// ---------------- Telegram send (с message_id) ----------------
async function tgSendMessage({ chatId, text, replyMarkup }) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  if (!chatId) throw new Error('chatId не задан');

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('text', String(text));
  form.append('parse_mode', 'HTML');
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));

  const res = await fetch(url, { method: 'POST', body: form });
  const json = await res.json().catch(() => null);

  if (!res.ok || !json || !json.ok) {
    const errText = json ? JSON.stringify(json) : `HTTP ${res.status}`;
    throw new Error(`TG sendMessage failed: ${errText}`);
  }

  const msgId = json?.result?.message_id || null;
  return { msgId };
}

// ===== Онлайн посетители Gizmo =====
async function getOnlineVisitorsCount() {
  const rows = await q(
    `SELECT COUNT(DISTINCT session_id) AS cnt
       FROM session_data
      WHERE end_time IS NULL`
  );

  return Number(rows?.[0]?.cnt || 0);
}

// ===== 1. диапазон смены =====
let ACTIVE_SHIFT_ID;
let RANGE_START;
let RANGE_END;
let SHIFT_IS_ACTIVE = 0;

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

  SHIFT_IS_ACTIVE = Number(r.is_active) || 0;

  // ✅ По умолчанию: слать только активную смену
  // ✅ Для старых смен: только если --force
  if (!FORCE && SHIFT_IS_ACTIVE !== 1) {
    console.log(
      `⛔ [${TZ}] Смена ${r.shift_id} не активная (is_active=${r.is_active}). ` +
      `Отправка запрещена. Используй --force если нужно принудительно.`
    );
    process.exit(0);
  }

  RANGE_START = new Date(r.start_time);
  RANGE_END = r.end_time ? new Date(r.end_time) : nowTZ();
  ACTIVE_SHIFT_ID = r.shift_id;

  console.log(
    `✅ [${TZ}] Смена ${ACTIVE_SHIFT_ID}: ${formatForLog(RANGE_START)} → ${formatForLog(RANGE_END)} (is_active=${r.is_active}, force=${FORCE ? '1' : '0'})`
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

  SHIFT_IS_ACTIVE = Number(r.is_active) || 0;
  RANGE_START = new Date(r.start_time);
  RANGE_END = r.end_time ? new Date(r.end_time) : nowTZ();
  ACTIVE_SHIFT_ID = r.shift_id;

  console.log(
    `✅ [${TZ}] Найдена активная смена: ${ACTIVE_SHIFT_ID}: ${formatForLog(RANGE_START)} → ${formatForLog(RANGE_END)}`
  );
}

if (!CHAT) {
  console.log(`⛔ [${TZ}] CHAT не задан (chat('CLEAN') вернул null).`);
  process.exit(0);
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

// ===== helpers DB (как у бонусов) =====
async function loadTaskByPlaceClosed(placeId, closedAt) {
  const rows = await q(
    `SELECT id, status, tg_chat_id, tg_message_id
       FROM cleaning_tasks
      WHERE place_id = ? AND closed_at = ?
      LIMIT 1`,
    [placeId, closedAt]
  );
  return rows[0] || null;
}

async function createTask({ placeId, shiftId, sessionId, closedAt }) {
  const ins = await q(
    `INSERT INTO cleaning_tasks
       (place_id, shift_id, session_id, closed_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', NOW(), NOW())`,
    [placeId, shiftId, sessionId, closedAt]
  );
  return ins?.insertId || null;
}

async function markSent({ taskId, chatId, msgId }) {
  await q(
    `UPDATE cleaning_tasks
        SET tg_chat_id = ?,
            tg_message_id = ?,
            sent_at = NOW(),
            updated_at = NOW()
      WHERE id = ?
      LIMIT 1`,
    [chatId, msgId, taskId]
  );
}

function isAlreadySentRow(r) {
  const tgMid = r?.tg_message_id;
  return tgMid != null && String(tgMid).trim() !== '';
}

// ============ 3. Вставка и отправка (идемпотентно) ============
let created = 0;
let sent = 0;
let skipped = 0;
let resend = 0;

for (const sess of sessRows) {
  const sessId = sess.session_id;
  const hostId = sess.host_id;
  const hostName = sess.host_name || '';
  const userId = sess.user_id;
  let userName = sess.user_name || null;
  const closedAt = new Date(sess.end_time);

  if (!userName) userName = userId ? `id${userId}` : 'Гость';
  if (userName === '6WPdS3LsO0WJKCew4JlkRQ' || userName === 'id6WPdS3LsO0WJKCew4JlkRQ') {
    userName = 'Гость';
  }

  const timeLabel = timeLabelTZ(closedAt);
  const placeId = hostName || (hostId ? `hostId ${hostId}` : 'Место');

  // 1) найти/создать задачу
  let existedBefore = true;
  let task = await loadTaskByPlaceClosed(placeId, closedAt);

  if (!task) {
    existedBefore = false;
    try {
      const taskId = await createTask({
        placeId,
        shiftId: ACTIVE_SHIFT_ID,
        sessionId: sessId,
        closedAt
      });
      if (!taskId) continue;
      created++;
      task = { id: taskId, status: 'open', tg_chat_id: null, tg_message_id: null };
    } catch (e) {
      // если включишь UNIQUE(place_id, closed_at) и ловишь дубль
      const em = String(e?.message || e);
      console.log(`[${TZ}] ⚠️ INSERT cleaning_tasks ошибка (возможно дубль): ${em}`);
      task = await loadTaskByPlaceClosed(placeId, closedAt);
      if (!task) continue;
      existedBefore = true;
    }
  }

  const taskId = task.id;

  // 2) если уже отправлено — пропуск
  if (isAlreadySentRow(task)) {
    skipped++;
    console.log(`[${TZ}] ⏩ Пропуск ${placeId} ${closedAt.toISOString()} — уже отправлено (task ${taskId}, msg ${task.tg_message_id})`);
    continue;
  }

  // 3) формируем сообщение
  const kb = {
    inline_keyboard: [[
      { text: '🧹 Убрано',   callback_data: `cleaning:done:${taskId}` },
      { text: '🚫 Не нужно', callback_data: `cleaning:noneed:${taskId}` },
      { text: '⏳ Не успел', callback_data: `cleaning:late:${taskId}` }
    ]]
  };

  let onlineVisitorsCount = 0;
  try {
    onlineVisitorsCount = await getOnlineVisitorsCount();
    console.log(`[${TZ}] 👥 Онлайн посетителей Gizmo: ${onlineVisitorsCount}`);
  } catch (e) {
    const em = String(e?.message || e);
    console.log(`[${TZ}] ⚠️ Не удалось получить количество онлайн посетителей Gizmo: ${em}`);
    onlineVisitorsCount = null;
  }

  const displayPlace = formatPlace(placeId);

  const onlineLine =
    onlineVisitorsCount === null
      ? '👥 Онлайн: <b>не удалось определить</b>'
      : `👥 Онлайн: <b>${onlineVisitorsCount}</b>`;

  const msg =
    `<b>${displayPlace}</b> ${userName} <b>${timeLabel}</b>\n` +
    `${onlineLine}\n` +
    `❓ Статус уборки`;

  // 4) отправка + сохранение msg_id
  try {
    const r = await tgSendMessage({ chatId: CHAT, text: msg, replyMarkup: kb });
    if (r?.msgId) {
      await markSent({ taskId, chatId: CHAT, msgId: r.msgId });
      if (existedBefore) resend++;
      else sent++;
      console.log(`[${TZ}] ✅ TG отправлено — task ${taskId}, msg_id=${r.msgId}, session ${sessId}, shiftId ${ACTIVE_SHIFT_ID}`);
    } else {
      console.log(`[${TZ}] ⚠️ TG отправлено, но msg_id не получен taskId=${taskId}`);
    }
  } catch (e) {
    const em = String(e?.message || e);
    if (em.includes('429')) {
      console.log(`[${TZ}] ⛔ Telegram 429 Too Many Requests, стопим рассылку: ${em}`);
      break;
    }
    console.log(`[${TZ}] ⛔ Ошибка отправки в Telegram для task ${taskId}: ${em}`);
  }

  await sleep(900);
}

console.log(
  `[${TZ}] ✅ Готово. created=${created}, sent=${sent}, resent=${resend}, skipped=${skipped}, force=${FORCE ? '1' : '0'}`
);
process.exit(0);