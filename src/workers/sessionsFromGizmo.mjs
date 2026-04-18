// src/workers/sessionsFromGizmo.mjs
import '../env.js';
import { gizmoFetch } from '../gizmoClient.js';
import { q } from '../db.js';

const TZ = process.env.TZ || 'Europe/Moscow';

// ============== helpers ==============
function nowTZ() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function toGizmoTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds()) +
    '.000'
  );
}

function parseISOorNull(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ============== CLI ==============
const argv = process.argv.slice(2);
function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a === `--${name}` || a.startsWith(pref));
  if (!found) return def;
  if (found === `--${name}`) return true;
  return found.slice(pref.length);
}

const DAYS_ARG = getArg('days', '1');
const FROM_ARG = getArg('from', null);
const TO_ARG = getArg('to', null);
const SHIFT_ARG = getArg('shiftId', null);

let dateFrom;
let dateTo;

if (SHIFT_ARG) {
  const rows = await q(
    'SELECT start_time, end_time FROM shift_data WHERE shift_id = ? LIMIT 1',
    [SHIFT_ARG]
  );
  if (!rows.length) {
    console.log(`⛔ Смена ${SHIFT_ARG} в shift_data не найдена.`);
    process.exit(0);
  }
  const r = rows[0];
  if (!r.start_time) {
    console.log(`⛔ У смены ${SHIFT_ARG} нет start_time.`);
    process.exit(0);
  }
  dateFrom = new Date(r.start_time);
  dateTo = r.end_time ? new Date(r.end_time) : nowTZ();
  console.log(`🔍 Берём sessionslog по смене ${SHIFT_ARG}: ${dateFrom.toISOString()} → ${dateTo.toISOString()}`);
} else if (FROM_ARG || TO_ARG) {
  dateFrom = FROM_ARG ? new Date(FROM_ARG) : nowTZ();
  dateFrom.setSeconds(0, 0);

  dateTo = TO_ARG ? new Date(TO_ARG) : nowTZ();
  dateTo.setSeconds(59, 999);
  console.log(`🔍 Берём sessionslog по датам: ${dateFrom.toISOString()} → ${dateTo.toISOString()}`);
} else {
  dateTo = nowTZ();
  dateFrom = new Date(dateTo);
  dateFrom.setDate(dateFrom.getDate() - (Number(DAYS_ARG) || 1));
  console.log(`🔍 Берём sessionslog за последние ${DAYS_ARG} дн.: ${dateFrom.toISOString()} → ${dateTo.toISOString()}`);
}

// ============== fetch ==============
const params = new URLSearchParams({
  DateFrom: toGizmoTime(dateFrom),
  DateTo: toGizmoTime(dateTo),
});
const rep = await gizmoFetch(`/api/reports/sessionslog?${params.toString()}`);
const root = rep?.result ? rep.result : rep;
const sessions = Array.isArray(root?.sessions)
  ? root.sessions
  : Array.isArray(root)
    ? root
    : [];

console.log(`📋 Получено сессий: ${sessions.length}`);

// ============== save ==============
for (const sess of sessions) {
  const sessionId = Number(sess.id) || 0;
  if (!sessionId) {
    console.log('⚠️ пропуск сессии без id', sess);
    continue;
  }

  const hostId = sess.hostId ? Number(sess.hostId) : null;
  const hostName = sess.hostName || null;
  const userId = sess.userId ? Number(sess.userId) : null;
  const userName = sess.userName || null;
  const shiftId = sess.shiftId ? Number(sess.shiftId) : null;

  const startTime = parseISOorNull(sess.startTime);
  const endTime = parseISOorNull(sess.endTime);

  const durationSec =
    typeof sess.duration === 'number'
      ? sess.duration
      : typeof sess.totalDuration === 'number'
        ? sess.totalDuration
        : null;

  const total =
    sess.total != null
      ? Number(sess.total)
      : sess.totalPrice != null
        ? Number(sess.totalPrice)
        : null;

  // теперь обновляем только точный дубликат сегмента
  const sql = `
    INSERT INTO session_data
      (session_id, host_id, host_name, user_id, user_name,
       shift_id, start_time, end_time, duration_sec, total,
       raw_json, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      end_time     = VALUES(end_time),
      duration_sec = VALUES(duration_sec),
      total        = VALUES(total),
      raw_json     = VALUES(raw_json),
      updated_at   = NOW()
  `;

  const paramsArr = [
    sessionId,
    hostId,
    hostName,
    userId,
    userName,
    shiftId,
    startTime ? startTime : null,
    endTime ? endTime : null,
    durationSec,
    total,
    JSON.stringify(sess),
  ];

  const res = await q(sql, paramsArr);

  if (res.affectedRows === 1) {
    console.log(
      `✅ session_id=${sessionId} сохранена (host=${hostName || hostId || '-'}, user=${userName || userId || '-'})`
    );
  } else if (res.affectedRows === 2) {
    console.log(`🔁 session_id=${sessionId} сегмент обновлён (host=${hostName || hostId || '-'})`);
  }
}

console.log('🏁 Готово.');
process.exit(0);
