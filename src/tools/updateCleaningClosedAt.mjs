// src/tools/updateCleaningClosedAt.mjs
import '../env.js';
import { q } from '../db.js';

const argv = process.argv.slice(2);
function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a === `--${name}` || a.startsWith(pref));
  if (!found) return def;
  if (found === `--${name}`) return def;
  return found.slice(pref.length);
}

const shiftId = getArg('shiftId', null);

if (!shiftId) {
  console.log('usage: node src/tools/updateCleaningClosedAt.mjs --shiftId=1234');
  process.exit(1);
}

function toMysql(dt) {
  if (!dt) return null;
  if (typeof dt === 'string') return dt.replace('T', ' ').slice(0, 19);
  if (dt instanceof Date) {
    const pad = n => String(n).padStart(2, '0');
    return (
      dt.getFullYear() + '-' +
      pad(dt.getMonth() + 1) + '-' +
      pad(dt.getDate()) + ' ' +
      pad(dt.getHours()) + ':' +
      pad(dt.getMinutes()) + ':' +
      pad(dt.getSeconds())
    );
  }
  return String(dt);
}

console.log(`🔍 Ищем cleaning_tasks по смене ${shiftId}...`);

const tasks = await q(
  `SELECT id, session_id, place_id
     FROM cleaning_tasks
    WHERE shift_id = ?
      AND session_id IS NOT NULL
      AND session_id <> ''`,
  [shiftId]
);

if (!tasks.length) {
  console.log('⛔ По этой смене нет задач с session_id в cleaning_tasks.');
  process.exit(0);
}

const sessIds = tasks.map(t => t.session_id);
const placeholders = sessIds.map(() => '?').join(',');

// берём ВСЁ по этим session_id, чтобы можно было выбирать по месту
const sessions = await q(
  `SELECT *
     FROM session_data
    WHERE session_id IN (${placeholders})`,
  sessIds
);

// сгруппируем по session_id
const bySessionId = new Map();
for (const s of sessions) {
  const sid = String(s.session_id);
  if (!bySessionId.has(sid)) bySessionId.set(sid, []);
  bySessionId.get(sid).push(s);
}

let updated = 0;
let skippedDup = 0;
let ambiguous = 0;
let noMatch = 0;

for (const t of tasks) {
  const sid = String(t.session_id);
  const place = String(t.place_id || '').trim();

  const candidates = bySessionId.get(sid) || [];
  if (!candidates.length) {
    console.log(`⚠️ session_id=${sid} для task id=${t.id} не найден в session_data`);
    noMatch++;
    continue;
  }

  let chosen = null;

  if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    // пытаемся сопоставить по месту
    const placeLower = place.toLowerCase();
    chosen = candidates.find(c => {
      const hn = (c.hostName || c.hostname || c.host_number || c.hostNumber || c.host_name || c.host || '').toString().trim();
      return hn.toLowerCase() === placeLower;
    }) || null;

    if (!chosen) {
      // не нашли по месту — берём первую, но пометим
      chosen = candidates[0];
      console.log(`⚠️ неоднозначный выбор для task id=${t.id}, session_id=${sid}, place=${place} — берём первую строку из session_data (id=${chosen.id ?? '???'})`);
      ambiguous++;
    }
  }

  const endTime = chosen.end_time || chosen.closed_at || null;
  if (!endTime) {
    console.log(`⚠️ у session_data(id=${chosen.id ?? '???'}) для session_id=${sid} нет end_time/closed_at — пропуск`);
    continue;
  }

  const endTimeStr = toMysql(endTime);

  // проверяем уникальный индекс по place_id+closed_at
  const existing = await q(
    `SELECT id
       FROM cleaning_tasks
      WHERE place_id = ?
        AND closed_at = ?
        AND id <> ?
      LIMIT 1`,
    [place, endTimeStr, t.id]
  );

  if (existing.length) {
    console.log(
      `⚠️ пропуск id=${t.id} (place=${place}) — уже есть строка с таким closed_at (${endTimeStr})`
    );
    skippedDup++;
    continue;
  }

  const res = await q(
    `UPDATE cleaning_tasks
        SET closed_at = ?
      WHERE id = ?`,
    [endTimeStr, t.id]
  );
  if (res.affectedRows > 0) {
    updated++;
  }
}

console.log(
  `✅ Готово. Всего задач: ${tasks.length}, обновили closed_at: ${updated}, пропущено из-за дублей: ${skippedDup}, неоднозначных: ${ambiguous}, не нашли в session_data: ${noMatch}.`
);

process.exit(0);
