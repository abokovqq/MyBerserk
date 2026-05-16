import '../env.js';
import https from 'node:https';
import { renderTableToPngCellColors } from '../utils/renderTableToPngCellColors.mjs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_SCHEDULE;
const GS_URL = process.env.GS_SCHEDULE_WEBAPP_URL;
const ACTION = process.env.SCHEDULE_GS_ACTION || 'build';

const HTTP_TIMEOUT_MS = 45000;
const TG_TIMEOUT_MS = 30000;
const LOG_TZ = 'Europe/Moscow';

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function formatMoscowDate(value = new Date(), withMs = false) {
  if (!value) return '-';

  const d = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(d.getTime())) {
    return String(value);
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOG_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(d);

  const m = {};
  for (const p of parts) {
    if (p.type !== 'literal') m[p.type] = p.value;
  }

  const base = `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}:${m.second}`;

  if (!withMs) return base;

  return `${base}.${pad(d.getMilliseconds(), 3)}`;
}

function installMoscowConsolePrefix() {
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args) => {
    origLog(`[${formatMoscowDate(new Date(), true)} MSK]`, ...args);
  };

  console.error = (...args) => {
    origError(`[${formatMoscowDate(new Date(), true)} MSK]`, ...args);
  };
}

installMoscowConsolePrefix();

function mustEnv(name, v) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function buildGsUrl(baseUrl, action) {
  const u = new URL(baseUrl);
  u.searchParams.set('action', action);
  return u.toString();
}

function httpGetFollow(url, maxRedirects = 7) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    let finished = false;

    const done = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(wallTimer);
      resolve(value);
    };

    const fail = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(wallTimer);
      reject(err);
    };

    console.log(`HTTP GET: ${u.toString()}`);

    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      family: 4,
      path: u.pathname + u.search,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'MyBerserk/weeklySchedulePost',
        'Connection': 'close',
      },
    }, (res) => {
      const code = res.statusCode || 0;

      console.log(`HTTP CONNECTED: host=${u.hostname}, code=${code}`);

      if ([301, 302, 303, 307, 308].includes(code)) {
        const loc = res.headers.location;
        console.log(`REDIRECT ${code}: ${loc || 'NO_LOCATION'}`);

        if (!loc) {
          res.resume();
          return fail(new Error(`Redirect ${code} without Location header`));
        }

        if (maxRedirects <= 0) {
          res.resume();
          return fail(new Error(`Too many redirects, last=${loc}`));
        }

        const nextUrl = new URL(loc, u).toString();
        res.resume();

        clearTimeout(wallTimer);
        finished = true;

        return resolve(httpGetFollow(nextUrl, maxRedirects - 1));
      }

      const chunks = [];

      res.on('data', d => chunks.push(d));

      res.on('end', () => {
        const body = Buffer.concat(chunks);

        console.log(
          `HTTP RESPONSE: code=${code}, content-type=${res.headers['content-type'] || ''}, bytes=${body.length}`
        );

        done({
          url: u.toString(),
          code,
          headers: res.headers,
          body,
        });
      });

      res.on('error', fail);
    });

    const wallTimer = setTimeout(() => {
      req.destroy(new Error(`HTTP wall timeout after ${HTTP_TIMEOUT_MS} ms: ${u.toString()}`));
    }, HTTP_TIMEOUT_MS);

    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`HTTP socket timeout after ${HTTP_TIMEOUT_MS} ms: ${u.toString()}`));
    });

    req.on('socket', (socket) => {
      socket.on('lookup', (err, address, family, host) => {
        if (err) {
          console.log(`HTTP DNS lookup error: host=${u.hostname}, error=${err.message}`);
        } else {
          console.log(`HTTP DNS lookup: host=${host || u.hostname}, address=${address}, family=${family}`);
        }
      });

      socket.on('connect', () => {
        console.log(`HTTP SOCKET connected: host=${u.hostname}, remote=${socket.remoteAddress}:${socket.remotePort}`);
      });

      socket.on('secureConnect', () => {
        console.log(`HTTP TLS connected: host=${u.hostname}`);
      });
    });

    req.on('error', fail);
    req.end();
  });
}

function parseJsonResponse(resp) {
  const ctype = String(resp.headers['content-type'] || '');
  const raw = resp.body.toString('utf8');

  if (resp.code < 200 || resp.code >= 300) {
    throw new Error(`HTTP ${resp.code} (${ctype}) from ${resp.url}: ${raw.slice(0, 500)}`);
  }

  const trimmed = raw.trim().toLowerCase();

  if (ctype.includes('text/html') || trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) {
    throw new Error(`Bad JSON: received HTML (${ctype}) from ${resp.url}: ${raw.slice(0, 500)}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Bad JSON from ${resp.url}: ${raw.slice(0, 500)}`);
  }
}

function tgSendPhoto({ chat_id, filename, mimeType, fileBytes, caption }) {
  return new Promise((resolve, reject) => {
    const boundary = '----tgFormBoundary' + Math.random().toString(16).slice(2);

    let finished = false;

    const done = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(wallTimer);
      resolve(value);
    };

    const fail = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(wallTimer);
      reject(err);
    };

    const parts = [];

    const pushField = (name, value) => {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
      ));
    };

    pushField('chat_id', String(chat_id));

    if (caption) {
      pushField('caption', caption);
    }

    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ));

    parts.push(Buffer.from(fileBytes));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    console.log(`TG sendPhoto: chat_id=${chat_id}, file=${filename}, bytes=${fileBytes.length}`);

    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      family: 4,
      path: `/bot${BOT_TOKEN}/sendPhoto`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'Connection': 'close',
      },
    }, (res) => {
      const chunks = [];

      console.log(`TG CONNECTED: http=${res.statusCode || 0}`);

      res.on('data', d => chunks.push(d));

      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');

        console.log(`TG RESPONSE: http=${res.statusCode || 0}, bytes=${raw.length}`);
        console.log(`TG RAW: ${raw.slice(0, 1000)}`);

        let json;

        try {
          json = JSON.parse(raw);
        } catch {
          return fail(new Error(`TG bad JSON: ${raw.slice(0, 1000)}`));
        }

        if (!json.ok) {
          return fail(new Error(`TG error: ${raw.slice(0, 1000)}`));
        }

        done(json);
      });

      res.on('error', fail);
    });

    const wallTimer = setTimeout(() => {
      req.destroy(new Error(`TG wall timeout after ${TG_TIMEOUT_MS} ms`));
    }, TG_TIMEOUT_MS);

    req.setTimeout(TG_TIMEOUT_MS, () => {
      req.destroy(new Error(`TG socket timeout after ${TG_TIMEOUT_MS} ms`));
    });

    req.on('socket', (socket) => {
      socket.on('lookup', (err, address, family, host) => {
        if (err) {
          console.log(`TG DNS lookup error: ${err.message}`);
        } else {
          console.log(`TG DNS lookup: host=${host || 'api.telegram.org'}, address=${address}, family=${family}`);
        }
      });

      socket.on('connect', () => {
        console.log(`TG SOCKET connected: remote=${socket.remoteAddress}:${socket.remotePort}`);
      });

      socket.on('secureConnect', () => {
        console.log('TG TLS connected');
      });
    });

    req.on('error', fail);

    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('weeklySchedulePost: start');

  const queueId = process.env.TG_QUEUE_ID || '-';
  const messageId = process.env.TG_MESSAGE_ID || '-';
  const receivedAtRaw = process.env.TG_RECEIVED_AT || '-';
  const receivedAtMsk = receivedAtRaw === '-' ? '-' : formatMoscowDate(receivedAtRaw);
  const attempt = process.env.TG_ATTEMPT || '-';

  console.log(
    `weeklySchedulePost: queue_id=${queueId}, `
    + `message_id=${messageId}, `
    + `received_at_msk=${receivedAtMsk}, `
    + `attempt=${attempt}`
  );

  mustEnv('TELEGRAM_BOT_TOKEN', BOT_TOKEN);
  mustEnv('TG_CHAT_SCHEDULE', CHAT_ID);
  mustEnv('GS_SCHEDULE_WEBAPP_URL', GS_URL);

  console.log(`weeklySchedulePost: ACTION=${ACTION}`);
  console.log(`weeklySchedulePost: CHAT_ID=${CHAT_ID}`);

  const url = buildGsUrl(GS_URL, ACTION);

  const resp = await httpGetFollow(url);
  const data = parseJsonResponse(resp);

  console.log(`weeklySchedulePost: AppsScript payload ok=${data?.ok}, keys=${Object.keys(data || {}).join(',')}`);

  if (ACTION === 'ping') {
    console.log('PING OK:', data);
    console.log('weeklySchedulePost: ACTION=ping, фото НЕ отправляется');
    return;
  }

  if (!data.ok) {
    throw new Error(`AppsScript error: ${data.error || 'unknown'}`);
  }

  const header = data.header;
  const rows = data.rows;
  const cellBg = data.cellBg;

  if (!Array.isArray(header) || !Array.isArray(rows) || !Array.isArray(cellBg)) {
    throw new Error('Bad payload: header/rows/cellBg missing');
  }

  console.log(`weeklySchedulePost: header=${header.length}, rows=${rows.length}, cellBg=${cellBg.length}`);

  const dayColor = data.legend?.day || '#FFEB3B';
  const nightColor = data.legend?.night || '#BDBDBD';

  const FIX_COL_W = 88;
  const colWidthsFixed = header.map(() => FIX_COL_W);

  const table = [header, ...rows];

  console.log('weeklySchedulePost: rendering png');

  const pngBuf = await renderTableToPngCellColors(table, {
    colWidthsFixed,
    cellBgColors: cellBg,
    legend: {
      dayColor,
      nightColor,
      labels: {
        title: 'Легенда:',
        day: 'Д',
        night: 'Н',
      },
    },
  });

  console.log(`weeklySchedulePost: png rendered, bytes=${pngBuf.length}`);

  const caption =
    `🗓 Расписание на 14 дней сформировано.\n` +
    `Пожалуйста, проверьте правильность ✅`;

  await tgSendPhoto({
    chat_id: CHAT_ID,
    filename: 'schedule.png',
    mimeType: 'image/png',
    fileBytes: pngBuf,
    caption,
  });

  console.log('OK: schedule screenshot posted');
}

main().catch((e) => {
  console.error('ERROR:', e?.stack || e?.message || e);
  process.exit(2);
});