// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/bonusesFromGizmo.mjs
// Воркер: собирает бонусные транзакции из Gizmo за смену, сохраняет в bonus_tasks,
// отправляет в Telegram запрос статуса с кнопками "Акция" / "Компенсация".
// Идемпотентность: повторный запуск НЕ отправляет уже отправленные задачи
// (проверяем tg_message_id И старое msg_id), а уникальность обеспечиваем uniq_hash.
//
// CLI:
//   --shiftId=1504         (или --shift=1504)
//   --count=10             (обработать последние N бонусов)
//   --only-new             (не отправлять уже отправленные; по умолчанию тоже не отправляет, флаг оставлен для совместимости)
//   --no-tg                (не отправлять в Telegram, только заполнить БД)
//
// Чат отправки:
//   сначала TG_CHAT_TEST из .env, иначе chat('BONUS') -> chat('WORK') -> chat('CLEAN')

import '../env.js';

import crypto from 'node:crypto';
import { q } from '../db.js';
import { gizmoFetch } from '../gizmoClient.js';
import { chat } from '../config.js';

const TZ = process.env.TZ || 'Europe/Moscow';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

function sha1(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
}

function envNum(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const clean = String(raw).split('#')[0].trim();
  if (!clean) return null;
  const n = Number(clean);
  return Number.isNaN(n) ? null : n;
}

// чат запросов: TG_CHAT_TEST -> BONUS -> WORK -> CLEAN
const CHAT =
  envNum('TG_CHAT_REPORT') ||
  chat('BONUS') ||
  chat('WORK') ||
  chat('CLEAN') ||
  null;

// ---------------- helpers ----------------

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

function parseGizmoDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normName(s) {
  return String(s || '').trim();
}

function isBonusTx(t) {
  const method = String(t?.paymentMethodName || '');
  return method.toLowerCase().includes('бонус');
}

function getAmount(t) {
  if (t?.total != null) return Number(t.total);
  if (t?.value != null) return Number(t.value);
  return 0;
}

function toMySqlDateTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  );
}

function money(v) {
  const x = Number(v || 0);
  return (Math.round(x * 100) / 100).toFixed(2);
}

// ---------------- CLI ----------------

const argv = process.argv.slice(2);

function hasFlag(name) {
  return argv.includes(`--${name}`);
}

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  if (!found) return def;
  return found.substring(pref.length);
}

const NO_TG = hasFlag('no-tg');
const ONLY_NEW = hasFlag('only-new'); // оставлено для совместимости, логика и так "не слать, если уже слали"

const COUNT_ARG = getArg('count', null);
const COUNT = COUNT_ARG !== null ? Number(COUNT_ARG) : null;

let MANUAL_SHIFT_ID = getArg('shiftId', null) || getArg('shift', null);
if (!MANUAL_SHIFT_ID && argv.length) {
  const maybeNum = Number(argv[0]);
  if (!Number.isNaN(maybeNum) && String(maybeNum) === argv[0]) MANUAL_SHIFT_ID = maybeNum;
}

// ---------------- Telegram send (с message_id) ----------------

async function tgSendMessage({ chatId, text, replyMarkup }) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
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

// ---------------- shift range ----------------

async function loadShiftById(shiftId) {
  const rows = await q(
    'SELECT shift_id, start_time, end_time, is_active FROM shift_data WHERE shift_id = ? LIMIT 1',
    [shiftId],
  );
  return rows[0] || null;
}

async function loadActiveShift() {
  const rows = await q(
    'SELECT shift_id, start_time, end_time, is_active FROM shift_data WHERE is_active = 1 ORDER BY start_time DESC LIMIT 1',
  );
  return rows[0] || null;
}

// ---------------- bonus_tasks DB ----------------

// ВАЖНО:
// должен существовать UNIQUE индекс uq_bonus_hash(uniq_hash).
// (по твоей БД он уже есть)
async function upsertBonusTask({ shiftId, trxTime, clientName, amount }) {
  const trxSql = toMySqlDateTime(trxTime);

  // ✅ uniq_hash стабилен и различает события
  const uniqHash = sha1(`${shiftId}|${trxSql}|${clientName}|${money(amount)}`);

  const ins = await q(
    `
    INSERT INTO bonus_tasks
      (shift_id, trx_time, client_name, amount, status, uniq_hash, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, 'open', ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      id = LAST_INSERT_ID(id),
      updated_at = NOW()
    `,
    [shiftId, trxSql, clientName, amount, uniqHash],
  );

  return { taskId: ins?.insertId || null, uniqHash, trxSql };
}

async function loadTaskSendState(taskId) {
  // читаем и новые tg_*, и старые msg_* (чтобы корректно распознавать историю)
  const rows = await q(
    `
    SELECT
      id,
      status,
      tg_chat_id, tg_message_id,
      msg_chat_id, msg_id
    FROM bonus_tasks
    WHERE id = ?
    LIMIT 1
    `,
    [taskId],
  );
  return rows[0] || null;
}

function isAlreadySentRow(r) {
  const tgMid = r?.tg_message_id;
  const oldMid = r?.msg_id;
  return (
    (tgMid != null && String(tgMid).trim() !== '') ||
    (oldMid != null && String(oldMid).trim() !== '')
  );
}

async function markSent({ taskId, chatId, msgId }) {
  // пишем в НОВЫЕ поля (tg_*), старые не трогаем
  await q(
    `
    UPDATE bonus_tasks
       SET tg_chat_id = ?,
           tg_message_id = ?,
           sent_at = NOW(),
           updated_at = NOW()
     WHERE id = ?
     LIMIT 1
    `,
    [chatId, msgId, taskId],
  );
}

// ---------------- Gizmo time formatting ----------------

const pad2 = n => String(n).padStart(2, '0');
function toGizmoTime(d) {
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    'T' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes()) +
    ':' +
    pad2(d.getSeconds()) +
    '.000'
  );
}

// ---------------- MAIN ----------------

async function main() {
  let ACTIVE_SHIFT_ID = null;
  let RANGE_START = null;
  let RANGE_END = null;

  if (MANUAL_SHIFT_ID) {
    console.log(`🔍 [${TZ}] Ищем смену ${MANUAL_SHIFT_ID} в shift_data...`);
    const s = await loadShiftById(MANUAL_SHIFT_ID);
    if (!s || !s.start_time) {
      console.log(`⛔ [${TZ}] Смена ${MANUAL_SHIFT_ID} не найдена или нет start_time. Выходим.`);
      process.exit(0);
    }
    RANGE_START = new Date(s.start_time);
    RANGE_END = s.end_time ? new Date(s.end_time) : nowTZ();
    ACTIVE_SHIFT_ID = s.shift_id;

    console.log(
      `✅ [${TZ}] Смена ${ACTIVE_SHIFT_ID}: ${formatForLog(RANGE_START)} → ${formatForLog(RANGE_END)} (is_active=${s.is_active})`,
    );
  } else {
    console.log(`🔍 [${TZ}] Ищем АКТИВНУЮ смену (is_active=1) в shift_data...`);
    const s = await loadActiveShift();
    if (!s || !s.start_time) {
      console.log(`⛔ [${TZ}] Активная смена не найдена или нет start_time. Выходим.`);
      process.exit(0);
    }
    RANGE_START = new Date(s.start_time);
    RANGE_END = s.end_time ? new Date(s.end_time) : nowTZ();
    ACTIVE_SHIFT_ID = s.shift_id;

    console.log(
      `✅ [${TZ}] Найдена активная смена: ${ACTIVE_SHIFT_ID}: ${formatForLog(RANGE_START)} → ${formatForLog(RANGE_END)}`,
    );
  }

  if (!CHAT && !NO_TG) {
    console.log(`⛔ [${TZ}] Не задан чат для отправки (TG_CHAT_TEST / chat('BONUS')...).`);
    process.exit(1);
  }

  const params = new URLSearchParams({
    DateFrom: toGizmoTime(RANGE_START),
    DateTo: toGizmoTime(RANGE_END),
  });

  let gizmoResp;
  try {
    gizmoResp = await gizmoFetch(`/api/reports/transactionslog?${params}`, {
      method: 'GET',
      apiVersion: 1,
    });
  } catch (e) {
    console.log(`⛔ [${TZ}] Ошибка запроса к Gizmo: ${e?.message || e}`);
    process.exit(1);
  }

  const txs = Array.isArray(gizmoResp?.result?.transactions) ? gizmoResp.result.transactions : [];
  console.log(`📦 [${TZ}] Получено транзакций Gizmo: ${txs.length}`);

  let bonuses = [];
  for (const t of txs) {
    if (!isBonusTx(t)) continue;

    const dt = parseGizmoDate(t.transactionDate);
    if (!dt) continue;

    let customer = normName(t.customerName || '');
    if (!customer) customer = '—';

    bonuses.push({
      time: dt,
      customer,
      amount: getAmount(t),
    });
  }

  bonuses.sort((a, b) => a.time - b.time);
  if (COUNT !== null && bonuses.length > COUNT) bonuses = bonuses.slice(-COUNT);

  console.log(`🎁 [${TZ}] Бонусных транзакций: ${bonuses.length}`);

  let saved = 0;
  let sent = 0;
  let skipped = 0;

  for (const b of bonuses) {
    const { taskId, uniqHash, trxSql } = await upsertBonusTask({
      shiftId: ACTIVE_SHIFT_ID,
      trxTime: b.time,
      clientName: b.customer,
      amount: b.amount,
    });

    if (!taskId) continue;
    saved++;

    console.log(
      `[${TZ}] 🧩 upsert ok taskId=${taskId} uniq=${String(uniqHash).slice(0, 10)} trx=${trxSql} client=${b.customer} amount=${money(
        b.amount,
      )}`,
    );

    const row = await loadTaskSendState(taskId);

    if (isAlreadySentRow(row)) {
      skipped++;
      console.log(
        `[${TZ}] ⏩ Пропуск taskId=${taskId} — уже отправлено ранее (tg_msg=${
          row.tg_message_id || '—'
        }, msg_id=${row.msg_id || '—'})`,
      );
      continue;
    }

    if (NO_TG) {
      console.log(`[${TZ}] 📴 --no-tg: не отправляем taskId=${taskId}`);
      continue;
    }

    // оставлено для совместимости: если кто-то ожидает "слать только новое"
    // логика и так "не слать уже отправленное"
    if (ONLY_NEW) {
      // ничего дополнительно
    }

    const kb = {
    inline_keyboard: [
    [
        { text: '🎯 Акция', callback_data: `bonus:promo:${taskId}` },
        { text: '💼 Босс',  callback_data: `bonus:boss:${taskId}` },
        { text: '🛠 Админ', callback_data: `bonus:admin:${taskId}` },
    ],
    ],
    };

    const msg =
      `<b>🎁 Указать тип бонуса Gizmo</b>\n` +
      `👤 <b>${b.customer}</b>\n` +
      `🕒 <b>${timeLabelTZ(b.time)}</b>\n` +
      `💰 <b>${money(b.amount)} ₽</b>\n\n`;

    try {
      const r = await tgSendMessage({ chatId: CHAT, text: msg, replyMarkup: kb });
      if (r?.msgId) {
        await markSent({ taskId, chatId: CHAT, msgId: r.msgId });
        console.log(`[${TZ}] ✅ TG отправлено taskId=${taskId}, msg_id=${r.msgId}`);
        sent++;
      } else {
        console.log(`[${TZ}] ⚠️ TG отправлено, но msg_id не получен taskId=${taskId}`);
      }
    } catch (e) {
      const em = String(e?.message || e);
      console.log(`[${TZ}] ⛔ Ошибка отправки TG taskId=${taskId}: ${em}`);
    }

    await sleep(900);
  }

  console.log(
    `✅ [${TZ}] Готово. Сохранено: ${saved}, отправлено: ${sent}, пропущено: ${skipped}`,
  );
  process.exit(0);
}

main().catch(e => {
  console.error('bonusesFromGizmo fatal:', e?.message || e);
  process.exit(1);
});
