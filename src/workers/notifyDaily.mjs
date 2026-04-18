import 'dotenv/config';
import { q } from '../db.js';
import { send } from '../tg.js';
import { chat } from '../config.js';

const CHAT = chat('MAIN');

const [row] = await q(
  "SELECT COUNT(*) AS pending FROM cleaning_tasks WHERE status='open' AND DATE(created_at)=CURDATE()"
);
await send(CHAT, `Сводка: открытых задач уборки сегодня — ${row?.pending ?? 0}.`);
