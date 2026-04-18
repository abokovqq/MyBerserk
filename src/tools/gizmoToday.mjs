import 'dotenv/config';
import { gizmoFetch } from '../gizmoClient.js';

console.log('[gizmoToday] start');

const now = new Date();
// у тебя сервер, судя по ответу, в UTC+? но мы пока берём "сегодня" по серверному времени
const start = new Date(now); start.setHours(0,0,0,0);
const end   = new Date(now); end.setHours(23,59,59,999);

const PATHS = [
  '/api/usersessions',
  '/api/stats/user/logins'
];

for (const PATH of PATHS) {
  const q = `start=${start.toISOString()}&end=${end.toISOString()}&max=200`;
  const full = `${PATH}?${q}`;
  console.log('[gizmoToday] try', full);
  try {
    const raw = await gizmoFetch(full);
    // v1 у тебя возвращает { version:null, result:[...], ... }
    const arr =
      Array.isArray(raw) ? raw :
      Array.isArray(raw?.items) ? raw.items :
      Array.isArray(raw?.result) ? raw.result :
      [];

    console.log('[gizmoToday] path', PATH, 'rows:', arr.length);
    if (arr.length) {
      console.log('[gizmoToday] first:', arr[0]);
      console.log('[gizmoToday] last:', arr[arr.length - 1]);
      process.exit(0);
    }
  } catch (e) {
    console.log('[gizmoToday] ERROR for', PATH, e.message);
  }
}

console.log('[gizmoToday] no data for today on tested paths');
process.exit(0);