// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/background/telegram/telegramPoller.mjs

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const PROJECT_ROOT = '/home/a/abokovsa/berserkclub.ru/MyBerserk';
const ENV_PATH = `${PROJECT_ROOT}/.env`;

const LOG_FILE = '/home/a/abokovsa/berserkclub.ru/logs/telegramPoller.log';
const OFFSET_FILE = '/home/a/abokovsa/berserkclub.ru/logs/telegramPoller.offset';

const LONG_POLL_TIMEOUT_SEC = 30;
const LOOP_ERROR_SLEEP_MS = 2000;
const TABLE_NAME = 'telegram_updates_queue';
const LOG_TO_CONSOLE = false;

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function logLine(text) {
  ensureDirForFile(LOG_FILE);
  const line = `[${new Date().toISOString()}] [TELEGRAM_POLLER] ${text}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
  if (LOG_TO_CONSOLE) process.stdout.write(line);
}

function formatTsMs(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.`
    + `${pad(date.getMilliseconds(), 3)}`;
}

function shortText(value, limit = 150) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

function loadEnv() {
  dotenv.config({ path: ENV_PATH });
}

function getRequiredEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`Env var ${name} is empty`);
  return value;
}

function getOptionalEnv(name, fallback = '') {
  const value = process.env[name];
  return value == null || String(value).trim() === '' ? fallback : String(value).trim();
}

function loadOffset() {
  try {
    if (!fs.existsSync(OFFSET_FILE)) return 0;
    const raw = fs.readFileSync(OFFSET_FILE, 'utf8').trim();
    if (!raw) return 0;
    return Number.parseInt(raw, 10) || 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset) {
  ensureDirForFile(OFFSET_FILE);
  fs.writeFileSync(OFFSET_FILE, String(offset), 'utf8');
}

function extractUpdateMeta(upd) {
  const meta = {
    update_id: typeof upd?.update_id === 'number' ? upd.update_id : null,
    kind: 'unknown',
    chat_id: null,
    message_id: null,
    tg_date: null,
    text_preview: '',
    callback_data: '',
  };

  if (upd?.message && typeof upd.message === 'object') {
    const msg = upd.message;
    meta.kind = 'message';
    meta.chat_id = msg?.chat?.id ?? null;
    meta.message_id = msg?.message_id ?? null;
    meta.tg_date = typeof msg?.date === 'number' ? msg.date : null;
    meta.text_preview = shortText(msg?.text ?? msg?.caption ?? '');
    return meta;
  }

  if (upd?.edited_message && typeof upd.edited_message === 'object') {
    const msg = upd.edited_message;
    meta.kind = 'edited_message';
    meta.chat_id = msg?.chat?.id ?? null;
    meta.message_id = msg?.message_id ?? null;
    meta.tg_date = typeof msg?.date === 'number' ? msg.date : null;
    meta.text_preview = shortText(msg?.text ?? msg?.caption ?? '');
    return meta;
  }

  if (upd?.callback_query && typeof upd.callback_query === 'object') {
    const cb = upd.callback_query;
    meta.kind = 'callback_query';
    meta.callback_data = shortText(cb?.data ?? '');
    meta.chat_id = cb?.message?.chat?.id ?? null;
    meta.message_id = cb?.message?.message_id ?? null;
    meta.tg_date = typeof cb?.message?.date === 'number' ? cb.message.date : null;
    return meta;
  }

  return meta;
}

async function tgApiGet(token, method, params = {}) {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  Object.entries(params).forEach(([k, v]) => {
    url.searchParams.set(k, String(v));
  });

  const controller = new AbortController();
  const timeoutMs = (LONG_POLL_TIMEOUT_SEC + 15) * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    const text = await res.text();
    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: 'bad_json',
        http: res.status,
        raw_prefix: text.slice(0, 500),
      };
    }

    return json;
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'AbortError'
        ? `abort_timeout_${timeoutMs}ms`
        : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  loadEnv();

  const BOT_TOKEN = getRequiredEnv('TELEGRAM_BOT_TOKEN');

  const DB_HOST = getOptionalEnv('DB_HOST', 'localhost');
  const DB_PORT = Number.parseInt(getOptionalEnv('DB_PORT', '3306'), 10);
  const DB_NAME = getRequiredEnv('DB_NAME');
  const DB_USER = getRequiredEnv('DB_USER');
  const DB_PASS = getRequiredEnv('DB_PASS');

  const pool = await mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });

  let offset = loadOffset();
  logLine(`START offset=${offset}`);

  while (true) {
    try {
      const resp = await tgApiGet(BOT_TOKEN, 'getUpdates', {
        offset,
        timeout: LONG_POLL_TIMEOUT_SEC,
        allowed_updates: JSON.stringify(['message', 'edited_message', 'callback_query']),
      });

      if (!resp?.ok) {
        const errCode = resp?.error_code ?? 'no_code';
        const errDesc = resp?.description ?? 'no_description';
        const errText = resp?.error ?? '';
        logLine(`getUpdates error_code=${errCode} description=${errDesc} error=${errText}`);
        await new Promise(r => setTimeout(r, LOOP_ERROR_SLEEP_MS));
        continue;
      }

      if (!Array.isArray(resp.result) || resp.result.length === 0) {
        continue;
      }

      for (const upd of resp.result) {
        const recvAtMs = formatTsMs(new Date());

        const meta = extractUpdateMeta(upd);
        const updateId = meta.update_id;

        if (updateId == null) {
          logLine(`skip update without update_id recv_at_ms=${recvAtMs}`);
          continue;
        }

        const delaySec = meta.tg_date == null
          ? null
          : Math.floor(Date.now() / 1000) - meta.tg_date;

        const payload = JSON.stringify(upd);

        await pool.execute(
          `
          INSERT INTO ${TABLE_NAME}
              (id, payload, processed, processing, received_at, source)
          VALUES
              (?, ?, 0, 0, NOW(), 'prod_bot')
          ON DUPLICATE KEY UPDATE
              payload = VALUES(payload),
              received_at = VALUES(received_at)
          `,
          [updateId, payload]
        );

        logLine(
          `recv_at_ms=${recvAtMs}`
          + ` update_id=${updateId}`
          + ` kind=${meta.kind}`
          + ` chat_id=${meta.chat_id ?? 'null'}`
          + ` message_id=${meta.message_id ?? 'null'}`
          + ` tg_date=${meta.tg_date == null ? 'null' : new Date(meta.tg_date * 1000).toISOString()}`
          + ` delay_sec=${delaySec == null ? 'null' : delaySec}`
          + ` text=${meta.text_preview || '-'}`
          + ` cb=${meta.callback_data || '-'}`
        );

        offset = updateId + 1;
        saveOffset(offset);
      }
    } catch (err) {
      logLine(`loop exception=${String(err?.stack || err)}`);
      await new Promise(r => setTimeout(r, LOOP_ERROR_SLEEP_MS));
    }
  }
}

main().catch(err => {
  logLine(`fatal=${String(err?.stack || err)}`);
  process.exit(1);
});