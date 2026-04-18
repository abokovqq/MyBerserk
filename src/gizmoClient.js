import 'dotenv/config';
import { request } from 'undici';
import { getOperatorToken } from './gizmoAuth.js';

const BASE = (process.env.GIZMO_SERVER || '').replace(/\/+$/, '');
const DEBUG = (process.env.GIZMO_DEBUG || '1') === '1';

/**
 * Универсальный запрос к Gizmo:
 * 1) сначала пробуем v2 с Bearer
 * 2) если 404 — пробуем тот же путь без /v2.0 но с Bearer
 * 3) если опять 404 — пробуем без авторизации
 */
export async function gizmoFetch(pathWithQuery, { method = 'GET', body = null } = {}) {
  const token = await getOperatorToken();
  const rel = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;

  // 1) v2 с bearer
  const urlV2 = `${BASE}/api/v2.0${rel}`;
  const resV2 = await request(urlV2, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : null
  });

  if (resV2.statusCode === 200) {
    const json = await resV2.body.json();
    if (DEBUG) {
      console.log('[gizmoClient] OK via v2:', urlV2);
      console.log('[gizmoClient] body:', JSON.stringify(json).slice(0, 200));
    }
    return json;
  }
  if (resV2.statusCode !== 404) {
    const txt = await resV2.body.text();
    throw new Error(`Gizmo v2 ${resV2.statusCode}: ${txt.slice(0, 200)}`);
  }

  // 2) v1 с bearer
  const urlV1 = `${BASE}${rel}`;
  const resV1b = await request(urlV1, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : null
  });

  if (resV1b.statusCode === 200) {
    const json = await resV1b.body.json();
    if (DEBUG) {
      console.log('[gizmoClient] OK via v1 (with bearer):', urlV1);
      console.log('[gizmoClient] body:', JSON.stringify(json).slice(0, 200));
    }
    return json;
  }
  if (resV1b.statusCode !== 404) {
    const txt = await resV1b.body.text();
    throw new Error(`Gizmo v1 (with bearer) ${resV1b.statusCode}: ${txt.slice(0, 200)}`);
  }

  // 3) v1 без авторизации
  const resV1 = await request(urlV1, {
    method,
    headers: { Accept: 'application/json' }
  });

  if (resV1.statusCode === 200) {
    const json = await resV1.body.json();
    if (DEBUG) {
      console.log('[gizmoClient] OK via v1 (no auth):', urlV1);
      console.log('[gizmoClient] body:', JSON.stringify(json).slice(0, 200));
    }
    return json;
  }

  const txt = await resV1.body.text();
  throw new Error(`Gizmo v1 (no auth) ${resV1.statusCode}: ${txt.slice(0, 200)}`);
}