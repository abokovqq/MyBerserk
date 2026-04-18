// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/cleaningReport.mjs

import '../env.js';
import fs from 'fs';
import { q } from '../db.js';
import { send } from '../tg.js';
import { normalizeName } from '../utils/normalizeName.mjs';
import { renderTableToPng } from './tableRender.mjs';

function envNum(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const clean = raw.split('#')[0].trim();
  const n = Number(clean);
  return isNaN(n) ? null : n;
}

const TEST_MODE = String(process.env.TG_TEST_MODE || '').toLowerCase() === 'true';
let CHAT = TEST_MODE ? envNum('TG_CHAT_TEST') : envNum('TG_CHAT_CLEAN');
if (!CHAT) {
  console.log('no chat');
  process.exit(0);
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// =====================
// отправка фото в Telegram (как в sendTableReport.mjs)
// =====================
async function sendPhoto({ chatId, filePath, caption = '' }) {
  if (!BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  }
  if (!chatId) {
    throw new Error('chatId не задан');
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;

  const buffer = await fs.promises.readFile(filePath);
  const blob = new Blob([buffer]); // имя укажем ниже

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption);
  }
  form.append('photo', blob, 'cleaning_report.png');

  const res = await fetch(url, {
    method: 'POST',
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TG sendPhoto ${res.status}: ${text}`);
  }

  console.log('Telegram ответ:', text);
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

let shiftIdToUse = getArg('shiftId', null);

// ===== утилиты =====
function pad(str, len) {
  if (str == null) str = '';
  str = String(str);
  if (str.length >= len) return str;
  return str + ' '.repeat(len - str.length);
}

function normalizeWeirdName(name) {
  if (!name) return '';
  const noSpaces = name.replace(/\s+/g, '');
  if (name.indexOf(' ') !== -1 && noSpaces.length >= 2 && noSpaces.length <= 12) {
    return noSpaces;
  }
  return name;
}

function resolveUserNameFromRow(r) {
  let name = '';
  if (r.first_name && r.first_name.trim() !== '') {
    name = r.first_name.trim();
  } else if (r.actor_telegram_id) {
    name = 'id ' + r.actor_telegram_id;
  } else {
    name = 'admin';
  }

  name = normalizeWeirdName(name);
  // правило 6 символов
  name = normalizeName(name, 6);
  return name;
}

function formatTime(dtStr) {
  if (!dtStr) return '—';
  const d = new Date(dtStr);
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

function formatDateTime(dtStr) {
  if (!dtStr) return '—';
  const d = new Date(dtStr);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm} ${hh}:${mi}`;
}

function mapStatus(s) {
  if (!s) return 'нет';
  s = s.trim();
  if (s === 'open')   return 'нет';
  if (s === 'done')   return 'ок';
  if (s === 'other')  return 'б/у';
  if (s === 'noneed') return 'н/н';
  if (s === 'late')   return 'н/у';
  return s;
}

function formatPlace(placeRaw) {
  const s = String(placeRaw || '').trim();
  return s.replace('PC1', '№');
}

// ===== 1. смена =====
let shiftStatusLine = '';

if (shiftIdToUse) {
  const srows = await q(
    `SELECT shift_id, start_time, end_time, is_active
       FROM shift_data
      WHERE shift_id = ?
      LIMIT 1`,
    [shiftIdToUse]
  );
  if (!srows.length) {
    await send(CHAT, `Отчёт по уборке: смена ${shiftIdToUse} в shift_data не найдена.`);
    process.exit(0);
  }
  const s = srows[0];
  if (s.end_time) {
    shiftStatusLine = `(закрыта ${formatDateTime(s.end_time)})`;
  } else if (s.start_time) {
    shiftStatusLine = `(открыта ${formatDateTime(s.start_time)})`;
  }
} else {
  const srows = await q(
    `SELECT shift_id, start_time, end_time, is_active
       FROM shift_data
      WHERE is_active = 1
      ORDER BY start_time DESC
      LIMIT 1`
  );
  if (!srows.length) {
    await send(CHAT, 'Отчёт по уборке: активная смена (is_active=1) не найдена.');
    process.exit(0);
  }
  const s = srows[0];
  shiftIdToUse = s.shift_id;
  if (s.end_time) {
    shiftStatusLine = `(закрыта ${formatDateTime(s.end_time)})`;
  } else if (s.start_time) {
    shiftStatusLine = `(открыта ${formatDateTime(s.start_time)})`;
  }
}

// ===== 2. данные =====
// ВЗС: берём из closed_at, если нет — из created_at
const rows = await q(
  `SELECT id,
          place_id,
          actor_telegram_id,
          first_name,
          status,
          updated_at,
          created_at,
          closed_at
     FROM cleaning_tasks
    WHERE shift_id = ?
    ORDER BY
      (closed_at IS NULL),
      closed_at ASC,
      (created_at IS NULL),
      created_at ASC,
      updated_at ASC`,
  [shiftIdToUse]
);

if (!rows.length) {
  const parts = [
    `*Отчёт по уборке по смене ${shiftIdToUse}*`,
    shiftStatusLine ? shiftStatusLine : '',
    'записей нет.',
  ].filter(Boolean);
  await send(CHAT, parts.join('\n'), { parse_mode: 'Markdown' });
  process.exit(0);
}

// ===== 3. готовим данные для PNG (как было для текстовой таблицы) =====
const MAX_PLACE  = 3;
const MAX_ADMIN  = 6;
const MAX_STATUS = 4;
const MAX_VZS    = 5; // ВзС (текст в ячейке)
const MAX_VRU    = 5; // ВрУ

const tableData = rows.map(r => {
  const placeRaw = r.place_id ? String(r.place_id) : String(r.id);
  const placeFormatted = formatPlace(placeRaw);
  const place = placeFormatted.length > MAX_PLACE
    ? placeFormatted.slice(0, MAX_PLACE)
    : placeFormatted;

  const adminFull = resolveUserNameFromRow(r);
  const admin = adminFull.length > MAX_ADMIN
    ? adminFull.slice(0, MAX_ADMIN)
    : adminFull;

  const statusFull = mapStatus(r.status ? String(r.status).trim() : '');
  const status = statusFull.length > MAX_STATUS
    ? statusFull.slice(0, MAX_STATUS)
    : statusFull;

  // ВзС — closed_at, если его нет — created_at
  const vzsSrc  = r.closed_at || r.created_at;
  // В PNG для ВзС делаем ДД.ММ ЧЧ:ММ (как просилa)
  const vzsFull = vzsSrc ? formatDateTime(vzsSrc) : '—';
  const vzs = vzsFull.length > MAX_VZS
    ? vzsFull.slice(0, MAX_VZS)
    : vzsFull;

  // ВрУ — updated_at, НО если статус "нет" (open) → пусто
  let vruFull;
  if (statusFull === 'нет') {
    vruFull = '';
  } else {
    vruFull = r.updated_at ? formatTime(r.updated_at) : '—';
  }
  const vru = vruFull.length > MAX_VRU
    ? vruFull.slice(0, MAX_VRU)
    : vruFull;

  return { place, admin, status, vzs, vru };
});

// заголовки
let h_place  = 'ПК';
let h_admin  = 'Админ';
let h_status = 'Стат';
let h_vzs    = 'ВзС';
let h_vru    = 'ВрУ';

h_place  = h_place.length  > MAX_PLACE  ? h_place.slice(0, MAX_PLACE)   : h_place;
h_admin  = h_admin.length  > MAX_ADMIN  ? h_admin.slice(0, MAX_ADMIN)   : h_admin;
h_status = h_status.length > MAX_STATUS ? h_status.slice(0, MAX_STATUS) : h_status;
h_vzs    = h_vzs.length    > MAX_VZS    ? h_vzs.slice(0, MAX_VZS)       : h_vzs;
h_vru    = h_vru.length    > MAX_VRU    ? h_vru.slice(0, MAX_VRU)       : h_vru;

// строим массив строк для рендера PNG
const headerRow = [
  pad(h_place,  MAX_PLACE),
  pad(h_admin,  MAX_ADMIN),
  pad(h_status, MAX_STATUS),
  pad(h_vzs,    MAX_VZS),
  pad(h_vru,    MAX_VRU),
];

const dataRows = tableData.map(row => [
  pad(row.place,  MAX_PLACE),
  pad(row.admin,  MAX_ADMIN),
  pad(row.status, MAX_STATUS),
  pad(row.vzs,    MAX_VZS),
  pad(row.vru,    MAX_VRU),
]);

const tableRows = [headerRow, ...dataRows];

// ===== 4. рендерим PNG напрямую через renderTableToPng =====
const outPath = `/tmp/cleaning_shift_${shiftIdToUse}.png`;
const pngPath = renderTableToPng(tableRows, { outPath });
console.log('PNG сохранён в', pngPath);

// ===== 5. отправляем только картинку (без текстового отчёта) =====
const captionParts = [
  `🧹 Отчёт по уборке по смене ${shiftIdToUse}`,
  shiftStatusLine ? shiftStatusLine : '',
];
const caption = captionParts.filter(Boolean).join('\n');

await sendPhoto({
  chatId: CHAT,
  filePath: pngPath,
  caption,
});

process.exit(0);
