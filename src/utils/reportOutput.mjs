// src/utils/reportOutput.mjs
// Общий helper для вывода отчётов:
// - CLI: печать в консоль
// - Telegram: отправка ТОЛЬКО HTML как document (если передан chatId и чат разрешён)

import fs from 'fs';
import path from 'path';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

function envNum(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const clean = raw.split('#')[0].trim();
  const n = Number(clean);
  return Number.isNaN(n) ? null : n;
}

export const TG_CHAT_REPORT = envNum('TG_CHAT_REPORT');
export const TG_CHAT_TEST   = envNum('TG_CHAT_TEST');

export function isAllowedChat(chatId) {
  if (chatId == null) return false;
  const id = Number(chatId);
  if (!Number.isFinite(id)) return false;
  return (TG_CHAT_REPORT != null && id === TG_CHAT_REPORT) ||
         (TG_CHAT_TEST   != null && id === TG_CHAT_TEST);
}

export function getCliArg(name, def = null) {
  const argv = process.argv.slice(2);
  const pref = `--${name}=`;
  const f = argv.find(a => a.startsWith(pref));
  return f ? f.substring(pref.length) : def;
}

export function getChatIdFromArgs(def = null) {
  const v = getCliArg('chatId', null);
  if (v == null) return def;
  const n = Number(v);
  return Number.isNaN(n) ? def : n;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function makeHtmlFromText(text, { title = 'Report' } = {}) {
  const safe = escapeHtml(text ?? '');
  const safeTitle = escapeHtml(title);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safeTitle}</title>
<style>
  body { margin: 16px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
  .box { white-space: pre; font-size: 13px; line-height: 1.35; padding: 12px; border: 1px solid #ddd; border-radius: 8px; }
  .muted { color: #777; font-size: 12px; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="muted">${safeTitle}</div>
<div class="box">${safe}</div>
</body>
</html>`;
}

export async function sendTelegramDocument({
  chatId,
  filePath,
  caption = '',
  parseMode = 'Markdown',
}) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  if (!chatId) throw new Error('chatId не задан');
  if (!filePath) throw new Error('filePath не задан');

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;

  const buf = await fs.promises.readFile(filePath);
  const blob = new Blob([buf]);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', parseMode);
  }

  // ВАЖНО: имя файла, иначе Telegram пришлёт "blob"
  form.append('document', blob, path.basename(filePath));

  const res = await fetch(url, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`TG sendDocument failed: ${text}`);
  return text;
}

export async function outputReport({
  chatId,
  title = 'Report',
  text,           // готовый текст отчёта (для консоли и для HTML)
  fileBaseName,   // например "gizmo_check_1431"
}) {
  // всегда печатаем в консоль (как раньше)
  const out = String(text ?? '');
  process.stdout.write(out + (out.endsWith('\n') ? '' : '\n'));

  // если нет chatId или чат не разрешён — ничего не отправляем
  if (!isAllowedChat(chatId)) return;

  const safeBase = (fileBaseName || 'report').replace(/[^\w.-]+/g, '_');
  const tmpHtml = `/tmp/${safeBase}.html`;

  try {
    const html = makeHtmlFromText(out, { title });
    await fs.promises.writeFile(tmpHtml, html, 'utf8');

    await sendTelegramDocument({
      chatId,
      filePath: tmpHtml,
      caption: `*${title}* (HTML)`,
    });
  } finally {
    try { await fs.promises.unlink(tmpHtml); } catch {}
  }
}
