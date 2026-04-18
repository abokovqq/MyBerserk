// src/utils/report/telegramSend.mjs
import fs from 'fs';
import path from 'path';

export async function sendTelegramFile({ botToken, chatId, filePath, caption }) {
  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;

  const buffer = await fs.promises.readFile(filePath);
  const blob = new Blob([buffer]);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append(
    'document',
    blob,
    path.basename(filePath) // ← ключевая строка
  );

  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(await res.text());
  }
}
