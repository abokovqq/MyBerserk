import 'dotenv/config';
import { gizmoFetch } from '../gizmoClient.js';
import { q } from '../db.js';
import { send } from '../tg.js';
import { kbCleaning } from '../keyboards.js';
import { chat } from '../config.js';

const CHAT = chat('CLEAN');
// сколько последних закрытых сессий обработать
const LAST_CLOSED_COUNT = 1;

// "сегодня" по серверному времени
const now = new Date();
const start = new Date(now); start.setHours(0,0,0,0);
const end   = new Date(now); end.setHours(23,59,59,999);

// 1. тянем все сегодняшние сессии
const qstr = `start=${start.toISOString()}&end=${end.toISOString()}&max=2000`;
const sessData = await gizmoFetch(`/api/usersessions?${qstr}`);
// у тебя usersessions возвращает {version:null, result:[...]}
const sessions = Array.isArray(sessData?.result)
  ? sessData.result
  : Array.isArray(sessData)
    ? sessData
    : [];

if (!sessions.length) {
  console.log('no sessions for today');
  process.exit(0);
}

// 2. только закрытые
const closed = sessions.filter(r => r.endTime);
if (!closed.length) {
  console.log('no closed sessions (with endTime) for today');
  process.exit(0);
}

// 3. сортируем по endTime и берём последние N
closed.sort((a, b) => (a.endTime > b.endTime ? 1 : -1));
const selected = closed.slice(-LAST_CLOSED_COUNT);

console.log(`will process ${selected.length} closed sessions`);

// кэш, чтобы по одному и тому же hostId не дёргать API ещё раз
const hostCache = new Map();

async function getHostById(hostId) {
  if (!hostId && hostId !== 0) return null;
  if (hostCache.has(hostId)) return hostCache.get(hostId);

  try {
    // у тебя есть /api/hosts/{hostId} по спецификации
    const h = await gizmoFetch(`/api/hosts/${hostId}`);
    // сервер у тебя любит оборачивать в {version:null, result: {...}}
    const host =
      (h && h.result && typeof h.result === 'object') ? h.result : h;
    hostCache.set(hostId, host);
    return host;
  } catch (e) {
    console.log(`cannot fetch host ${hostId}:`, e?.message || e);
    hostCache.set(hostId, null);
    return null;
  }
}

for (const sess of selected) {
  const hostId      = sess.hostId;
  const closedAtISO = sess.endTime;
  const userId      = sess.userId;
  const sessId      = sess.id;

  // 4. добираем нормальное имя/номер
  const host = await getHostById(hostId);
  const hostName   = host?.name || '';
  const hostNumber = (typeof host?.number === 'number') ? host.number : null;

  console.log('processing closed:', {
    hostId,
    hostName,
    hostNumber,
    closedAtISO,
    userId,
    sessId
  });

  // 5. создаём/находим задачу в БД
  const ins = await q(
    "INSERT INTO cleaning_tasks (place_id, closed_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)",
    [hostId, new Date(closedAtISO)]
  );
  const taskId = ins.insertId || (await (async () => {
    const r = await q(
      "SELECT id FROM cleaning_tasks WHERE place_id=? AND closed_at=?",
      [hostId, new Date(closedAtISO)]
    );
    return r[0]?.id;
  })());

  if (!taskId) {
    console.log('cannot obtain taskId for session', sessId);
    continue;
  }

  const markup = JSON.stringify(kbCleaning(taskId));

  // 6. собираем человекочитаемое имя
  let hostHuman;
  if (hostName && hostNumber != null) {
    hostHuman = `${hostName} / №${hostNumber}`;
  } else if (hostName) {
    hostHuman = hostName;
  } else if (hostNumber != null) {
    hostHuman = `№${hostNumber}`;
  } else {
    hostHuman = `hostId ${hostId}`;
  }

  await send(
    CHAT,
    `ТЕСТ v1: место ${hostHuman} (gizmo #${hostId}) закрыто в ${closedAtISO}.
Пользователь: ${userId}, сессия: ${sessId}.
Уборка?`,
    { reply_markup: markup }
  );

  console.log('sent to telegram for task', taskId);
}

process.exit(0);
