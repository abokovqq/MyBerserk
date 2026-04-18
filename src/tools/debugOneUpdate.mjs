import 'dotenv/config';
import { q } from '../db.js';
import { send, tg } from '../tg.js';
import { defaultChat } from '../config.js';

const CHAT = defaultChat();

// берём последний проблемный
const rows = await q("SELECT id, payload FROM telegram_updates WHERE processed=3 ORDER BY id DESC LIMIT 1");
if (!rows.length) {
  console.log('no processed=3 updates');
  process.exit(0);
}

const row = rows[0];
console.log('debug update id =', row.id);

let upd;
try {
  upd = (typeof row.payload === 'string') ? JSON.parse(row.payload) : row.payload;
} catch (e) {
  console.log('JSON parse error:', e.message);
  process.exit(1);
}

try {
  if (upd.callback_query) {
    const cb = upd.callback_query;
    console.log('callback data =', cb.data);

    const m = (cb.data || '').match(/^cleaning:(done|other):(\d+)$/);
    if (!m) {
      console.log('callback pattern mismatch');
      process.exit(0);
    }
    const [, action, taskIdStr] = m;
    const taskId = Number(taskIdStr);

    if (action === 'done') {
      await q("UPDATE cleaning_tasks SET status='done', actor_telegram_id=? WHERE id=?", [cb.from.id, taskId]);
      console.log('DB updated for task', taskId);
      // тут чаще всего и падает: answerCallbackQuery
      const r = await tg('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'Уборка зафиксирована ✅'
      });
      console.log('answerCallbackQuery ok:', r);
      await send(cb.message.chat.id, `Задача #${taskId} выполнена пользователем @${cb.from.username || cb.from.id}.`);
      console.log('send ok');
    } else {
      console.log('action other: TODO');
    }
  } else {
    console.log('not a callback');
  }
} catch (e) {
  console.log('ERROR WHILE HANDLING UPDATE:', e.message);
  // выводим целиком ответ телеги если это она
  if (e.response) console.log('TG response:', e.response);
}