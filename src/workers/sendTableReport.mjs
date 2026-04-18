// src/workers/sendTableReport.mjs
import '../env.js';
import fs from 'fs';
import { sqlTableScreenshot } from '../tools/sqlTableScreenshot.mjs';

const CHAT = process.env.TG_CHAT_TEST;           // тестовый чат
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// отправка фото в Telegram через встроенные fetch / FormData / Blob
async function sendPhoto({ chatId, filePath, caption = '' }) {
  if (!BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  }
  if (!chatId) {
    throw new Error('chatId не задан');
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;

  // читаем файл и оборачиваем в Blob — так дружит с встроенной FormData
  const buffer = await fs.promises.readFile(filePath);
  const blob = new Blob([buffer]); // имя укажем ниже в form.append

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption);
  }
  form.append('photo', blob, 'report.png');

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

async function main() {
  // 1. генерим PNG из MySQL
  const pngPath = await sqlTableScreenshot({
    table: 'cleaning_tasks',
    columns: [
      { field: 'place_id', title: 'Место' },
      { field: 'first_name',  title: 'Админ' },
      { field: 'status',      title: 'Статус' },
      { field: 'closed_at',   title: 'Время' },
    ],
    where: 'shift_id = ?',
    params: [1356],
    orderBy: 'id ASC',
    outPath: '/tmp/cleaning_shift_1356.png',
  });

  console.log('PNG сохранён в', pngPath);

  // 2. отправляем в тестовый чат
  await sendPhoto({
    filePath: pngPath,
    chatId: CHAT,
    caption: '🧹 Отчёт по уборке (смена 1356)',
  });

  console.log('Готово: отчёт отправлен в Telegram');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
