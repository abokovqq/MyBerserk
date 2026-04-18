import '../env.js';
import https from 'node:https';
import { renderTableToPngCellColors } from '../utils/renderTableToPngCellColors.mjs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_SCHEDULE;
const GS_URL = process.env.GS_SCHEDULE_WEBAPP_URL;
const ACTION = process.env.SCHEDULE_GS_ACTION || 'build';

function mustEnv(name, v) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function httpGetFollow(url, maxRedirects = 7) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'MyBerserk/weeklySchedulePost'
      }
    }, (res) => {
      const code = res.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(code)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error(`Redirect ${code} without Location header`));
        if (maxRedirects <= 0) return reject(new Error(`Too many redirects, last=${loc}`));
        const nextUrl = new URL(loc, u).toString();
        res.resume();
        return resolve(httpGetFollow(nextUrl, maxRedirects - 1));
      }

      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        resolve({
          url: u.toString(),
          code,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });

    req.on('error', reject);
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

    const parts = [];
    const pushField = (name, value) => {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
      ));
    };

    pushField('chat_id', String(chat_id));
    if (caption) pushField('caption', caption);

    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ));
    parts.push(Buffer.from(fileBytes));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendPhoto`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(raw); } catch { return reject(new Error(`TG bad JSON: ${raw.slice(0, 500)}`)); }
        if (!json.ok) return reject(new Error(`TG error: ${raw.slice(0, 500)}`));
        resolve(json);
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  mustEnv('TELEGRAM_BOT_TOKEN', BOT_TOKEN);
  mustEnv('TG_CHAT_SCHEDULE', CHAT_ID);
  mustEnv('GS_SCHEDULE_WEBAPP_URL', GS_URL);

  const url = `${GS_URL}?action=${encodeURIComponent(ACTION)}`;
  const resp = await httpGetFollow(url);
  const data = parseJsonResponse(resp);

  if (ACTION === 'ping') {
    console.log('PING OK:', data);
    return;
  }

  if (!data.ok) throw new Error(`AppsScript error: ${data.error || 'unknown'}`);

  const header = data.header;
  const rows = data.rows;
  const cellBg = data.cellBg;

  if (!Array.isArray(header) || !Array.isArray(rows) || !Array.isArray(cellBg)) {
    throw new Error('Bad payload: header/rows/cellBg missing');
  }

  // легенда — берем цвета строго из payload.legend (если есть)
  const dayColor = data.legend?.day || '#FFEB3B';
  const nightColor = data.legend?.night || '#BDBDBD';

  // ФИКСИРОВАННАЯ ширина ВСЕХ колонок
  // (одинаково для даты и админов)
  const FIX_COL_W = 88;
  const colWidthsFixed = header.map(() => FIX_COL_W);

  const table = [header, ...rows];

  const pngBuf = await renderTableToPngCellColors(table, {
    colWidthsFixed,
    cellBgColors: cellBg,
    legend: {
      dayColor,
      nightColor,
      labels: { title: 'Легенда:', day: 'Д', night: 'Н' }
    }
  });

  const caption =
    `🗓 Расписание на 14 дней сформировано.\n` +
    `Пожалуйста, проверьте правильность ✅`;

  await tgSendPhoto({
    chat_id: CHAT_ID,
    filename: 'schedule.png',
    mimeType: 'image/png',
    fileBytes: pngBuf,
    caption
  });

  console.log('OK: schedule screenshot posted');
}

main().catch((e) => {
  console.error('ERROR:', e?.message || e);
  process.exit(2);
});
