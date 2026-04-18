// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/tgPollingForward.mjs
// Telegram getUpdates polling -> forward each update to PHP webhook
// Stable under DPI/webhook blocks. Anti-duplicate (offset + lock).

import '../env.js';
import fs from 'node:fs';
import https from 'node:https';
import { URL } from 'node:url';

// ========================= CONFIG =========================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
if (!BOT_TOKEN) {
  console.error('[tg-poll] TELEGRAM_BOT_TOKEN missing');
  process.exit(1);
}

const FORWARD_URL = process.env.TG_POLL_FORWARD_URL || 'https://hook.berserkclub.ru/webhook.php';

const OFFSET_FILE = process.env.TG_POLL_OFFSET_FILE
  || '/home/a/abokovsa/berserkclub.ru/MyBerserk/.tg_poll_offset';

const LOCK_FILE = process.env.TG_POLL_LOCK_FILE
  || '/home/a/abokovsa/berserkclub.ru/MyBerserk/.tg_poll_lock';

const TG_POLL_SECRET = (process.env.TG_POLL_SECRET || '').trim();

const POLL_TIMEOUT_SEC = Number(process.env.TG_POLL_TIMEOUT_SEC || 50); // Telegram long poll timeout
const POLL_LIMIT = Number(process.env.TG_POLL_LIMIT || 50);             // up to 100
const FORWARD_TIMEOUT_MS = Number(process.env.TG_POLL_FORWARD_TIMEOUT_MS || 10_000);

const TG_API_TIMEOUT_MS = (POLL_TIMEOUT_SEC + 15) * 1000; // запас к long poll

// ========================= UTILS =========================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function readOffset() {
  try {
    const s = fs.readFileSync(OFFSET_FILE, 'utf8').trim();
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeOffset(n) {
  try {
    fs.writeFileSync(OFFSET_FILE, String(n), 'utf8');
  } catch (e) {
    console.error('[tg-poll] writeOffset failed:', e.message);
  }
}

// =============== LOCK (anti double-run) ===================

function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx'); // fails if exists
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

if (!acquireLock()) {
  console.error('[tg-poll] already running (lock exists):', LOCK_FILE);
  process.exit(0);
}

process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// ====================== HTTP HELPERS ======================

function httpsJsonPost(urlStr, payloadObj, timeoutMs) {
  const body = JSON.stringify(payloadObj || {});
  const u = new URL(urlStr);

  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', ch => (data += ch));
      res.on('end', () => {
        try {
          const j = JSON.parse(data || '{}');
          resolve(j);
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}; body=${String(data).slice(0, 300)}`));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsPostRaw(urlStr, bodyStr, timeoutMs, extraHeaders) {
  const u = new URL(urlStr);

  const headers = Object.assign({
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(bodyStr),
    'X-TG-Polling': '1',
  }, extraHeaders || {});

  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'POST',
    headers,
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      res.resume();
      res.on('end', resolve);
      res.on('close', resolve);
    });

    req.on('timeout', () => req.destroy(new Error('forward timeout')));
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ====================== TELEGRAM API ======================

async function tgGetUpdates(offset) {
  const payload = {
    timeout: POLL_TIMEOUT_SEC,
    limit: POLL_LIMIT,
  };
  if (offset && offset > 0) payload.offset = offset;

  // Можно включить, если хочешь получать только нужное:
  // payload.allowed_updates = ["message", "callback_query"];

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
  return await httpsJsonPost(url, payload, TG_API_TIMEOUT_MS);
}

// ========================== MAIN ==========================

async function main() {
  let offset = readOffset();
  console.log(`[tg-poll] ${nowIso()} start; forward=${FORWARD_URL}`);
  console.log(`[tg-poll] ${nowIso()} offset_file=${OFFSET_FILE} offset=${offset}`);
  console.log(`[tg-poll] ${nowIso()} lock_file=${LOCK_FILE} pid=${process.pid}`);

  let backoffMs = 1000;

  while (true) {
    try {
      const resp = await tgGetUpdates(offset);

      if (!resp || resp.ok !== true) {
        console.error('[tg-poll] getUpdates not ok:', resp);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15_000);
        continue;
      }

      const updates = Array.isArray(resp.result) ? resp.result : [];
      if (updates.length === 0) {
        backoffMs = 1000;
        continue;
      }

      for (const u of updates) {
        const updateId = u && u.update_id ? Number(u.update_id) : 0;
        const body = JSON.stringify(u);

        // секрет (если задан)
        const extraHeaders = {};
        if (TG_POLL_SECRET) extraHeaders['X-TG-Secret'] = TG_POLL_SECRET;

        // forward (если упал — offset не двигаем)
        await httpsPostRaw(FORWARD_URL, body, FORWARD_TIMEOUT_MS, extraHeaders);

        // success -> offset
        const next = updateId > 0 ? updateId + 1 : offset;
        if (next > offset) {
          offset = next;
          writeOffset(offset);
        }
      }

      backoffMs = 1000;

    } catch (e) {
      console.error('[tg-poll] error:', e.message);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 15_000);
    }
  }
}

main().catch(e => {
  console.error('[tg-poll] fatal:', e);
  process.exit(1);
});
