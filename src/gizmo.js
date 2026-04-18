import 'dotenv/config';
import { request } from 'undici';
import { getOperatorToken } from './gizmoAuth.js';

const BASE = (process.env.GIZMO_SERVER || '').replace(/\/+$/,'') + '/api/v2.0';

export function pickFirst(obj, fields = []) {
  for (const f of fields) if (obj && Object.prototype.hasOwnProperty.call(obj, f) && obj[f] != null) return obj[f];
  return undefined;
}

export async function gizmoGet(pathWithQuery) {
  const token = await getOperatorToken();
  const url = `${BASE}${pathWithQuery.startsWith('/') ? '' : '/'}${pathWithQuery}`;
  const { statusCode, body } = await request(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (statusCode !== 200) {
    const txt = await body.text();
    throw new Error(`Gizmo ${statusCode}: ${txt.slice(0,200)}`);
  }
  try { return await body.json(); } catch { return []; }
}