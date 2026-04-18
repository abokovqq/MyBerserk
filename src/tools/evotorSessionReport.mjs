// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorSessionReport.mjs

import '../env.js';
import fs from 'fs';
import { spawn } from 'node:child_process';

import { q } from '../db.js';
import { send } from '../tg.js';
import { gizmoFetch } from '../gizmoClient.js';
import { renderTableToPngWrap } from './tableRenderWrap.mjs';

const TZ = process.env.TZ || 'Europe/Moscow';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEVICE_ID = String(process.env.DEVICE_ID || '').trim();

if (!DEVICE_ID) {
  console.error('Ошибка: в .env не задан DEVICE_ID');
  process.exit(1);
}

function envNum(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const clean = raw.split('#')[0].trim();
  const n = Number(clean);
  return Number.isNaN(n) ? null : n;
}

const DEFAULT_CHAT_ID = envNum('TG_CHAT_REPORT');

const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  if (!found) return def;
  return found.substring(pref.length);
}

function boolArg(name, def = false) {
  const val = getArg(name, null);
  if (val === null) return def;
  return ['1', 'true', 'yes', 'y'].includes(String(val).toLowerCase());
}

const chatId = Number(getArg('chatId', DEFAULT_CHAT_ID)) || DEFAULT_CHAT_ID;

const sessionNumberArg = getArg('sessionNumber', null);
const sessionIdArg = getArg('sessionId', null);
const preferOpen = boolArg('preferOpen', false);

// ================= DATE/TIME UTILS =================

function parseDateFlexible(dtStr) {
  if (!dtStr) return null;

  if (dtStr instanceof Date) {
    return Number.isNaN(dtStr.getTime()) ? null : dtStr;
  }

  const raw = String(dtStr);

  let d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;

  d = new Date(raw.replace(' ', 'T'));
  if (!Number.isNaN(d.getTime())) return d;

  return null;
}

function formatDateTime(dtStr) {
  const d = parseDateFlexible(dtStr);
  if (!d) return 'ММ.ДД ЧЧ:ММ';

  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');

  return `${dd}.${mm} ${hh}:${mi}`;
}

function formatTimeHM(dt) {
  const d = dt instanceof Date ? dt : parseDateFlexible(dt);
  if (!d) return '--:--';
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

// ⛔️ НЕ ТРОГАЕМ: это логика ТЕКСТА отчёта (как в проекте)
// (по закрытию смены) — дневная/ночная тут инвертированы относительно таблицы
function shiftTypeFromDate(dtStr) {
  const d = parseDateFlexible(dtStr);
  if (!d) return 'Дневная';
  const h = d.getHours();
  return h >= 4 && h < 16 ? 'Ночная' : 'Дневная';
}

function money(v) {
  if (v == null) return '0.00';
  return (Math.round(v * 100) / 100).toFixed(2);
}

function toMySQLDateTime(d) {
  const date = parseDateFlexible(d);
  if (!date) return null;

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// ================= GS CASH UPDATE (by OPEN_SESSION) =================

const GS_CASHUPDATE_ENABLED =
  String(process.env.GS_CASHUPDATE_ENABLED || '').toLowerCase() === '1' ||
  String(process.env.GS_CASHUPDATE_ENABLED || '').toLowerCase() === 'true';

function monthSheetRuByMonthIndex(m0) {
  const names = [
    'Январь',
    'Февраль',
    'Март',
    'Апрель',
    'Май',
    'Июнь',
    'Июль',
    'Август',
    'Сентябрь',
    'Октябрь',
    'Ноябрь',
    'Декабрь',
  ];
  return names[m0] || null;
}

// ✅ ПРАВИЛО: определение по ОТКРЫТИЮ смены (для таблицы)
// ДНЕВНАЯ: 04:00–15:59  -> shift=day
// НОЧНАЯ: 16:00–03:59  -> shift=night
function shiftFromOpenHour(hour) {
  return hour >= 4 && hour < 16 ? 'day' : 'night';
}

function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/**
 * ✅ ВАЖНО:
 * Нельзя spawn('node', ...) потому что из webhook/PHP часто нет node в PATH.
 * Запускаем тем же бинарём Node, которым запущен текущий процесс: process.execPath.
 */
function runGsCashUpdate({ monthSheet, year, day, shift, cashRevenue }) {
  return new Promise((resolve, reject) => {
    const args = [
      'src/utils/gsCashUpdate.mjs',
      `--monthSheet=${monthSheet}`,
      `--year=${year}`,
      `--day=${day}`,
      `--shift=${shift}`,
      `--cashRevenue=${cashRevenue}`,
    ];

    const p = spawn(process.execPath, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.stderr.on('data', d => (err += d.toString()));

    p.on('error', e => {
      reject(new Error(`gsCashUpdate spawn error: ${e?.message || e}`));
    });

    p.on('close', code => {
      if (code === 0) return resolve(out.trim());
      reject(new Error(`gsCashUpdate failed (code=${code}): ${err || out}`));
    });
  });
}

// ================= SESSION HELPERS ======================

async function findOpenSession() {
  const rows = await q(
    `
    SELECT s.session_id, s.session_number, s.close_date
    FROM evotor_sessions s
    WHERE s.evotor_type='OPEN_SESSION'
      AND s.device_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM evotor_sessions c
        WHERE c.session_id = s.session_id
          AND c.device_id = s.device_id
          AND c.evotor_type='CLOSE_SESSION'
      )
    ORDER BY s.close_date DESC
    LIMIT 1
  `,
    [DEVICE_ID],
  );
  return rows[0] || null;
}

async function findLastClosedSession() {
  const rows = await q(
    `
    SELECT session_id, session_number, close_date
    FROM evotor_sessions
    WHERE evotor_type='CLOSE_SESSION'
      AND device_id = ?
    ORDER BY close_date DESC
    LIMIT 1
  `,
    [DEVICE_ID],
  );
  return rows[0] || null;
}

async function findBySessionNumber(sessionNumber) {
  const closed = await q(
    `
    SELECT session_id, session_number, close_date
    FROM evotor_sessions
    WHERE evotor_type='CLOSE_SESSION'
      AND session_number = ?
      AND device_id = ?
    ORDER BY close_date DESC
    LIMIT 1
  `,
    [sessionNumber, DEVICE_ID],
  );
  if (closed.length) return closed[0];

  const open = await q(
    `
    SELECT session_id, session_number, close_date
    FROM evotor_sessions
    WHERE evotor_type='OPEN_SESSION'
      AND session_number = ?
      AND device_id = ?
    ORDER BY close_date DESC
    LIMIT 1
  `,
    [sessionNumber, DEVICE_ID],
  );
  return open[0] || null;
}

async function findBySessionId(sessionId) {
  const closed = await q(
    `
    SELECT session_id, session_number, close_date
    FROM evotor_sessions
    WHERE evotor_type='CLOSE_SESSION'
      AND session_id = ?
      AND device_id = ?
    ORDER BY close_date DESC
    LIMIT 1
  `,
    [sessionId, DEVICE_ID],
  );
  if (closed.length) return closed[0];

  const open = await q(
    `
    SELECT session_id, session_number, close_date
    FROM evotor_sessions
    WHERE evotor_type='OPEN_SESSION'
      AND session_id = ?
      AND device_id = ?
    ORDER BY close_date DESC
    LIMIT 1
  `,
    [sessionId, DEVICE_ID],
  );
  return open[0] || null;
}

async function resolveSession() {
  if (sessionIdArg) {
    const s = await findBySessionId(sessionIdArg);
    if (s) return s;
  }

  if (sessionNumberArg) {
    const s = await findBySessionNumber(sessionNumberArg);
    if (s) return s;
  }

  if (preferOpen) {
    const open = await findOpenSession();
    if (open) return open;
  }

  return await findLastClosedSession();
}

async function loadSessionTimes(sessionId) {
  const rows = await q(
    `
    SELECT evotor_type, close_date
    FROM evotor_sessions
    WHERE session_id = ?
      AND device_id = ?
  `,
    [sessionId, DEVICE_ID],
  );

  let opened_at = null;
  let closed_at = null;

  for (const r of rows) {
    if (r.evotor_type === 'OPEN_SESSION') {
      if (!opened_at || new Date(r.close_date) < new Date(opened_at)) opened_at = r.close_date;
    } else if (r.evotor_type === 'CLOSE_SESSION') {
      if (!closed_at || new Date(r.close_date) > new Date(closed_at)) closed_at = r.close_date;
    }
  }

  return { opened_at, closed_at };
}

// =========== Z REPORT ==============

async function loadZReport(sessionId) {
  const rows = await q(
    `
    SELECT session_id, session_number,
           z_total, z_cash, z_electron,
           z_refund_total, z_refund_cash, z_refund_electron
    FROM evotor_z_reports
    WHERE session_id = ?
    LIMIT 1
  `,
    [sessionId],
  );
  return rows[0] || null;
}

// =========== GIZMO shift (по времени) =============

async function loadLastGizmoShift() {
  try {
    const rows = await q(`
      SELECT shift_id, cash_actual, noncash_actual, actual, end_time
      FROM shift_data
      WHERE is_active = 0
      ORDER BY end_time DESC
      LIMIT 1
    `);
    return rows[0] || null;
  } catch (e) {
    console.error('loadLastGizmoShift error:', e);
    return null;
  }
}

// смена Gizmo по времени закрытия Evotor (+- 30 минут)
async function loadGizmoShiftNearEvotorClose(evotorClose) {
  const base = parseDateFlexible(evotorClose);
  if (!base) return null;

  const deltaMs = 30 * 60 * 1000;
  const from = new Date(base.getTime() - deltaMs);
  const to = new Date(base.getTime() + deltaMs);

  const fromStr = toMySQLDateTime(from);
  const toStr = toMySQLDateTime(to);
  const baseStr = toMySQLDateTime(base);

  if (!fromStr || !toStr || !baseStr) return null;

  try {
    const rows = await q(
      `
      SELECT shift_id, cash_actual, noncash_actual, actual, end_time
      FROM shift_data
      WHERE is_active = 0
        AND end_time BETWEEN ? AND ?
      ORDER BY ABS(TIMESTAMPDIFF(SECOND, end_time, ?)) ASC
      LIMIT 1
    `,
      [fromStr, toStr, baseStr],
    );

    return rows[0] || null;
  } catch (e) {
    console.error('loadGizmoShiftNearEvotorClose error:', e);
    return null;
  }
}

// ========= BAR STATS (Еда/Напитки/Энергетики/Снэки) =============

async function loadBarStats(sessionNumber, deviceId) {
  const rows = await q(
    `
    SELECT 
      SUM(es.result_sum) AS total,
      SUM(CASE WHEN es.payments_type='CASH'     THEN es.result_sum ELSE 0 END) AS cash,
      SUM(CASE WHEN es.payments_type='ELECTRON' THEN es.result_sum ELSE 0 END) AS electron
    FROM evotor_sales es
    LEFT JOIN evotor_products p
           ON es.product_id = p.product_id
    LEFT JOIN evotor_product_groups g
           ON p.parent_id = g.group_id
    WHERE es.session_number = ?
      AND es.device_id = ?
      AND g.name IN ('Еда','Напитки','Энергетики','Снэки')
  `,
    [sessionNumber, deviceId],
  );

  return rows[0] || { total: 0, cash: 0, electron: 0 };
}

// === GIZMO TOTALS FROM TRANSACTIONS (аналог gizmoTransactionsShiftReport) ===

function toGizmoTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    'T' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds()) +
    '.000'
  );
}

function parseGizmoDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function classifyGizmoMethod(methodName) {
  if (!methodName) return 'other';
  const m = methodName.toLowerCase();

  if (m.includes('бонус')) return 'bonus';
  if (m.includes('cash')) return 'cash';
  if (m.includes('card')) return 'noncash';
  if (m.includes('online')) return 'noncash';
  if (m.includes('tinkoff')) return 'noncash';
  if (m.includes('deposit')) return 'noncash';

  return 'other';
}

function nearlyEqual(a, b, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}

// ===== DEBUG HELPERS =====

function safeStr(v) {
  if (v == null) return '';
  return String(v);
}

function dbgRowFromGizmoTx(t) {
  const title = safeStr(t.title).trim();
  const op = safeStr(t.operatorName).trim();
  const method = safeStr(t.paymentMethodName).trim();
  const amount = t.total != null ? Number(t.total) : t.value != null ? Number(t.value) : 0;

  return {
    dt: safeStr(t.transactionDate),
    title,
    operator: op,
    method,
    amount,
    invoiceId: safeStr(t.invoiceId),
    customer: safeStr(t.customerName),
  };
}

function dbgRowFromPayment(g) {
  return {
    time: g.time ? formatTimeHM(g.time) : '--:--',
    title: safeStr(g.title),
    titleNorm: safeStr(g.titleNorm || ''),
    amount: g.amount,
    payType: safeStr(g.payType),
    method: safeStr(g.method),
    invoiceId: safeStr(g.id),
    customer: safeStr(g.customer),
  };
}

function dbgPrintBlock(title, rows, maxRows = 80) {
  console.log('\n==================== ' + title + ' ====================');
  if (!rows || !rows.length) {
    console.log('(empty)');
    return;
  }
  const slice = rows.slice(0, maxRows);
  console.table(slice);
  if (rows.length > maxRows) {
    console.log(`... (${rows.length - maxRows} more rows)`);
  }
}

// ✅ Deposit Void учитываем ТОЛЬКО для Cash / Credit Card
function isCashOrCreditCardMethod(methodName) {
  const ml = String(methodName || '').toLowerCase();
  if (ml === 'cash') return true;
  if (ml.includes('credit') && ml.includes('card')) return true;
  return false;
}

// ===== BONUS STATUS HELPERS (bonus_tasks) =====

function normalizeBonusStatusDbToLabel(statusRaw) {
  const s = String(statusRaw || '').toLowerCase().trim();
  if (s === 'promo') return 'акция';
  if (s === 'boss') return 'босс';
  if (s === 'admin') return 'админ';
  return 'нет';
}

function normalizeName(s) {
  return String(s || '').trim().toLowerCase();
}

function findBestBonusTaskMatch(bonus, tasks) {
  if (!bonus?.time || !tasks?.length) return null;

  const bName = normalizeName(bonus.customer);
  const bAmt = Number(bonus.amount || 0);

  let best = null;
  let bestDt = Infinity;

  const WIN_MS = 30 * 60 * 1000;

  for (const t of tasks) {
    if (!t.trx_time) continue;

    const tAmt = Number(t.amount || 0);
    if (!nearlyEqual(tAmt, bAmt)) continue;

    const tName = normalizeName(t.client_name);
    const nameOk =
      (bName && tName && (bName === tName || bName.includes(tName) || tName.includes(bName))) ||
      (!bName && !tName);

    if (!nameOk) continue;

    const diff = Math.abs(t.trx_time.getTime() - bonus.time.getTime());
    if (diff > WIN_MS) continue;

    if (diff < bestDt) {
      bestDt = diff;
      best = t;
    }
  }

  return best;
}

async function loadBonusTasksForShift(shiftId) {
  if (!shiftId) return [];
  try {
    const rows = await q(
      `
      SELECT id, trx_time, client_name, amount, status
      FROM bonus_tasks
      WHERE shift_id = ?
      `,
      [shiftId],
    );

    return (rows || []).map(r => ({
      id: r.id,
      trx_time: parseDateFlexible(r.trx_time),
      client_name: r.client_name,
      amount: Number(r.amount || 0),
      status: r.status,
    }));
  } catch (e) {
    console.error('loadBonusTasksForShift error:', e);
    return [];
  }
}

// расчёт GIZMO НАЛ/БЕЗНАЛ и бонусов по транзакциям для shift_id
async function calcGizmoTotalsForShift(shiftId) {
  try {
    const shiftRows = await q(
      `
        SELECT shift_id, start_time, end_time, operator_name
        FROM shift_data
        WHERE shift_id = ?
        LIMIT 1
      `,
      [shiftId],
    );

    if (!shiftRows.length) return null;
    const shift = shiftRows[0];

    if (!shift.start_time || !shift.end_time) return null;

    const dtFrom = new Date(shift.start_time);
    const dtTo = new Date(shift.end_time);

    const operators = new Set(['Администратор', 'Admin']);
    if (shift.operator_name) operators.add(String(shift.operator_name).trim());

    console.log('\n=== GIZMO DEBUG: calcGizmoTotalsForShift ===');
    console.log('shift_id:', shiftId);
    console.log('shift operator_name:', safeStr(shift.operator_name));
    console.log('operators allowlist:', Array.from(operators.values()));
    console.log('DateFrom:', toGizmoTime(dtFrom));
    console.log('DateTo  :', toGizmoTime(dtTo));

    const params = new URLSearchParams({
      DateFrom: toGizmoTime(dtFrom),
      DateTo: toGizmoTime(dtTo),
    });

    let gizmoResp;
    try {
      gizmoResp = await gizmoFetch(`/api/reports/transactionslog?${params}`, {
        method: 'GET',
        apiVersion: 1,
      });
    } catch (e) {
      console.error('calcGizmoTotalsForShift: gizmoFetch error:', e);
      return null;
    }

    const gizmoTransactions = Array.isArray(gizmoResp?.result?.transactions)
      ? gizmoResp.result.transactions
      : [];

    dbgPrintBlock(
      'GIZMO RAW transactions (before any filter)',
      gizmoTransactions.map(dbgRowFromGizmoTx),
      200,
    );

    let gizmoPayments = [];

    for (const t of gizmoTransactions) {
      const rawTitle = t.title || '';
      const title = rawTitle.trim();
      const tl = title.toLowerCase();
      const op = (t.operatorName || '').trim();

      const method = t.paymentMethodName || '';
      const ml = String(method).toLowerCase();

      if (ml.includes('deposit') && !ml.includes('бонус')) continue;

      const okOp = op === '' || operators.has(op);
      if (!okOp) continue;

      if (tl.startsWith('auto invoice') || tl.startsWith('auto payment')) continue;

      if (tl === 'void') continue;

      const isDepositVoid = tl === 'deposit void' || (tl.startsWith('deposit') && tl.includes('void'));
      let titleNorm = title;
      if (isDepositVoid) {
        if (!isCashOrCreditCardMethod(method)) {
          continue;
        }
        titleNorm = 'Withdraw';
      }

      let isMoney = false;

      if (tl === 'payment' || tl === 'deposit' || tl === 'withdraw') isMoney = true;

      if (titleNorm === 'Withdraw') isMoney = true;

      if (tl.includes('refund') || tl.includes('return') || tl.includes('возврат')) isMoney = true;

      if (ml.includes('бонус')) isMoney = true;

      if (!isMoney) continue;

      const dt = parseGizmoDate(t.transactionDate);

      let amount = 0;
      if (t.total != null) amount = Number(t.total);
      else if (t.value != null) amount = Number(t.value);

      let payType = classifyGizmoMethod(method);

      if (titleNorm === 'Deposit' || titleNorm === 'Withdraw') {
        if (ml.includes('cash')) payType = 'cash';
        else if (ml.includes('card')) payType = 'noncash';
      }

      gizmoPayments.push({
        id: t.invoiceId || null,
        time: dt,
        amount,
        payType,
        method,
        title: title,
        titleNorm: titleNorm,
        customer: t.customerName || '',
      });
    }

    dbgPrintBlock(
      'GIZMO payments AFTER primary filters (operator/auto/void/deposit-method/isMoney)',
      gizmoPayments.map(dbgRowFromPayment),
      250,
    );

    const beforeCount = gizmoPayments.length;

    const totalsByInvoice = new Map();
    for (const g of gizmoPayments) {
      if (!g.id) continue;
      const cur = totalsByInvoice.get(g.id) || 0;
      totalsByInvoice.set(g.id, cur + g.amount);
    }

    const cancelledInvoices = new Set(
      [...totalsByInvoice.entries()].filter(([, sum]) => nearlyEqual(sum, 0)).map(([id]) => id),
    );

    if (cancelledInvoices.size) {
      console.log('\nGIZMO DEBUG: cancelledInvoices (sum ~ 0):', Array.from(cancelledInvoices.values()));
    }

    gizmoPayments = gizmoPayments.filter(g => !(g.id && cancelledInvoices.has(g.id)));

    const bonusByCustomer = new Map();
    gizmoPayments.forEach((g, idx) => {
      if (g.payType !== 'bonus') return;
      const key = g.customer || '(no name)';
      let arr = bonusByCustomer.get(key);
      if (!arr) {
        arr = [];
        bonusByCustomer.set(key, arr);
      }
      arr.push({ g, idx });
    });

    const bonusToRemove = new Set();

    for (const [, ops] of bonusByCustomer.entries()) {
      const positives = [];
      const negatives = [];

      for (const op of ops) {
        if (op.g.amount > 0) positives.push(op);
        else if (op.g.amount < 0) negatives.push(op);
      }

      for (const neg of negatives) {
        let bestPosIdx = -1;
        let bestDt = Infinity;

        for (let i = 0; i < positives.length; i++) {
          const pos = positives[i];
          if (!pos) continue;

          if (!nearlyEqual(pos.g.amount, -neg.g.amount)) continue;

          const diff = Math.abs(pos.g.time - neg.g.time);
          if (diff < bestDt) {
            bestDt = diff;
            bestPosIdx = i;
          }
        }

        if (bestPosIdx >= 0) {
          const pos = positives[bestPosIdx];
          bonusToRemove.add(pos.idx);
          bonusToRemove.add(neg.idx);
          positives[bestPosIdx] = null;
        }
      }
    }

    if (bonusToRemove.size > 0) {
      console.log('\nGIZMO DEBUG: bonusToRemove idx:', Array.from(bonusToRemove.values()));
      gizmoPayments = gizmoPayments.filter((_, idx) => !bonusToRemove.has(idx));
    }

    const DEP_WD_WINDOW_MS = 30 * 60 * 1000;

    const depWdByKey = new Map();
    gizmoPayments.forEach((g, idx) => {
      if (g.payType === 'bonus') return;

      const tnorm = String(g.titleNorm || g.title || '').toLowerCase();
      if (tnorm !== 'deposit' && tnorm !== 'withdraw') return;

      const key = `${g.customer || '(no name)'}|${g.method || ''}|${g.payType}`;
      let arr = depWdByKey.get(key);
      if (!arr) {
        arr = [];
        depWdByKey.set(key, arr);
      }
      arr.push({ g, idx });
    });

    const depWdToRemove = new Set();

    for (const [, ops] of depWdByKey.entries()) {
      const positives = ops.filter(
        x =>
          x.g.amount > 0 &&
          String(x.g.titleNorm || x.g.title || '').toLowerCase() === 'deposit',
      );
      const negatives = ops.filter(
        x =>
          x.g.amount < 0 &&
          String(x.g.titleNorm || x.g.title || '').toLowerCase() === 'withdraw',
      );

      for (const neg of negatives) {
        let best = null;
        let bestDt = Infinity;

        for (const pos of positives) {
          if (!pos || depWdToRemove.has(pos.idx)) continue;
          if (!nearlyEqual(pos.g.amount, -neg.g.amount)) continue;

          const diff = Math.abs(pos.g.time - neg.g.time);
          if (diff <= DEP_WD_WINDOW_MS && diff < bestDt) {
            bestDt = diff;
            best = pos;
          }
        }

        if (best) {
          depWdToRemove.add(best.idx);
          depWdToRemove.add(neg.idx);
        }
      }
    }

    if (depWdToRemove.size > 0) {
      console.log('\nGIZMO DEBUG: depWdToRemove idx:', Array.from(depWdToRemove.values()));
      gizmoPayments = gizmoPayments.filter((_, idx) => !depWdToRemove.has(idx));
    }

    dbgPrintBlock(
      'GIZMO payments AFTER cancellations (invoice/bonus/deposit-withdraw)',
      gizmoPayments.map(dbgRowFromPayment),
      250,
    );

    console.log('\nGIZMO DEBUG: counts', {
      afterPrimary: beforeCount,
      afterAllCancels: gizmoPayments.length,
    });

    let gizmoCash = 0;
    let gizmoNonCash = 0;

    for (const g of gizmoPayments) {
      if (g.payType === 'cash') gizmoCash += g.amount;
      else if (g.payType === 'noncash') gizmoNonCash += g.amount;
    }

    const bonuses = [];
    let bonusesTotal = 0;

    for (const g of gizmoPayments) {
      if (g.payType === 'bonus') {
        bonuses.push({
          time: g.time,
          customer: g.customer,
          amount: g.amount,
        });
        bonusesTotal += g.amount;
      }
    }

    bonuses.sort((a, b) => {
      const ta = a.time ? a.time.getTime() : 0;
      const tb = b.time ? b.time.getTime() : 0;
      return ta - tb;
    });

    console.log('\nGIZMO DEBUG: totals', {
      cash: round2(gizmoCash),
      noncash: round2(gizmoNonCash),
      total: round2(gizmoCash + gizmoNonCash),
      bonusesTotal: round2(bonusesTotal),
    });

    return {
      shift_id: shiftId,
      cash: gizmoCash,
      noncash: gizmoNonCash,
      total: gizmoCash + gizmoNonCash,
      bonuses,
      bonusesTotal,
    };
  } catch (e) {
    console.error('calcGizmoTotalsForShift error:', e);
    return null;
  }
}

// ===== отправка фото (как в evotorProductsReport.mjs) =====
async function sendPhoto({ chatId, filePath, caption }) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const buffer = await fs.promises.readFile(filePath);
  const blob = new Blob([buffer]);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');
  }
  form.append('photo', blob, 'gizmo_bonuses.png');

  const res = await fetch(url, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`TG sendPhoto: ${text}`);
  console.log('TG sendPhoto OK:', text);
  console.log('TG sendPhoto OK:', text);
}

// =============================================================

async function main() {
  try {
    console.log(`DEVICE_ID: ${DEVICE_ID}`);

    const session = await resolveSession();

    if (!session) {
      if (chatId) await send(chatId, '❗ Не удалось найти кассовую смену.');
      return;
    }

    const { session_id } = session;

    const times = await loadSessionTimes(session_id);
    const zReport = await loadZReport(session_id);

    if (!zReport) {
      if (chatId) await send(chatId, '❗ Не найден Z-отчёт Evotor для этой смены.');
      return;
    }

    const zTotal = Number(zReport.z_total ?? 0);
    const zCash = Number(zReport.z_cash ?? 0);
    const zElectron = Number(zReport.z_electron ?? 0);

    const refundTotal = Number(zReport.z_refund_total ?? 0);
    const refundCash = Number(zReport.z_refund_cash ?? 0);
    const refundElectron = Number(zReport.z_refund_electron ?? 0);

    if (GS_CASHUPDATE_ENABLED) {
      try {
        const opened = parseDateFlexible(times.opened_at);
        if (!opened) throw new Error('opened_at is null/invalid');

        const year = opened.getFullYear();
        const day = opened.getDate();
        const monthSheet = monthSheetRuByMonthIndex(opened.getMonth());
        if (!monthSheet) throw new Error('cannot map monthSheet');

        const shift = shiftFromOpenHour(opened.getHours());
        const diffCashForSheet = round2(zCash - refundCash);

        console.log(
          `GS cash update: open=${formatDateTime(opened)} monthSheet=${monthSheet} ` +
            `day=${day} shift=${shift} | cash=${round2(zCash)} refundCash=${round2(refundCash)} diff=${diffCashForSheet}`,
        );

        await runGsCashUpdate({
          monthSheet,
          year,
          day,
          shift,
          cashRevenue: diffCashForSheet,
        });

        console.log('GS cash update: OK');
      } catch (e) {
        console.error('GS cash update: FAIL:', e?.message || e);
      }
    }

    const bar = await loadBarStats(zReport.session_number, DEVICE_ID);

    let gizmoShift = null;
    let gizmoTotals = null;

    const baseTime = times.closed_at || times.opened_at;

    if (sessionNumberArg && baseTime) {
      gizmoShift = await loadGizmoShiftNearEvotorClose(baseTime);
      if (!gizmoShift) gizmoShift = await loadLastGizmoShift();
    } else {
      gizmoShift = await loadLastGizmoShift();
    }

    if (gizmoShift?.shift_id) {
      gizmoTotals = await calcGizmoTotalsForShift(gizmoShift.shift_id);
    }

    const gizmoCash = gizmoTotals?.cash ?? 0;
    const gizmoNon = gizmoTotals?.noncash ?? 0;
    const gizmoTotal = gizmoTotals?.total ?? 0;
    const gizmoBonuses = gizmoTotals?.bonuses ?? [];
    const gizmoBonusesTotal = gizmoTotals?.bonusesTotal ?? 0;

    const bonusTasks = gizmoShift?.shift_id ? await loadBonusTasksForShift(gizmoShift.shift_id) : [];

    const openTime = times.opened_at;
    const closeTime = times.closed_at;
    const openDate = formatDateTime(openTime);
    const closeDate = formatDateTime(closeTime);
    const shiftType = shiftTypeFromDate(closeTime);

    let text =
      `*${shiftType}* смена\n` +
      `открыта *${openDate}*\n` +
      `закрыта *${closeDate}*\n\n`;

    text += `*Эвотор* смена *№${zReport.session_number}*\n`;
    text += `Нал: ${money(zCash)} ₽\n`;
    text += `Безнал: ${money(zElectron)} ₽\n`;
    text += `Итого: *${money(zTotal)}* ₽\n\n`;

    text += `*Возвраты*\n`;
    text += `Нал: ${money(refundCash)} ₽\n`;
    text += `Безнал: ${money(refundElectron)} ₽\n`;
    text += `Итого: *${money(refundTotal)}* ₽\n\n`;

    text += `*Бар*\n`;
    text += `Нал: ${money(bar.cash)} ₽\n`;
    text += `Безнал: ${money(bar.electron)} ₽\n`;
    text += `Итого: ${money(bar.total)} ₽\n\n`;

    if (gizmoTotals && gizmoShift) {
      text += `*Гизмо* смена *№${gizmoShift.shift_id}*\n`;
      text += `Нал: ${money(gizmoCash)} ₽\n`;
      text += `Безнал: ${money(gizmoNon)} ₽\n`;
      text += `Итого: ${money(gizmoTotal)} ₽\n\n`;
    } else {
      text += `*Гизмо*\nДанных нет\n\n`;
    }

    const diffCash = zCash - refundCash - bar.cash - gizmoCash;
    const diffElectron = zElectron - refundElectron - bar.electron - gizmoNon;
    const diffTotal = zTotal - refundTotal - bar.total - gizmoTotal;

    text += `*Расхождения*\n`;
    text += `Нал: ${money(diffCash)} ₽\n`;
    text += `Безнал: ${money(diffElectron)} ₽\n`;
    text += `Итого: *${money(diffTotal)}* ₽`;

    if (chatId) await send(chatId, text, { parse_mode: 'Markdown' });

    if (chatId && gizmoBonuses.length) {
      try {
        const header = ['Время', 'Клиент', 'Бонус', 'Статус'];

        const body = gizmoBonuses.map(b => {
          const match = findBestBonusTaskMatch(b, bonusTasks);
          const statusLabel = match ? normalizeBonusStatusDbToLabel(match.status) : 'нет';

          return [
            formatTimeHM(b.time),
            b.customer || '—',
            `${money(b.amount)} ₽`,
            statusLabel,
          ];
        });

        body.push(['', 'ИТОГО', `${money(gizmoBonusesTotal)} ₽`, '']);

        const table = [header, ...body];

        const outPath = `/tmp/gizmo_bonuses_${zReport.session_number || 'sess'}.png`;

        renderTableToPngWrap(table, {
          outPath,
          colMinWidths: [80, 180, 80, 70],
          totalsRowIndex: table.length - 1,
        });

        await sendPhoto({
          chatId,
          filePath: outPath,
          caption: '*Бонусы Gizmo*',
        });

        try {
          await fs.promises.unlink(outPath);
        } catch (e) {
          console.log('unlink error (ok):', e.message);
        }
      } catch (e) {
        console.error('Ошибка формирования/отправки таблицы бонусов:', e);
      }
    }
  } catch (e) {
    console.error('evotorSessionReport error:', e);
    if (chatId) {
      try {
        await send(chatId, '❗ Ошибка при формировании отчёта.', { parse_mode: 'Markdown' });
      } catch {}
    }
  }
}

main();