import 'dotenv/config';
import { gizmoGet } from '../gizmo.js';

const PATHS = (process.env.GIZMO_CLOSE_PATHS || '').split(',').map(s=>s.trim()).filter(Boolean);
const LIMIT = Number(process.env.GIZMO_LIMIT || 50);

function summarize(item) {
  const keys = Object.keys(item || {});
  const sample = {};
  for (const k of keys.slice(0, 15)) sample[k] = item[k];
  return { keys, sample };
}

(async () => {
  for (const base of PATHS) {
    // попробуем без since и с limit
    const path = base.includes('?') ? `${base}&limit=${LIMIT}` : `${base}?limit=${LIMIT}`;
    try {
      const data = await gizmoGet(path);
      const arr = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
      console.log('\n=== PATH:', path, '→ count:', arr.length);
      if (!arr.length) continue;
      const { keys, sample } = summarize(arr[0]);
      console.log('keys:', keys.join(', '));
      console.log('sample:', JSON.stringify(sample, null, 2));
    } catch (e) {
      console.log('\n=== PATH:', path, '→ ERROR:', e.message);
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });