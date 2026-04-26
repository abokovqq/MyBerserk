// /home/a/abokovsa/berserkclub.ru/MyBerserk/background/telegram/telegramProcessor.mjs

import dotenv from 'dotenv';
import { exec } from 'child_process';

const PROJECT_ROOT = '/home/a/abokovsa/berserkclub.ru/MyBerserk';
const ENV_PATH = `${PROJECT_ROOT}/.env`;

dotenv.config({ path: ENV_PATH });

const BOT_NAMES = [
  '@berserkgame7bot',
  '@berserkbot7',
];

const NODE_BIN = '/home/a/abokovsa/berserkclub.ru/bin/node';

const CLEANING_REPORT_MJS = `${PROJECT_ROOT}/src/tools/cleaningReport.mjs`;
const CLEANING_LOG = '/home/a/abokovsa/berserkclub.ru/logs/cleaning_exec.log';

const EVOTOR_PRODUCTS_REPORT_MJS = `${PROJECT_ROOT}/src/tools/evotorProductsReport.mjs`;
const EVOTOR_SESSION_REPORT_MJS = `${PROJECT_ROOT}/src/tools/evotorSessionReport.mjs`;
const EVOTOR_PRODUCTS_LOG = '/home/a/abokovsa/berserkclub.ru/logs/evotorProductsReport.log';
const EVOTOR_SESSION_LOG = '/home/a/abokovsa/berserkclub.ru/logs/evotorSessionReport.log';

const GIZMO_TX_REPORT_MJS = `${PROJECT_ROOT}/src/tools/gizmoTransactionsShiftReport.mjs`;
const GIZMO_TX_REPORT_LOG = '/home/a/abokovsa/berserkclub.ru/logs/gizmoTransactionsShiftReport.log';

const INVENTORY_TO_SHEET_MJS = `${PROJECT_ROOT}/src/workers/inventoryToSheet.mjs`;
const INVENTORY_DIFF_REPORT_MJS = `${PROJECT_ROOT}/src/workers/inventoryDiffReport.mjs`;
const INVENTORY_TO_SHEET_LOG = '/home/a/abokovsa/berserkclub.ru/logs/inventoryToSheet.log';
const INVENTORY_DIFF_LOG = '/home/a/abokovsa/berserkclub.ru/logs/inventoryDiffReport.log';

const WEEKLY_SCHEDULE_POST_MJS = `${PROJECT_ROOT}/src/workers/weeklySchedulePost.mjs`;
const WEEKLY_SCHEDULE_POST_LOG = '/home/a/abokovsa/berserkclub.ru/logs/weeklySchedulePost.log';

function envNum(name) {
  const raw = process.env[name];
  if (raw == null) return null;
  const clean = String(raw).split('#')[0].trim();
  if (!clean) return null;
  const n = Number.parseInt(clean, 10);
  return Number.isNaN(n) ? null : n;
}

function shortText(value, limit = 150) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function extractUpdateMeta(upd) {
  const meta = {
    update_id: typeof upd?.update_id === 'number' ? upd.update_id : null,
    kind: 'unknown',
    chat_id: null,
    message_id: null,
    tg_date: null,
    text: '',
    text_preview: '',
    callback_data: '',
    callback_id: null,
    callback_from_name: '',
    callback_from_id: null,
  };

  if (upd?.message && typeof upd.message === 'object') {
    const msg = upd.message;
    meta.kind = 'message';
    meta.chat_id = msg?.chat?.id ?? null;
    meta.message_id = msg?.message_id ?? null;
    meta.tg_date = typeof msg?.date === 'number' ? msg.date : null;
    meta.text = String(msg?.text ?? msg?.caption ?? '').trim();
    meta.text_preview = shortText(meta.text);
    return meta;
  }

  if (upd?.edited_message && typeof upd.edited_message === 'object') {
    const msg = upd.edited_message;
    meta.kind = 'edited_message';
    meta.chat_id = msg?.chat?.id ?? null;
    meta.message_id = msg?.message_id ?? null;
    meta.tg_date = typeof msg?.date === 'number' ? msg.date : null;
    meta.text = String(msg?.text ?? msg?.caption ?? '').trim();
    meta.text_preview = shortText(meta.text);
    return meta;
  }

  if (upd?.callback_query && typeof upd.callback_query === 'object') {
    const cb = upd.callback_query;
    meta.kind = 'callback_query';
    meta.callback_id = cb?.id ?? null;
    meta.callback_data = shortText(cb?.data ?? '');
    meta.chat_id = cb?.message?.chat?.id ?? null;
    meta.message_id = cb?.message?.message_id ?? null;
    meta.tg_date = typeof cb?.message?.date === 'number' ? cb.message.date : null;
    meta.callback_from_id = cb?.from?.id ?? null;

    const firstName = cb?.from?.first_name ?? '';
    const username = cb?.from?.username ?? '';
    meta.callback_from_name = String(firstName || username || 'Админ').trim();

    return meta;
  }

  return meta;
}

async function tgApiPost(token, method, fields) {
  const url = `https://api.telegram.org/bot${token}/${method}`;

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, typeof value === 'string' ? value : String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      signal: controller.signal,
    });

    const text = await res.text();
    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: 'bad_json', http: res.status, raw_prefix: text.slice(0, 500) };
    }

    return json;
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'abort_timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function tgSend(token, chatId, text) {
  if (!token || !chatId) return null;
  return tgApiPost(token, 'sendMessage', {
    chat_id: chatId,
    text,
  });
}

async function tgEditMessageText(token, chatId, messageId, text, parseMode = null, replyMarkup = null) {
  const fields = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };
  if (parseMode) fields.parse_mode = parseMode;
  if (replyMarkup) fields.reply_markup = JSON.stringify(replyMarkup);
  return tgApiPost(token, 'editMessageText', fields);
}

async function tgEditMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  return tgApiPost(token, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: JSON.stringify(replyMarkup),
  });
}

async function tgAnswerCallback(token, callbackQueryId, text, showAlert = false) {
  return tgApiPost(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert ? 'true' : 'false',
  });
}

function runMjsAsync(logLine, mjsPath, logPath, args = []) {
  let cmd = `cd ${shellEscape(PROJECT_ROOT)} && ${shellEscape(NODE_BIN)} ${shellEscape(mjsPath)}`;
  for (const arg of args) {
    cmd += ` ${shellEscape(arg)}`;
  }
  cmd += ` >> ${shellEscape(logPath)} 2>&1 &`;

  logLine(`[mjs-async] ${cmd}`);

  exec(cmd, { shell: '/bin/bash' }, () => {});
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseShiftFromText(text, names) {
  if (typeof text !== 'string') return null;

  let work = text;
  for (const bn of names) {
    const re = new RegExp(escapeRegExp(bn), 'ig');
    work = work.replace(re, ' ');
  }

  let m = work.match(/смен[аеу]?\s+(\d+)/iu);
  if (m) return Number.parseInt(m[1], 10);

  const allNums = work.match(/\d+/g);
  if (allNums && allNums.length) {
    return Number.parseInt(allNums[allNums.length - 1], 10);
  }

  return null;
}

function parseCheckShiftStrict(cleanTextLower) {
  if (typeof cleanTextLower !== 'string') return null;
  const m = cleanTextLower.match(/(?:^|\s)чек(?:\s+(\d+))?(?:\s|$)/u);
  if (m && m[1]) return Number.parseInt(m[1], 10);
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tgMessageText(msg) {
  if (typeof msg?.text === 'string') return msg.text.trim();
  if (typeof msg?.caption === 'string') return msg.caption.trim();
  return '';
}

function normalizeOnlineInline(line) {
  let s = String(line ?? '').trim();
  if (!s) return '';

  s = s.replace(/^👥\s*Онлайн\s*:\s*/iu, '👥 ');
  s = s.replace(/^Онлайн\s*:\s*/iu, '👥 ');
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

function extractCleaningHeaderLine(msg, fallbackPlace = '') {
  const text = tgMessageText(msg);

  if (text) {
    const lines = text
      .split(/\r?\n/u)
      .map(v => String(v ?? '').trim())
      .filter(Boolean);

    let placeLine = '';
    let onlineLine = '';

    for (const raw of lines) {
      let line = String(raw ?? '').trim();
      if (!line) continue;

      if (/^(?:✅|✏️|❓|👮|🧹|🚫|⏳|🟦)/u.test(line)) continue;
      if (/^Текущий:\s*/iu.test(line)) continue;
      if (/^Статус уборки\b/iu.test(line)) continue;

      const m = line.match(/^ПК:\s*(.+)$/iu);
      if (m) line = m[1].trim();

      if (/(?:^|[\s])(?:№\s*\d+|No\s*\d+|PC\d+)/iu.test(line)) {
        if (!placeLine) placeLine = line.replace(/\s+/g, ' ').trim();
        continue;
      }

      if (/^👥\s*/u.test(line) || /^Онлайн\s*:/iu.test(line)) {
        if (!onlineLine) onlineLine = normalizeOnlineInline(line);
        continue;
      }
    }

    if (placeLine && onlineLine && !/👥/u.test(placeLine)) {
      return `${placeLine} ${onlineLine}`.replace(/\s+/g, ' ').trim();
    }

    if (placeLine) {
      return placeLine;
    }

    const fb = String(fallbackPlace ?? '').trim();

    if (fb && onlineLine) {
      return `${fb} ${onlineLine}`.replace(/\s+/g, ' ').trim();
    }

    if (fb) return fb;
  }

  const fb = String(fallbackPlace ?? '').trim();
  return fb || '';
}

function buildBonusEditKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: '🎯 Акция', callback_data: `bonus:promo:${taskId}` },
        { text: '💼 Босс', callback_data: `bonus:boss:${taskId}` },
        { text: '🛠 Админ', callback_data: `bonus:admin:${taskId}` },
      ],
      [
        { text: '↩️ Отмена', callback_data: `bonus:cancel:${taskId}` },
      ],
    ],
  };
}

function buildBonusMarkedKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: '✏️ Изменить', callback_data: `bonus:edit:${taskId}` },
      ],
    ],
  };
}

function bonusStatusLabel(status) {
  const st = String(status ?? '').toLowerCase();
  if (st === 'promo') return '🎯 Акция';
  if (st === 'boss') return '💼 Босс';
  if (st === 'admin') return '🛠️ Админ';
  return '—';
}

function buildCleaningEditKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: '🧹 Убрано', callback_data: `cleaning:done:${taskId}` },
        { text: '🚫 Не нужно', callback_data: `cleaning:noneed:${taskId}` },
        { text: '⏳ Не успел', callback_data: `cleaning:late:${taskId}` },
      ],
      [
        { text: '↩️ Отмена', callback_data: `cleaning:cancel:${taskId}` },
      ],
    ],
  };
}

function buildCleaningMarkedKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: '✏️ Изменить', callback_data: `cleaning:edit:${taskId}` },
      ],
    ],
  };
}

function cleaningStatusLabel(status) {
  const st = String(status ?? '').toLowerCase();
  if (st === 'done') return '🧹 Убрано';
  if (st === 'noneed') return '🚫 Не нужно';
  if (st === 'late') return '⏳ Не успел';
  if (st === 'other') return '🟦 Прочее';
  if (st === 'open') return '❓ Нет';
  return st || '—';
}

function formatCleaningPlace(placeRaw) {
  return String(placeRaw ?? '').trim().replace('PC1', '№');
}

async function handleScheduleNew(upd, botToken, logLine) {
  const scheduleChatId = envNum('TG_CHAT_SCHEDULE');
  if (!scheduleChatId) return false;

  let msg = null;
  let msgType = '';

  if (upd?.message) {
    msg = upd.message;
    msgType = 'message';
  } else if (upd?.edited_message) {
    msg = upd.edited_message;
    msgType = 'edited_message';
  }

  if (!msg) {
    logLine('[schedule] skip: no message/edited_message');
    return false;
  }

  const chatId = String(msg?.chat?.id ?? '');
  const text = String(msg?.text ?? '').trim();

  logLine(`[schedule] msgType=${msgType} chatId=${chatId} needChatId=${scheduleChatId} text=${text.replace(/\r?\n/g, ' ')}`);

  if (chatId !== String(scheduleChatId)) {
    logLine('[schedule] skip: chatId mismatch');
    return false;
  }

  if (!text) {
    logLine('[schedule] skip: empty text');
    return false;
  }

  const t = text.toLowerCase();
  const isNew = /^\/new$/iu.test(t) || /^@berserkgame7bot\s+new$/iu.test(t);

  if (!isNew) {
    logLine(`[schedule] skip: not allowed command: ${text}`);
    return false;
  }

  logLine(`[schedule] TRIGGER OK: ${text}`);

  const resp = await tgSend(botToken, chatId, 'Ок, обновляю расписание…');
  logLine(`[schedule] sendMessage ok=${resp?.ok ? '1' : '0'}`);

  runMjsAsync(logLine, WEEKLY_SCHEDULE_POST_MJS, WEEKLY_SCHEDULE_POST_LOG);
  return true;
}

async function handleBonusCallback(pool, botToken, upd, meta, logLine) {
  const cb = upd.callback_query;
  const cbId = cb?.id ?? null;
  const cbData = String(cb?.data ?? '').trim();
  const fromName = meta.callback_from_name || 'Админ';
  const msgChatId = cb?.message?.chat?.id ?? null;
  const msgId = cb?.message?.message_id ?? null;

  let m = cbData.match(/^bonus:(promo|boss|admin):(\d+)$/i);
  if (!m) m = cbData.match(/^bonus:(edit|cancel):(\d+)$/i);
  if (!m) return false;

  const mode = m[1].toLowerCase();
  const taskId = Number.parseInt(m[2], 10);

  if (!(taskId > 0)) {
    if (cbId) await tgAnswerCallback(botToken, cbId, 'Некорректные данные', false);
    return true;
  }

  const [rows] = await pool.execute(
    'SELECT status, client_name, amount FROM bonus_tasks WHERE id = ? LIMIT 1',
    [taskId]
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    if (cbId) await tgAnswerCallback(botToken, cbId, 'Задача не найдена', false);
    return true;
  }

  const row = rows[0];
  const client = row.client_name ?? '';
  const amount = Number(row.amount ?? 0);
  const curStatus = String(row.status ?? 'open').toLowerCase();

  if (mode === 'edit') {
    if (cbId) await tgAnswerCallback(botToken, cbId, 'Выберите новый тип', false);

    if (msgChatId && msgId) {
      const curLabel = bonusStatusLabel(curStatus);
      const text =
        `✏️ <b>Изменение типа бонуса</b>\n`
        + `Текущий: <b>${curLabel}</b>\n\n`
        + `👤 ${escapeHtml(client)}\n`
        + `💰 <b>${amount.toFixed(2)} ₽</b>\n`
        + `👮 ${escapeHtml(fromName)}`;

      await tgEditMessageText(botToken, msgChatId, msgId, text, 'HTML');
      await tgEditMessageReplyMarkup(botToken, msgChatId, msgId, buildBonusEditKeyboard(taskId));
    }

    return true;
  }

  if (mode === 'cancel') {
    if (cbId) await tgAnswerCallback(botToken, cbId, 'Отмена', false);

    if (msgChatId && msgId) {
      const curLabel = bonusStatusLabel(curStatus);
      const text =
        `✅ <b>Отмечено:</b> ${curLabel}\n`
        + `👤 ${escapeHtml(client)}\n`
        + `💰 <b>${amount.toFixed(2)} ₽</b>\n`
        + `👮 ${escapeHtml(fromName)}`;

      await tgEditMessageText(botToken, msgChatId, msgId, text, 'HTML');
      await tgEditMessageReplyMarkup(botToken, msgChatId, msgId, buildBonusMarkedKeyboard(taskId));
    }

    return true;
  }

  let status = null;
  let statusLabel = '';

  if (mode === 'promo') {
    status = 'promo';
    statusLabel = '🎯 Акция';
  } else if (mode === 'boss') {
    status = 'boss';
    statusLabel = '💼 Босс';
  } else if (mode === 'admin') {
    status = 'admin';
    statusLabel = '🛠️ Админ';
  }

  if (!status) {
    if (cbId) await tgAnswerCallback(botToken, cbId, 'Некорректные данные', false);
    return true;
  }

  const same = curStatus === status;

  if (!same) {
    await pool.execute(
      `
      UPDATE bonus_tasks
         SET status = ?,
             decided_by = ?,
             decided_at = NOW(),
             updated_at = NOW()
       WHERE id = ?
       LIMIT 1
      `,
      [status, fromName, taskId]
    );
  } else {
    await pool.execute(
      `
      UPDATE bonus_tasks
         SET updated_at = NOW()
       WHERE id = ?
       LIMIT 1
      `,
      [taskId]
    );
  }

  if (cbId) await tgAnswerCallback(botToken, cbId, `${statusLabel} ✓`, false);

  if (msgChatId && msgId) {
    const text =
      `✅ <b>Отмечено:</b> ${statusLabel}\n`
      + `👤 ${escapeHtml(client)}\n`
      + `💰 <b>${amount.toFixed(2)} ₽</b>\n`
      + `👮 ${escapeHtml(fromName)}`;

    await tgEditMessageText(botToken, msgChatId, msgId, text, 'HTML');
    await tgEditMessageReplyMarkup(botToken, msgChatId, msgId, buildBonusMarkedKeyboard(taskId));
  }

  logLine(`bonus_tasks UPDATE id=${taskId}, status=${status}, by=${fromName}, same=${same ? '1' : '0'}`);
  return true;
}

async function handleCleaningCallback(pool, botToken, upd, meta, logLine) {
  const cb = upd.callback_query;
  const cbId = cb?.id ?? null;
  const cbData = String(cb?.data ?? '').trim();
  const fromId = meta.callback_from_id ?? null;
  const fromName = meta.callback_from_name || 'Админ';
  const msgChatId = cb?.message?.chat?.id ?? null;
  const msgId = cb?.message?.message_id ?? null;
  const msg = cb?.message ?? {};

  let m = cbData.match(/^cleaning:(done|other|noneed|late):(\d+)$/i);
  if (!m) m = cbData.match(/^cleaning:(edit|cancel):(\d+)$/i);
  if (!m) return false;

  const mode = m[1].toLowerCase();
  const taskId = Number.parseInt(m[2], 10);

  if (!(taskId > 0)) {
    if (cbId) await tgAnswerCallback(botToken, cbId, 'Некорректные данные', false);
    return true;
  }

  const [rows] = await pool.execute(
    `
    SELECT id, place_id, status, actor_telegram_id, first_name, updated_at, created_at, closed_at
      FROM cleaning_tasks
     WHERE id = ?
     LIMIT 1
    `,
    [taskId]
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    if (cbId) await tgAnswerCallback(botToken, cbId, 'Задача не найдена', false);
    return true;
  }

  const row = rows[0];
  const placeRaw = row.place_id ?? `id ${taskId}`;
  const place = formatCleaningPlace(placeRaw);
  const curStatus = String(row.status ?? 'open').toLowerCase();
  const headerLine = extractCleaningHeaderLine(msg, place);
  const headerHtml = escapeHtml(headerLine);

  if (mode === 'edit') {
    if (cbId) await tgAnswerCallback(botToken, cbId, 'Выберите новый статус', false);

    if (msgChatId && msgId) {
      const curLabel = cleaningStatusLabel(curStatus);
      const text =
        `✏️ <b>Изменение статуса уборки</b>\n`
        + `<b>${headerHtml}</b>\n`
        + `Текущий: <b>${curLabel}</b>\n`
        + `👮 ${escapeHtml(fromName)}`;

      await tgEditMessageText(botToken, msgChatId, msgId, text, 'HTML');
      await tgEditMessageReplyMarkup(botToken, msgChatId, msgId, buildCleaningEditKeyboard(taskId));
    }

    return true;
  }

  if (mode === 'cancel') {
    if (cbId) await tgAnswerCallback(botToken, cbId, 'Отмена', false);

    if (msgChatId && msgId) {
      const curLabel = cleaningStatusLabel(curStatus);
      const text =
        `✅ <b>Отмечено:</b> ${curLabel}\n`
        + `<b>${headerHtml}</b>\n`
        + `👮 ${escapeHtml(fromName)}`;

      await tgEditMessageText(botToken, msgChatId, msgId, text, 'HTML');
      await tgEditMessageReplyMarkup(botToken, msgChatId, msgId, buildCleaningMarkedKeyboard(taskId));
    }

    return true;
  }

  let status = 'other';
  if (mode === 'done') status = 'done';
  if (mode === 'late') status = 'late';
  if (mode === 'noneed') status = 'noneed';
  if (mode === 'other') status = 'other';

  const statusLabel = cleaningStatusLabel(status);
  const same = curStatus === status;

  await pool.execute(
    `
    UPDATE cleaning_tasks
       SET status = ?,
           actor_telegram_id = ?,
           first_name = ?,
           updated_at = NOW()
     WHERE id = ?
     LIMIT 1
    `,
    [status, fromId, fromName, taskId]
  );

  logLine(`cleaning UPDATE id=${taskId}, status=${status}, by=${fromName}, same=${same ? '1' : '0'}`);

  if (cbId) await tgAnswerCallback(botToken, cbId, `Статус: ${statusLabel} ✓`, false);

  if (msgChatId && msgId) {
    const text =
      `✅ <b>Отмечено:</b> ${statusLabel}\n`
      + `<b>${headerHtml}</b>\n`
      + `👮 ${escapeHtml(fromName)}`;

    await tgEditMessageText(botToken, msgChatId, msgId, text, 'HTML');
    await tgEditMessageReplyMarkup(botToken, msgChatId, msgId, buildCleaningMarkedKeyboard(taskId));
  }

  return true;
}

async function processMessage(upd, meta, botToken, logLine) {
  const chatId = upd?.message?.chat?.id ?? null;
  const text = String(upd?.message?.text ?? '');
  if (!chatId || !text) return;

  const CHAT_TEST = envNum('TG_CHAT_TEST');
  const CHAT_REPORT = envNum('TG_CHAT_REPORT');
  const CHAT_INVENTORY = envNum('TG_CHAT_INVENTORY');

  const lower = text.toLowerCase();

  let mentioned = false;
  for (const bn of BOT_NAMES) {
    if (lower.includes(bn.toLowerCase())) {
      mentioned = true;
      break;
    }
  }

  let clean = lower;
  for (const bn of BOT_NAMES) {
    const re = new RegExp(escapeRegExp(bn.toLowerCase()), 'ig');
    clean = clean.replace(re, ' ');
  }
  clean = clean.replace(/\s+/g, ' ').trim();

  if (chatId === CHAT_INVENTORY && mentioned) {
    if (clean === 'инвентаризация') {
      let inventFlag = '0';
      if (process.env.INVENT_CLEAR_ON_START) {
        inventFlag = String(process.env.INVENT_CLEAR_ON_START).split('#')[0].trim();
      }

      let msgText = '';
      if (inventFlag === '1') {
        msgText = 'Формирую лист Data по данным Эвотор…';
        runMjsAsync(logLine, INVENTORY_TO_SHEET_MJS, INVENTORY_TO_SHEET_LOG, [`--chatId=${chatId}`]);
      } else {
        msgText = 'Идёт инвентаризация. Повторное обновление данных возможно только после окончания инвентаризации.';
      }

      await tgSend(botToken, chatId, msgText);
      return;
    }

    if (clean === 'конецинвент') {
      await tgSend(botToken, chatId, 'Формирую лист «Расхождение» и отправляю картинку…');
      runMjsAsync(logLine, INVENTORY_DIFF_REPORT_MJS, INVENTORY_DIFF_LOG, [`--chatId=${chatId}`]);
      return;
    }
  }

  let m = lower.match(/товар(?:\s+(\d+))?/u);
  if (mentioned && m) {
    const sessionNumber = m[1] ? Number.parseInt(m[1], 10) : null;
    const args = [];

    if (sessionNumber != null) {
      args.push(`--sessionNumber=${sessionNumber}`);
      args.push('--preferOpen=false');
    } else {
      args.push('--preferOpen=true');
    }
    args.push(`--chatId=${chatId}`);

    runMjsAsync(logLine, EVOTOR_PRODUCTS_REPORT_MJS, EVOTOR_PRODUCTS_LOG, args);
    return;
  }

  m = lower.match(/смена(?:\s+(\d+))?/u);
  if (mentioned && m) {
    const sessionNumber = m[1] ? Number.parseInt(m[1], 10) : null;
    const args = [];

    if (sessionNumber != null) {
      args.push(`--sessionNumber=${sessionNumber}`);
      args.push('--preferOpen=false');
    } else {
      args.push('--preferOpen=true');
    }
    args.push(`--chatId=${chatId}`);

    runMjsAsync(logLine, EVOTOR_SESSION_REPORT_MJS, EVOTOR_SESSION_LOG, args);
    return;
  }

  logLine(`[check] chat_id=${chatId} CHAT_TEST=${CHAT_TEST} CHAT_REPORT=${CHAT_REPORT} clean=${clean}`);

  if (mentioned && /(^|\s)чек(?:\s|$)/u.test(clean)) {
    if (chatId !== CHAT_TEST && chatId !== CHAT_REPORT) {
      logLine(`[check] skip by chat restriction chat_id=${chatId}`);
      return;
    }

    const shiftId = parseCheckShiftStrict(clean);
    const args = [`--chatId=${chatId}`];

    if (shiftId != null && shiftId > 0) {
      args.push(`--shift=${shiftId}`);
    }

    runMjsAsync(logLine, GIZMO_TX_REPORT_MJS, GIZMO_TX_REPORT_LOG, args);
    return;
  }

  const needReport =
    lower.includes('отчет') ||
    lower.includes('отчёт') ||
    lower.includes('статус');

  if (mentioned && needReport) {
    const shiftId = parseShiftFromText(text, BOT_NAMES);
    const args = shiftId != null ? [`--shiftId=${shiftId}`] : [];
    runMjsAsync(logLine, CLEANING_REPORT_MJS, CLEANING_LOG, args);
  }
}

export async function processTelegramUpdate({ row, pool, logLine }) {
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is empty');
  }

  let upd = null;
  try {
    upd = JSON.parse(row.payload);
  } catch (err) {
    throw new Error(`JSON parse failed: ${String(err?.message || err)}`);
  }

  const meta = extractUpdateMeta(upd);

  logLine(
    `process id=${row.id}`
    + ` kind=${meta.kind}`
    + ` chat_id=${meta.chat_id ?? 'null'}`
    + ` message_id=${meta.message_id ?? 'null'}`
    + ` text=${meta.text_preview || '-'}`
    + ` cb=${meta.callback_data || '-'}`
  );

  if (await handleScheduleNew(upd, botToken, logLine)) {
    return;
  }

  if (meta.kind === 'callback_query') {
    if (await handleBonusCallback(pool, botToken, upd, meta, logLine)) return;
    if (await handleCleaningCallback(pool, botToken, upd, meta, logLine)) return;

    if (meta.callback_id) {
      await tgAnswerCallback(botToken, meta.callback_id, 'OK', false);
    }
    return;
  }

  if (meta.kind === 'message') {
    await processMessage(upd, meta, botToken, logLine);
    return;
  }
}