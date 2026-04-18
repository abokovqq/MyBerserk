import 'dotenv/config';
import { request } from 'undici';

const API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// низкоуровневый вызов Telegram Bot API
export async function tg(method, payload = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined && v !== null) {
      params.append(k, String(v));
    }
  }
  const body = params.toString();

  const { statusCode, body: res } = await request(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = await res.json();
  if (statusCode !== 200 || !data.ok) {
    throw new Error(`TG ${method} ${statusCode}: ${JSON.stringify(data)}`);
  }
  return data.result;
}

// удобная отправка текста
export async function send(chat_id, text, extra = {}) {
  return tg('sendMessage', {
    chat_id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}