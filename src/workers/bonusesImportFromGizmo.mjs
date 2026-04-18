// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/bonusesFromGizmo.mjs
// Импорт бонусных транзакций из Gizmo transactionslog за смену
// + запрос статуса у админов в TG через кнопки "Акция" / "Компенсация"

import '../env.js';

import crypto from 'crypto';
import { q } from '../db.js';
import { gizmoFetch } from '../gizmoClient.js';
import { send } from '../tg.js';

const TZ = process.env.TZ || 'Europe/Moscow';

// Чат только из env как ты сказал
const CHAT = process.env.TG_CHAT_TEST || '';
if (!CHAT) {
  console.log(`⛔ [${TZ}] TG_CHAT_TEST не задан. Выходим.`);
  process.exit(2);
}

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

function toGizmoTime(d) {
  // как в твоём gizmoTransactionsShiftReport.mjs
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    'T' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds()) +
    '.000'
  );
}

function parseGizmoDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
}

function toMySQLDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' +
    pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes()) + ':' +
    pad(d.getSeconds())
  );
}

// ===== CLI =====
const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const f = argv.find(a => a.startsWith(pref));
  return f ? f.substring(pref.length) : def;
}

let SHIFT_ID = getArg('shiftId', null) || getArg('shift', null);
if (!SHIFT_ID && argv.length) {
  const maybeNum = Number(argv[0]);
  if (!Number.isNaN(maybeNum) && String(maybeNum) === argv[0]) SHIFT_ID = maybeNum;
}
if (!SHIFT_ID) {
  console.log(`⛔ [${TZ}] Укажи смену: --shiftId=1504 (или просто 1504).`);
  process.exit(2);
}

const COUNT_ARG = getArg('count', null);
const COUNT = COUNT_ARG !== null ? Number(COUNT_ARG) : null;

const NO_TG = argv.includes('--no-tg');      // только записать в БД
const ONLY_NEW = argv.includes('--only-new'); // не слать, если уже есть msg_id (защита от дублей)

async function loadShiftById(shiftId) {
  const rows = await q(
    `
      SELECT shift_id, is_active, start_time, end_time, operator_name
      FROM shift_data
      WHERE shift_id = ?
      LIMIT 1
    `,
    [shiftId]
  );
  return rows[0] || null;
}

function isBonusTransaction(t) {
  const method = String(t.paymentMethodName ?? '').toLowerCase();
  // в твоей логике бонус определяется по "бонус"
  return method.includes('бонус') || method.includes('bonus');
}

async function main() {
  const s = await loadShiftById(SHIFT_ID);
  if (!s) {
    console.log(`⛔ [${TZ}] shift_id=${SHIFT_ID} не найден в shift_data.`);
    process.exit(1);
  }
  if (!s.start_time || !s.end_time) {
    console.log(`⛔ [${TZ}] shift_id=${SHIFT_ID}: нет start_time или end_time.`);
    process.exit(1);
  }

  const dtFrom = new Date(s.start_time);
  const dtTo = new Date(s.end_time);

  console.log(`🔍 [${TZ}] Смена ${s.shift_id}: ${formatForLog(dtFrom)} → ${formatForLog(dtTo)} (is_active=${s.is_active})`);

  // ---- Gizmo transactionslog
  const params = new URLSearchParams({
    DateFrom: toGizmoTime(dtFrom),
    DateTo: toGizmoTime(dtTo),
  });

  let gizmoResp;
  try {
    gizmoResp = await gizmoFetch(`/api/reports/transactionslog?${params}`, {
      method: 'GET',
      apiVersion: 1,
    });
  } catch (e) {
    console.log(`⛔ [${TZ}] Ошибка запроса к Gizmo: ${e?.message || String(e)}`);
    process.exit(1);
  }

  let trxs = Array.isArray(gizmoResp?.result?.transactions) ? gizmoResp.result.transactions : [];
  console.log(`📦 [${TZ}] Получено транзакций Gizmo: ${trxs.length}`);

  // фильтр бонусов
  trxs = trxs.filter(isBonusTransaction);

  // выкидываем нулевые
  trxs = trxs.filter(t => {
    const val = (t.total != null) ? Number(t.total) : (t.value != null) ? Number(t.value) : 0;
    return !!val;
  });

  // сортируем по времени
  trxs.sort((a, b) => {
    const da = parseGizmoDate(a.transactionDate);
    const db = parseGizmoDate(b.transactionDate);
    return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
  });

  if (COUNT !== null && trxs.length > COUNT) trxs = trxs.slice(-COUNT);

  console.log(`🎁 [${TZ}] Бонусных транзакций: ${trxs.length}`);

  if (!trxs.length) {
    console.log(`✅ [${TZ}] За смену бонусов нет. Выходим.`);
    process.exit(0);
  }

  let saved = 0;
  let sent = 0;

  for (const t of trxs) {
    const trxTime = parseGizmoDate(t.transactionDate);
    if (!trxTime) continue;

    const amount = (t.total != null) ? Number(t.total) : (t.value != null) ? Number(t.value) : 0;
    if (!amount) continue;

    const customer = String(t.customerName ?? '').trim() || '—';
    const operator = String(t.operatorName ?? '').trim() || null;
    const title = String(t.title ?? '').trim() || null;
    const invoiceId = t.invoiceId != null ? String(t.invoiceId) : null;

    // trx_id в transactionslog может не быть — поэтому делаем стабильный uniq
    const uniq = sha1([
      toMySQLDateTime(trxTime),
      customer,
      amount.toFixed(2),
      String(title || ''),
      String(invoiceId || ''),
      String(t.paymentMethodName || '')
    ].join('|'));

    // insert or get existing
    const ins = await q(
      `
      INSERT INTO bonus_tasks
        (shift_id, trx_id, trx_time, client_name, amount, operator_name, title, invoice_id, status, uniq_hash, created_at, updated_at)
      VALUES
        (?, NULL, ?, ?, ?, ?, ?, ?, 'open', ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        updated_at = NOW()
      `,
      [s.shift_id, trxTime, customer, amount, operator, title, invoiceId, uniq]
    );

    let taskId = ins.insertId || 0;
    if (!taskId) {
      const rr = await q(`SELECT id, status, msg_id FROM bonus_tasks WHERE shift_id=? AND uniq_hash=? LIMIT 1`, [s.shift_id, uniq]);
      if (!rr.length) continue;
      taskId = rr[0].id;

      // если only-new и уже отправляли — пропускаем отправку
      if (ONLY_NEW && rr[0].msg_id) {
        console.log(`[${TZ}] ⏩ Уже отправлено ранее taskId=${taskId} (msg_id есть) — пропуск TG`);
        saved++;
        continue;
      }
    }

    saved++;

    if (NO_TG) continue;

    const kb = {
      inline_keyboard: [[
        { text: '🎯 Акция',        callback_data: `bonus:promo:${taskId}` },
        { text: '🧾 Компенсация',  callback_data: `bonus:comp:${taskId}` }
      ]]
    };

    const msg =
      `<b>Бонус</b> <b>${amount.toFixed(2)} ₽</b>\n` +
      `👤 ${customer}\n` +
      `🕒 <b>${timeLabelTZ(trxTime)}</b>\n` +
      `❓ Уточни тип: акция или компенсация?`;

    try {
      const resp = await send(CHAT, msg, {
        reply_markup: JSON.stringify(kb),
        parse_mode: 'HTML',
      });

      const msgId =
        resp && (resp.message_id || resp.result?.message_id)
          ? (resp.message_id || resp.result.message_id)
          : null;

      await q(
        `UPDATE bonus_tasks SET msg_chat_id=?, msg_id=?, updated_at=NOW() WHERE id=?`,
        [CHAT, msgId, taskId]
      );

      sent++;
      console.log(`[${TZ}] ✅ TG отправлено taskId=${taskId}, msg_id=${msgId || '??'}`);
    } catch (e) {
      if (String(e.message || '').includes('429')) {
        console.log(`[${TZ}] ⛔ Telegram 429 Too Many Requests — стопим рассылку`);
        break;
      }
      console.log(`[${TZ}] ⛔ Ошибка TG:`, e?.message || e);
    }

    await sleep(900);
  }

  console.log(`✅ [${TZ}] Готово. Сохранено: ${saved}, отправлено: ${sent}`);
  process.exit(0);
}

main().catch(e => {
  console.log(`⛔ [${TZ}] Fatal:`, e?.message || e);
  process.exit(1);
});
