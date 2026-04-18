import 'dotenv/config';
import { request } from 'undici';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const SERVER = (process.env.GIZMO_SERVER || '').replace(/\/+$/,'');
const USERNAME = process.env.GIZMO_USERNAME || '';
const PASSWORD = process.env.GIZMO_PASSWORD || '';
const TOKEN_FILE = process.env.GIZMO_TOKEN_FILE || './token.json';

function nowISO() { return new Date().toISOString(); }

function parseIsoOrNull(s) {
  try {
    if (!s) return null;
    // допускаем "2025-11-03T08:00:01Z" или без Z
    return new Date(s.replace('Z', '+00:00'));
  } catch { return null; }
}

function isTokenValid(expirationStr) {
  const d = parseIsoOrNull(expirationStr);
  if (!d) return false; // если API не отдаёт expiration — считаем протухшим, пошлём refresh/get
  return d.getTime() - Date.now() > 0;
}

async function saveToken(tokenData) {
  const info = {
    Token: tokenData.token,
    RefreshToken: tokenData.refreshToken,
    Expiration: tokenData.expiration || null,
    SavedAt: new Date().toISOString().slice(0,19).replace('T',' ')
  };
  await writeFile(TOKEN_FILE, JSON.stringify(info, null, 2), 'utf8');
  return info;
}

async function loadToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const raw = await readFile(TOKEN_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function httpJson(path, query) {
  const url = new URL(SERVER + path);
  for (const [k,v] of Object.entries(query||{})) url.searchParams.set(k, v);
  const { statusCode, body } = await request(url, { method: 'GET', headers: { Accept:'application/json' }, maxRedirections: 0 });
  if (statusCode !== 200) {
    const txt = await body.text();
    throw new Error(`Gizmo ${path} ${statusCode}: ${txt.slice(0,200)}`);
  }
  return await body.json();
}

async function apiGetToken() {
  const data = await httpJson('/api/v2.0/auth/accesstoken', { Username: USERNAME, Password: PASSWORD });
  const tokenData = data?.result;
  if (!tokenData?.token) throw new Error(`Нет token в ответе: ${JSON.stringify(data).slice(0,200)}`);
  return await saveToken(tokenData);
}

async function apiRefreshToken(token, refreshToken) {
  const data = await httpJson('/api/v2.0/auth/accesstoken/refresh', { Token: token, RefreshToken: refreshToken });
  const tokenData = data?.result;
  // как в твоём Python: если сервер вернул пустой result — считаем, что старый токен ещё валиден
  if (!tokenData?.token) {
    return { Token: token, RefreshToken: refreshToken, Expiration: null, SavedAt: nowISO().slice(0,19).replace('T',' ') };
  }
  return await saveToken(tokenData);
}

export async function getOperatorToken() {
  // 1) если есть валидный — используем
  const cached = await loadToken();
  if (cached?.Expiration && isTokenValid(cached.Expiration)) {
    return cached.Token;
  }
  // 2) если есть файл — пробуем refresh
  if (cached?.Token && cached?.RefreshToken) {
    try {
      const refreshed = await apiRefreshToken(cached.Token, cached.RefreshToken);
      return refreshed.Token || refreshed.token || refreshed?.Token;
    } catch {
      // падаем на получение нового
    }
  }
  // 3) иначе — получаем новый
  const fresh = await apiGetToken();
  return fresh.Token;
}