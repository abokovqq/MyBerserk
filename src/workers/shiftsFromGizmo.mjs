// src/workers/shiftsFromGizmo.mjs
import '../env.js';
import { gizmoFetch } from '../gizmoClient.js';
import { q } from '../db.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs';
import path from 'path';

const TZ = process.env.TZ || 'Europe/Moscow';

// тестовый флаг: принудительно считать активную смену "только что закрытой"
const TEST_MAN_ACT =
  String(process.env.TEST_MAN_ACT || '').toLowerCase() === '1' ||
  String(process.env.TEST_MAN_ACT || '').toLowerCase() === 'true';

// путь к отчёту
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const CLEANING_REPORT_PATH = resolve(__dirname, '../tools/cleaningReport.mjs');

// путь к .env
const ENV_PATH = '/home/a/abokovsa/berserkclub.ru/MyBerserk/.env';

// =========================
// helpers
// =========================
function nowTZ() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function toGizmoTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds()) +
    '.000'
  );
}

function parseISOorNull(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// запись SESSION_CLOSED_GIZMO=1 в .env
function setSessionClosedGizmo() {
  try {
    let env = '';

    if (fs.existsSync(ENV_PATH)) {
      env = fs.readFileSync(ENV_PATH, 'utf-8');
    }

    if (env.includes('SESSION_CLOSED_GIZMO=')) {
      env = env.replace(/SESSION_CLOSED_GIZMO=.*/g, 'SESSION_CLOSED_GIZMO=1');
    } else {
      env += '\nSESSION_CLOSED_GIZMO=1\n';
    }

    fs.writeFileSync(ENV_PATH, env.trim() + '\n');
    console.log('⚙️ SESSION_CLOSED_GIZMO=1 записано в .env');
  } catch (err) {
    console.error('❌ Ошибка записи SESSION_CLOSED_GIZMO в .env:', err);
  }
}

// разбор фактических сумм
function extractPaymentActuals(details) {
  const res = { cash: 0, nonCash: 0, other: [] };
  const list = Array.isArray(details) ? details : [];
  let seen = false;

  for (const d of list) {
    if (d.actual == null) continue;
    const method = String(d.paymentMethodName || '').toLowerCase();
    const val = Number(d.actual);
    seen = true;

    if (method === 'cash') res.cash += val;
    else res.nonCash += val;

    res.other.push({ name: d.paymentMethodName, actual: val });
  }

  if (!seen) {
    res.cash = null;
    res.nonCash = null;
  }
  return res;
}

async function runCleaningReport(shiftId, opts = {}) {
  const reason = opts.reason ? ` (${opts.reason})` : '';
  console.log(`🧹 Запускаем отчёт уборки для смены ${shiftId}${reason}...`);
  console.log(
    `🧹 cmd: ${process.execPath} ${CLEANING_REPORT_PATH} --shiftId ${shiftId}`
  );

  const child = spawn(
    process.execPath,
    [CLEANING_REPORT_PATH, `--shiftId=${shiftId}`],
    { stdio: 'inherit' }
  );

  await new Promise((resolve) => {
    child.on('close', (code) => {
      console.log(`🧹 cleaningReport.mjs завершился с кодом ${code}`);
      resolve();
    });
  });
}

// =========================
// CLI args
// =========================
const argv = process.argv.slice(2);
function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a === `--${name}` || a.startsWith(pref));
  if (!found) return def;
  if (found === `--${name}`) return true;
  return found.slice(pref.length);
}

// приоритет: shiftId -> (from,to) -> days
const MANUAL_SHIFT_ID = getArg('shiftId', null);
const FROM_ARG = getArg('from', null);
const TO_ARG = getArg('to', null);
const DAYS_ARG = getArg('days', '7');
const DAYS = Number(DAYS_ARG) || 7;

let dateFrom;
let dateTo;

if (MANUAL_SHIFT_ID) {
  dateTo = nowTZ();
  dateFrom = new Date(dateTo);
  dateFrom.setDate(dateFrom.getDate() - 7);
} else if (FROM_ARG || TO_ARG) {
  dateFrom = FROM_ARG ? new Date(FROM_ARG) : nowTZ();
  dateFrom.setHours(0, 0, 0, 0);

  dateTo = TO_ARG ? new Date(TO_ARG) : nowTZ();
  dateTo.setHours(23, 59, 59, 999);
} else {
  dateTo = nowTZ();
  dateFrom = new Date(dateTo);
  dateFrom.setDate(dateFrom.getDate() - DAYS);
}

console.log(`🔍 [${TZ}] Запрашиваем отчёт по сменам: ${dateFrom.toISOString()} → ${dateTo.toISOString()}`);
if (TEST_MAN_ACT) {
  console.log('🧪 TEST_MAN_ACT=on — при первой активной смене сделаем тестовый вызов отчёта.');
}

// запрос к Gizmo
const params = new URLSearchParams({
  ShiftsLogReportType: '2',
  DateFrom: toGizmoTime(dateFrom),
  DateTo: toGizmoTime(dateTo),
});

const rep = await gizmoFetch(`/api/reports/shiftslog?${params.toString()}`);
const root = rep?.result ? rep.result : rep;
const shifts = Array.isArray(root?.shifts) ? root.shifts : [];

console.log(`📋 Получено смен: ${shifts.length}`);

let toSave = shifts;
if (MANUAL_SHIFT_ID) {
  toSave = shifts.filter(s => String(s.shiftId) === String(MANUAL_SHIFT_ID));
  if (!toSave.length) {
    console.log(`⛔ Смена ${MANUAL_SHIFT_ID} в этом диапазоне не найдена.`);
    process.exit(0);
  }
}

let testFired = false;

// =========================
// запись в БД + определение закрытия
// =========================
for (const sh of toSave) {
  const shiftId = Number(sh.shiftId) || 0;
  if (!shiftId) {
    console.log('⚠️ пропуск: нет shiftId в записи', sh);
    continue;
  }

  const isActive = String(sh.isActive).toLowerCase() === 'true' ? 1 : 0;
  const startTime = parseISOorNull(sh.startTime);
  const endTime = parseISOorNull(sh.endTime);

  const operatorId = sh.operatorId ? Number(sh.operatorId) : null;
  const operatorName = sh.operatorName || null;
  const registerId = sh.registerId ? Number(sh.registerId) : null;
  const registerName = sh.registerName || null;
  const startCash = (sh.startCash !== undefined && sh.startCash !== null)
    ? Number(sh.startCash)
    : null;

  const actualTotal = (sh.actual !== undefined && sh.actual !== null)
    ? Number(sh.actual)
    : null;

  const paymentActuals = extractPaymentActuals(sh.details);
  const cashActual = paymentActuals.cash;
  const nonCashActual = paymentActuals.nonCash;

  const rawJson = JSON.stringify({
    ...sh,
    paymentActuals,
  });

  const existingRows = await q(
    'SELECT shift_id, is_active, end_time FROM shift_data WHERE shift_id = ? LIMIT 1',
    [shiftId]
  );

  let justClosed = false;

  if (!existingRows.length) {
    // новая смена
    const ins = await q(
      `INSERT INTO shift_data
        (shift_id, is_active, start_time, end_time,
         operator_id, operator_name, register_id, register_name,
         start_cash, actual, cash_actual, noncash_actual,
         raw_json, created_at, updated_at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        shiftId,
        isActive,
        startTime ? startTime : null,
        endTime ? endTime : null,
        operatorId,
        operatorName,
        registerId,
        registerName,
        startCash,
        actualTotal,
        cashActual,
        nonCashActual,
        rawJson,
      ]
    );

    if (ins.affectedRows) {
      console.log(
        `✅ новая смена shift_id=${shiftId} сохранена (active=${isActive}, start=${sh.startTime}, end=${sh.endTime || '—'})`
      );
    }

    if (isActive === 0 && endTime) {
      justClosed = true;
    }
  } else {
    const prev = existingRows[0];
    const prevActive = Number(prev.is_active) === 1;
    const prevEnd = prev.end_time ? new Date(prev.end_time) : null;

    if (prevActive && isActive === 0 && endTime) {
      justClosed = true;
    }

    if (!prevActive && isActive === 0) {
      if (prevEnd && endTime && prevEnd.getTime() === endTime.getTime()) {
        console.log(`⏭️ shift_id=${shiftId} закрыта и не изменилась — пропускаем`);
      } else {
        const upd = await q(
          `UPDATE shift_data
             SET is_active      = ?,
                 start_time     = ?,
                 end_time       = ?,
                 operator_id    = ?,
                 operator_name  = ?,
                 register_id    = ?,
                 register_name  = ?,
                 start_cash     = ?,
                 actual         = ?,
                 cash_actual    = ?,
                 noncash_actual = ?,
                 raw_json       = ?,
                 updated_at     = NOW()
           WHERE shift_id = ?`,
          [
            isActive,
            startTime ? startTime : null,
            endTime ? endTime : null,
            operatorId,
            operatorName,
            registerId,
            registerName,
            startCash,
            actualTotal,
            cashActual,
            nonCashActual,
            rawJson,
            shiftId,
          ]
        );

        if (upd.affectedRows) {
          console.log(
            `↔️ shift_id=${shiftId} обновлён (active=${isActive}, end=${endTime ? endTime.toISOString() : '—'})`
          );
        }
      }
    } else {
      const upd = await q(
        `UPDATE shift_data
           SET is_active      = ?,
               start_time     = ?,
               end_time       = ?,
               operator_id    = ?,
               operator_name  = ?,
               register_id    = ?,
               register_name  = ?,
               start_cash     = ?,
               actual         = ?,
               cash_actual    = ?,
               noncash_actual = ?,
               raw_json       = ?,
               updated_at     = NOW()
         WHERE shift_id = ?`,
        [
          isActive,
          startTime ? startTime : null,
          endTime ? endTime : null,
          operatorId,
          operatorName,
          registerId,
          registerName,
          startCash,
          actualTotal,
          cashActual,
          nonCashActual,
          rawJson,
          shiftId,
        ]
      );

      if (upd.affectedRows) {
        console.log(
          `↔️ shift_id=${shiftId} обновлён (active=${isActive}, end=${endTime ? endTime.toISOString() : '—'})`
        );
      }
    }
  }

  // 🔴 тестовый режим
  if (TEST_MAN_ACT && !testFired && isActive === 1) {
    testFired = true;
    console.log(`🧪 TEST_MAN_ACT: имитируем закрытие активной смены shift_id=${shiftId}`);
    setSessionClosedGizmo();
    await runCleaningReport(shiftId, { reason: 'TEST_MAN_ACT' });
  }

  // 🔔 реальное закрытие смены
  if (justClosed) {
    console.log(`🔔 Смена Gizmo ${shiftId} закрылась — устанавливаем SESSION_CLOSED_GIZMO=1`);
    setSessionClosedGizmo();
    await runCleaningReport(shiftId);
  }
}

console.log('🏁 Готово.');
process.exit(0);
