// /home/a/abokovsa/berserkclub.ru/MyBerserk/telegram/background/telegram/telegramWorker.mjs

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { processTelegramUpdate } from './telegramProcessor.mjs';

const PROJECT_ROOT = '/home/a/abokovsa/berserkclub.ru/MyBerserk';
const ENV_PATH = `${PROJECT_ROOT}/.env`;

const LOG_FILE = '/home/a/abokovsa/berserkclub.ru/logs/telegramWorker.log';

const IDLE_SLEEP_MS = 50;
const ERROR_SLEEP_MS = 2000;

const TABLE_NAME = 'telegram_updates_queue';
const LOG_TO_CONSOLE = false;

// если воркер упал и оставил processing=1, через сколько минут считать запись зависшей
const STUCK_PROCESSING_MINUTES = 15;

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function logLine(text) {
  ensureDirForFile(LOG_FILE);
  const line = `[${new Date().toISOString()}] [TELEGRAM_WORKER] ${text}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
  if (LOG_TO_CONSOLE) process.stdout.write(line);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resetStuckProcessing(pool, logLineFn) {
  const [res] = await pool.execute(
    `
    UPDATE ${TABLE_NAME}
    SET processing = 0
    WHERE processed = 0
      AND processing = 1
      AND received_at < (NOW() - INTERVAL ? MINUTE)
    `,
    [STUCK_PROCESSING_MINUTES]
  );

  const affected = Number(res?.affectedRows ?? 0);
  if (affected > 0) {
    logLineFn(`reset stuck processing rows=${affected}`);
  }
}

async function claimNextUpdate(conn) {
  await conn.beginTransaction();

  try {
    const [rows] = await conn.execute(
      `
      SELECT id, payload, source, received_at
      FROM ${TABLE_NAME}
      WHERE processed = 0
        AND processing = 0
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE
      `
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      await conn.commit();
      return null;
    }

    const row = rows[0];

    await conn.execute(
      `
      UPDATE ${TABLE_NAME}
      SET processing = 1,
          error_text = NULL
      WHERE id = ?
      `,
      [row.id]
    );

    await conn.commit();
    return row;
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

async function markProcessed(conn, id) {
  await conn.execute(
    `
    UPDATE ${TABLE_NAME}
    SET processed = 1,
        processing = 0,
        processed_at = NOW(),
        error_text = NULL
    WHERE id = ?
    `,
    [id]
  );
}

async function markError(conn, id, errorText) {
  await conn.execute(
    `
    UPDATE ${TABLE_NAME}
    SET processing = 0,
        processed_at = NULL,
        error_text = ?
    WHERE id = ?
    `,
    [String(errorText).slice(0, 65000), id]
  );
}

function calcQueueAgeMs(receivedAt) {
  if (!receivedAt) return null;
  const ts = new Date(receivedAt).getTime();
  if (Number.isNaN(ts)) return null;
  return Date.now() - ts;
}

async function main() {
  loadEnv();

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

  await resetStuckProcessing(pool, logLine);
  logLine('START worker');

  while (true) {
    let conn = null;
    let row = null;

    try {
      conn = await pool.getConnection();
      row = await claimNextUpdate(conn);
      conn.release();
      conn = null;

      if (!row) {
        await sleep(IDLE_SLEEP_MS);
        continue;
      }

      const queueAgeMs = calcQueueAgeMs(row.received_at);
      logLine(
        `claimed id=${row.id}`
        + ` source=${row.source ?? '-'}`
        + ` queue_age_ms=${queueAgeMs == null ? 'null' : queueAgeMs}`
      );

      try {
        await processTelegramUpdate({
          row,
          pool,
          logLine,
        });

        const conn2 = await pool.getConnection();
        try {
          await markProcessed(conn2, row.id);
        } finally {
          conn2.release();
        }

        logLine(
          `processed ok id=${row.id}`
          + ` queue_age_ms=${queueAgeMs == null ? 'null' : queueAgeMs}`
        );
      } catch (err) {
        const conn3 = await pool.getConnection();
        try {
          await markError(conn3, row.id, String(err?.stack || err));
        } finally {
          conn3.release();
        }

        logLine(
          `processed error id=${row.id}`
          + ` queue_age_ms=${queueAgeMs == null ? 'null' : queueAgeMs}`
          + ` err=${String(err?.message || err)}`
        );
      }
    } catch (err) {
      if (conn) {
        try {
          conn.release();
        } catch {}
      }

      logLine(`loop exception=${String(err?.stack || err)}`);
      await sleep(ERROR_SLEEP_MS);
    }
  }
}

main().catch(err => {
  logLine(`fatal=${String(err?.stack || err)}`);
  process.exit(1);
});