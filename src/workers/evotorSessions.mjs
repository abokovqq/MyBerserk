// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/evotorSessions.mjs

import '../env.js';
import { q } from '../db.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { send } from '../tg.js';

const API_BASE = 'https://api.evotor.ru';

const STORE_ID  = process.env.STORE_ID;
const DEVICE_ID = process.env.DEVICE_ID;
const TOKEN     = process.env.EVOTOR_ACCESS_TOKEN;

const LOAD_ALL_SESSIONS =
  String(process.env.LOAD_ALL_SESSIONS || '').toLowerCase() === 'true';

// корень проекта
const APP_DIR = '/home/a/abokovsa/berserkclub.ru/MyBerserk';

// путь к .env
const ENV_FILE = '/home/a/abokovsa/berserkclub.ru/MyBerserk/.env';

function requireEnv(name, value) {
  if (!value) {
    console.error(`Нет ${name} в .env`);
    process.exit(1);
  }
}

requireEnv('STORE_ID', STORE_ID);
requireEnv('DEVICE_ID', DEVICE_ID);
requireEnv('EVOTOR_ACCESS_TOKEN', TOKEN);

// аккуратный парсер номера чата
function envNum(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const clean = raw.split('#')[0].trim();
  const n = Number(clean);
  return Number.isNaN(n) ? null : n;
}

function envBool(name, def = false) {
  const raw = process.env[name];
  if (raw == null) return def;
  return ['1', 'true', 'yes', 'y'].includes(String(raw).toLowerCase());
}

// обновление флага в .env
function setEnvFlag(name, value) {
  const valStr = String(value);
  let content = '';

  try {
    content = fs.readFileSync(ENV_FILE, 'utf8');
  } catch (e) {
    console.error(`evotorSessions: не удалось прочитать ${ENV_FILE}:`, e.message);
    content = '';
  }

  const lines = content.split(/\r?\n/);
  const re = new RegExp(`^\\s*${name}\\s*=`, 'i');
  let found = false;

  const newLines = lines.map(line => {
    if (re.test(line)) {
      found = true;
      return `${name}=${valStr}`;
    }
    return line;
  });

  if (!found) {
    newLines.push(`${name}=${valStr}`);
  }

  const newContent = newLines.join('\n');

  try {
    fs.writeFileSync(ENV_FILE, newContent, 'utf8');
    process.env[name] = valStr; // обновим в текущем процессе
    console.log(`evotorSessions: в ${ENV_FILE} установлено ${name}=${valStr}`);
  } catch (e) {
    console.error(`evotorSessions: не удалось записать ${ENV_FILE}:`, e.message);
  }
}

const TG_CHAT_REPORT = envNum('TG_CHAT_REPORT');

// node бинарь
const NODE_BIN = '/home/a/abokovsa/opt/node/bin/node';

// где лежат скрипты отчётов
const PRODUCTS_REPORT =
  '/home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorProductsReport.mjs';
const SESSION_REPORT =
  '/home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorSessionReport.mjs';

async function getLastSessionMs() {
  const rows = await q(`
    SELECT UNIX_TIMESTAMP(MAX(close_date)) * 1000 AS ts
    FROM evotor_sessions
  `);

  return rows[0].ts ? Number(rows[0].ts) : null;
}

async function getLastClosedSession() {
  const rows = await q(`
    SELECT session_id, session_number, close_date
      FROM evotor_sessions
     WHERE evotor_type = 'CLOSE_SESSION'
     ORDER BY close_date DESC
     LIMIT 1
  `);

  return rows[0] || null;
}

// проверка наличия Z-отчёта по session_id
async function hasZReport(sessionId) {
  const rows = await q(
    `
    SELECT 1
      FROM evotor_z_reports
     WHERE session_id = ?
     LIMIT 1
  `,
    [sessionId],
  );

  return rows.length > 0;
}

async function fetchPage({ since, cursor }) {
  const p = new URLSearchParams();

  if (cursor) p.set('cursor', cursor);
  else if (since) p.set('since', since);

  p.set('type', 'OPEN_SESSION,CLOSE_SESSION');

  const url =
    `${API_BASE}/stores/${STORE_ID}/devices/${DEVICE_ID}/documents?` +
    p.toString();

  const res = await fetch(url, {
    headers: {
      'X-Authorization': TOKEN,
      Accept: 'application/vnd.evotor.v2+json',
    },
  });

  const data = await res.json();

  return {
    items: data.items || [],
    next: data.next_cursor || null,
  };
}

async function saveSession(doc) {
  const sql = `
    INSERT IGNORE INTO evotor_sessions (
      evotor_doc_id,
      evotor_number,
      evotor_type,
      close_date,
      session_id,
      session_number,
      device_id,
      store_id,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const res = await q(sql, [
    doc.id,
    doc.number,
    doc.type,
    new Date(doc.close_date),
    doc.session_id,
    doc.session_number,
    doc.device_id,
    doc.store_id,
    new Date(doc.created_at),
  ]);

  // для INSERT IGNORE mysql2 возвращает объект с affectedRows
  const affected =
    res && typeof res.affectedRows === 'number' ? res.affectedRows : 0;

  return affected > 0;
}

// ===== запуск отчётов по закрытой смене =====
function runReport(scriptPath, args) {
  return new Promise((resolve, reject) => {
    console.log('evotorSessions: runReport start:', {
      node: NODE_BIN,
      scriptPath,
      cwd: APP_DIR,
      args,
    });

    const child = spawn(NODE_BIN, [scriptPath, ...args], {
      cwd: APP_DIR,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', err => {
      reject(err);
    });

    child.on('close', code => {
      if (code === 0) {
        console.log(`evotorSessions: runReport OK: ${scriptPath}`);
        resolve();
      } else {
        reject(new Error(`${scriptPath} exited with code ${code}`));
      }
    });
  });
}

async function runReportsForClosedSession(sessionId, sessionNumber) {
  if (!TG_CHAT_REPORT) {
    console.log(
      'evotorSessions: TG_CHAT_REPORT не задан, отчёты по смене не шлём',
    );
    return;
  }

  const argsCommon = [
    `--sessionId=${sessionId}`,
    `--chatId=${TG_CHAT_REPORT}`,
    '--preferOpen=false', // по закрытой смене явно
  ];

  console.log(
    `evotorSessions: запускаем отчёты по закрытой смене session_id=${sessionId}, session_number=${sessionNumber}`,
  );

  const results = await Promise.allSettled([
    runReport(SESSION_REPORT, argsCommon),
    runReport(PRODUCTS_REPORT, argsCommon),
  ]);

  const failed = results
    .map((r, idx) => ({
      idx,
      name: idx === 0 ? 'SESSION_REPORT' : 'PRODUCTS_REPORT',
      script: idx === 0 ? SESSION_REPORT : PRODUCTS_REPORT,
      result: r,
    }))
    .filter(x => x.result.status === 'rejected');

  if (failed.length > 0) {
    for (const f of failed) {
      console.error(
        `evotorSessions: отчёт ${f.name} упал:`,
        f.result.reason?.stack || f.result.reason?.message || f.result.reason,
      );
    }

    throw new Error(
      `Ошибка формирования отчётов: ${failed.map(f => f.name).join(', ')}`,
    );
  }

  console.log(
    `evotorSessions: отчёты успешно сформированы по session_id=${sessionId}, session_number=${sessionNumber}`,
  );
}

(async () => {
  try {
    let since = null;

    if (!LOAD_ALL_SESSIONS) {
      const last = await getLastSessionMs();
      since = last ? last + 1 : null;

      if (since) {
        console.log(
          `evotorSessions: incremental since=${since} (${new Date(
            since,
          ).toISOString()})`,
        );
      } else {
        console.log('evotorSessions: первая полная загрузка (since=null)');
      }
    } else {
      console.log(
        'evotorSessions: LOAD_ALL_SESSIONS=true → загружаем все сессии',
      );
    }

    let cursor = null;
    let total = 0;

    // будем копить только новые закрытые сессии
    const newlyClosed = new Map(); // key=session_id → session_number

    while (true) {
      const { items, next } = await fetchPage({ since, cursor });

      for (const doc of items) {
        const inserted = await saveSession(doc);

        if (inserted) {
          total++;

          if (
            doc.type === 'CLOSE_SESSION' &&
            doc.session_id &&
            doc.session_number != null
          ) {
            newlyClosed.set(doc.session_id, doc.session_number);
          }
        }
      }

      if (!next) break;
      cursor = next;
    }

    console.log(`evotorSessions: inserted=${total}`);

    // === флаги закрытия смены ===
    let flagEvotor = envBool('SESSION_CLOSED_EVOTOR', false);
    let flagGizmo = envBool('SESSION_CLOSED_GIZMO', false);

    // последняя смена, закрытая именно в ЭТОМ запуске
    let justClosedSessionId = null;
    let justClosedSessionNumber = null;

    // если поймали новую CLOSE_SESSION — считаем, что Эвотор закрыл смену
    if (newlyClosed.size > 0) {
      // берём "последнюю" из только что закрытых
      for (const [sid, snum] of newlyClosed.entries()) {
        justClosedSessionId = sid;
        justClosedSessionNumber = snum;
      }

      setEnvFlag('SESSION_CLOSED_EVOTOR', 1);
      flagEvotor = true;

      console.log(
        `evotorSessions: SESSION_CLOSED_EVOTOR=1 (новая CLOSE_SESSION, session_id=${justClosedSessionId}, session_number=${justClosedSessionNumber})`,
      );
    }

    // если обе стороны уже закрыли смену,
    // ТОГДА СРАЗУ в этом запуске строим отчёт
    if (flagEvotor && flagGizmo) {
      let sessionId = justClosedSessionId;
      let sessionNumber = justClosedSessionNumber;

      // если в этом запуске новой CLOSE_SESSION не было
      // (флаги были выставлены ранее) — берём последнюю закрытую из БД
      if (!sessionId) {
        const lastClosed = await getLastClosedSession();

        if (lastClosed) {
          sessionId = lastClosed.session_id;
          sessionNumber = lastClosed.session_number;
        }
      }

      if (sessionId) {
        const zExists = await hasZReport(sessionId);

        if (!zExists) {
          console.log(
            `evotorSessions: Z-отчёт по session_id=${sessionId} ещё не загружен, отчёты не запускаем`,
          );

          // сообщение в чат: Z-отчёт формируется
          if (TG_CHAT_REPORT) {
            await send(
              TG_CHAT_REPORT,
              'Z-отчёт Evotor формируется, ожидайте...',
            );
          }
        } else {
          // Z-отчёт есть → сначала отчёты, потом сброс обоих флагов
          await runReportsForClosedSession(sessionId, sessionNumber);

          setEnvFlag('SESSION_CLOSED_EVOTOR', 0);
          setEnvFlag('SESSION_CLOSED_GIZMO', 0);
          console.log('evotorSessions: флаги SESSION_CLOSED_* сброшены в 0');
        }
      } else {
        console.warn(
          'evotorSessions: SESSION_CLOSED_EVOTOR=1 и SESSION_CLOSED_GIZMO=1, но не нашли закрытую смену',
        );
      }
    } else {
      console.log(
        `evotorSessions: флаги закрытия — EVOTOR=${
          flagEvotor ? 1 : 0
        }, GIZMO=${flagGizmo ? 1 : 0}`,
      );
    }
  } catch (e) {
    console.error('evotorSessions error:', e?.stack || e?.message || e);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
})();