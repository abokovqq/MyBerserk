// src/utils/report/chatGate.mjs
// Определяет:
//  - chatId из аргументов CLI (--chatId=...)
//  - разрешено ли слать отчёт в этот чат (TG_CHAT_REPORT / TG_CHAT_TEST)

import '../../env.js';

// --- получить chatId из аргументов CLI ---
export function getChatIdFromArgs(def = null) {
  const argv = process.argv.slice(2);
  const pref = '--chatId=';
  const a = argv.find(v => v.startsWith(pref));
  if (!a) return def;

  const raw = a.substring(pref.length).trim();
  if (!raw) return def;

  const id = Number(raw);
  return Number.isNaN(id) ? def : id;
}

// --- проверка: можно ли слать в этот чат ---
export function isAllowedChat(chatId) {
  if (chatId == null) return false;

  const allowed = new Set();

  if (process.env.TG_CHAT_REPORT) {
    const v = Number(process.env.TG_CHAT_REPORT);
    if (!Number.isNaN(v)) allowed.add(v);
  }

  if (process.env.TG_CHAT_TEST) {
    const v = Number(process.env.TG_CHAT_TEST);
    if (!Number.isNaN(v)) allowed.add(v);
  }

  return allowed.has(Number(chatId));
}
