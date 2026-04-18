// src/tools/gizmoTransactionsShiftReport.mjs
// Отчёт по транзакциям Gizmo за смену + сверка с Evotor по операциям,
// с учётом возвратов; Void не учитываем.
// Оплата "Бонус" выводится, но не участвует в расхождениях и матчах с Evotor.
//
// Правки/особенности:
//  - НЕ выводим операции, у которых paymentMethodName содержит "deposit" (кроме бонусов)
//  - матчинг: окно ±15 минут
//  - групповой матчинг A: одна Evotor ↔ до 5 подряд Gizmo (2..5), сумма = Evotor
//  - групповой матчинг B: одна Gizmo ↔ до 5 подряд Evotor (2..5), сумма = Gizmo
//  - если запуск из TG (есть --chatId и чат разрешён): шлём HTML документом
//  - если запуск из консоли: только console
//  - если --shift не задан: берём текущую смену shift_data.is_active=1 (dtTo=NOW())
//
// Доп. правки из переписки:
//  - Диагностика выбора смен (Gizmo shift + Evotor open_session) + критерии
//  - Debug RAW JSON по клиенту: --debugCustomer=NAME (или --debug=NAME)
//  - Учитываем Withdraw как денежную операцию (возврат депозита без invoiceId)
//  - Схлопываем пары Deposit(+X) ↔ Withdraw(-X) по клиенту/методу/сумме/типу оплаты/времени (кроме бонусов)
//  - Evotor sales фильтруем по session_number + device_id (DEVICE_ID или --device=... )
//
// ✅ FIX 2026-01-25:
//  - Учитываем "Deposit Void" как денежную операцию (это отмена депозита).
//    Для логики схлопывания нормализуем "Deposit Void" -> Withdraw,
//    но в выводе оставляем оригинальный title "Deposit Void".
//
// ✅ FIX 2026-04-18:
//  - Для Evotor исключаем пары ПРОДАЖА/ВОЗВРАТ, если:
//      1) строка возврата определяется по evotor_type (PAYBACK/REFUND/RETURN),
//      2) у второй строки тот же position_uuid,
//      3) суммы одинаковые.
//    Тогда обе строки не учитываются и не выводятся в отчёте.

import '../env.js';

import { q } from '../db.js';
import { gizmoFetch } from '../gizmoClient.js';

import { createTextReport } from '../utils/report/textReport.mjs';
import { makeHtmlFromText } from '../utils/report/htmlReport.mjs';
import { sendTelegramFile } from '../utils/report/telegramSend.mjs';
import { safeUnlink, safeWriteFile } from '../utils/report/fsSafe.mjs';
import { isAllowedChat, getChatIdFromArgs } from '../utils/report/chatGate.mjs';

// ======================= UTILS =========================

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

function getArg(name, def = null) {
  const argv = process.argv.slice(2);
  const pref = `--${name}=`;
  const f = argv.find(a => a.startsWith(pref));
  return f ? f.substring(pref.length) : def;
}

function parseGizmoDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 🔧 Парсер Evotor: умеет Date, "YYYY-MM-DD HH:MM:SS" и ISO
function parseEvotorDate(val) {
  if (!val) return null;

  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val;
  }

  const raw = String(val);
  let d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;

  d = new Date(raw.replace(' ', 'T'));
  if (!Number.isNaN(d.getTime())) return d;

  return null;
}

function fmtTime(d) {
  if (!d || Number.isNaN(d.getTime())) return '--:--:--';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDateTime(d) {
  if (!d || Number.isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

function classifyGizmoMethod(methodName) {
  if (!methodName) return 'other';
  const m = methodName.toLowerCase();

  // спец-тип "бонус" — отдельная категория, не участвует в расхождениях
  if (m.includes('бонус')) return 'bonus';

  if (m.includes('cash')) return 'cash';
  if (m.includes('card')) return 'noncash';
  if (m.includes('online')) return 'noncash';
  if (m.includes('tinkoff')) return 'noncash';
  if (m.includes('deposit')) return 'noncash';

  return 'other';
}

function classifyEvotorPaymentType(payType) {
  if (!payType) return 'other';
  const t = String(payType).toUpperCase();
  if (t === 'CASH') return 'cash';
  if (t === 'ELECTRON') return 'noncash';
  return 'other';
}

function nearlyEqual(a, b, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}

function isEvotorReturnType(evotorType) {
  const t = String(evotorType || '').toUpperCase().trim();
  return (
    t === 'PAYBACK' ||
    t.includes('PAYBACK') ||
    t.includes('REFUND') ||
    t.includes('RETURN')
  );
}

function moneyAbsKey(value) {
  return Math.round(Math.abs(Number(value || 0)) * 100).toString();
}

// ======================= OUTPUT SETUP =========================

const { out, getText } = createTextReport();

// TG: отправляем только если запуск из TG (передан chatId) и чат разрешён
const chatId = getChatIdFromArgs(null);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// ✅ Evotor device filter
const DEVICE_ID = getArg('device', process.env.DEVICE_ID || '');
if (!DEVICE_ID) {
  out('❗ Нет DEVICE_ID в .env (или --device=...) — нужен для фильтрации evotor_sales по девайсу.');
  process.exit(1);
}

async function maybeSendToTelegram({ title, text, baseName }) {
  if (!chatId) return; // запуск из консоли
  if (!isAllowedChat(chatId)) return; // не тот чат
  if (!BOT_TOKEN) return;

  const safeBase = String(baseName || 'report').replace(/[^\w.-]+/g, '_');
  const tmpHtml = `/tmp/${safeBase}.html`;

  try {
    const html = makeHtmlFromText(text, title);
    await safeWriteFile(tmpHtml, html, 'utf8');

    await sendTelegramFile({
      botToken: BOT_TOKEN,
      chatId,
      filePath: tmpHtml,
      caption: `${title} (HTML)`,
    });
  } finally {
    await safeUnlink(tmpHtml);
  }
}

// ======================= DB HELPERS =========================

async function loadShiftById(shiftId) {
  const rows = await q(
    `
      SELECT shift_id, is_active, start_time, end_time, operator_name
      FROM shift_data
      WHERE shift_id = ?
      LIMIT 1
    `,
    [shiftId],
  );
  return rows[0] || null;
}

async function loadActiveShift() {
  const rows = await q(`
    SELECT shift_id, is_active, start_time, end_time, operator_name
    FROM shift_data
    WHERE is_active = 1
    ORDER BY start_time DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

async function loadLastOpenEvotorSession() {
  const rows = await q(`
    SELECT session_number, session_id, created_at
    FROM evotor_sessions
    WHERE evotor_type='OPEN_SESSION'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

// ✅ ищем OPEN_SESSION около начала смены Gizmo (dtFrom)
async function loadEvotorSessionByOpenNear(dtFrom, hoursWindow = 8) {
  const rows = await q(
    `
      SELECT session_number, session_id, created_at
      FROM evotor_sessions
      WHERE evotor_type='OPEN_SESSION'
        AND created_at BETWEEN ? - INTERVAL ? HOUR AND ? + INTERVAL ? HOUR
      ORDER BY ABS(TIMESTAMPDIFF(SECOND, created_at, ?)) ASC
      LIMIT 1
    `,
    [dtFrom, hoursWindow, dtFrom, hoursWindow, dtFrom],
  );
  return rows[0] || null;
}

// ======================= MAIN =========================

const shiftIdArg = getArg('shift', null);

let isCurrentMode = false;
let shiftIdForTitle = null;
let operatorsShift = null;
let dtFrom = null;
let dtTo = null;

if (shiftIdArg) {
  // РЕЖИМ "КОНКРЕТНАЯ СМЕНА"
  const s = await loadShiftById(shiftIdArg);
  if (!s) {
    out(`❗ Смена shift_id=${shiftIdArg} не найдена в shift_data.`);
    process.exit(1);
  }
  if (!s.start_time || !s.end_time) {
    out(`❗ shift_id=${s.shift_id}: нет start_time или end_time`);
    process.exit(1);
  }

  isCurrentMode = false;
  shiftIdForTitle = String(s.shift_id);
  operatorsShift = s;

  dtFrom = new Date(s.start_time);
  dtTo = new Date(s.end_time);
} else {
  // РЕЖИМ "ТЕКУЩАЯ СМЕНА" (is_active=1)
  const s = await loadActiveShift();
  if (!s) {
    out('❗ Не найдена активная смена в shift_data (is_active=1).');
    process.exit(1);
  }
  if (!s.start_time) {
    out(`❗ shift_id=${s.shift_id}: отсутствует start_time (нельзя построить период).`);
    process.exit(1);
  }

  isCurrentMode = true;
  shiftIdForTitle = String(s.shift_id);
  operatorsShift = s;

  dtFrom = new Date(s.start_time);
  dtTo = new Date(); // текущее время
}

// ----- 2. Запрашиваем Gizmo /api/reports/transactionslog -----

const operators = new Set(['Администратор', 'Admin']);
if (operatorsShift?.operator_name) operators.add(String(operatorsShift.operator_name).trim());

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
  out('❗ Ошибка запроса к Gizmo: ' + (e?.message || String(e)));
  process.exit(1);
}

const gizmoTransactions = Array.isArray(gizmoResp?.result?.transactions)
  ? gizmoResp.result.transactions
  : [];

out(`Получено транзакций Gizmo: ${gizmoTransactions.length}`);

// ===== DEBUG: сырой JSON по клиенту из Gizmo transactionslog =====
// Использование: --debugCustomer=Kostya228 или --debug=Kostya228
const DEBUG_CUSTOMER = (getArg('debugCustomer', '') || getArg('debug', '') || '').trim();

if (DEBUG_CUSTOMER) {
  const needle = DEBUG_CUSTOMER.toLowerCase();

  const raws = gizmoTransactions.filter(t => {
    const cn = String(t.customerName ?? t.CustomerName ?? '').toLowerCase().trim();
    return cn.includes(needle);
  });

  out('');
  out(`DEBUG Gizmo RAW: needle="${DEBUG_CUSTOMER}" | found=${raws.length}`);
  out('================================================================================');

  if (!raws.length) {
    const names = [
      ...new Set(
        gizmoTransactions
          .map(t => String(t.customerName ?? t.CustomerName ?? '').trim())
          .filter(Boolean),
      ),
    ];

    const hints = names
      .filter(n => n.toLowerCase().includes(needle.slice(0, Math.max(2, needle.length))))
      .slice(0, 50);

    out(`Не найдено ни одной транзакции по needle="${DEBUG_CUSTOMER}".`);
    out(`Примеры customerName в этом отчёте (первые 50 совпадений/похожих):`);
    for (const n of hints) out(`- ${n}`);

    out('================================================================================');
    out('');
  } else {
    for (const t of raws) {
      const dt = parseGizmoDate(t.transactionDate);
      out(
        `${fmtDateTime(dt)} | title=${t.title} | total=${t.total ?? t.value ?? ''} | method=${t.paymentMethodName ?? ''} | operator=${t.operatorName ?? ''} | invoiceId=${t.invoiceId ?? ''}`,
      );
      out(JSON.stringify(t, null, 2));
      out('--------------------------------------------------------------------------------');
    }
    out('================================================================================');
    out('');
  }
}

// ----- 3. Фильтруем денежные операции GIZMO -----

let gizmoPayments = [];

for (const t of gizmoTransactions) {
  const rawTitle = t.title || '';
  const titleDisplay = rawTitle.trim();
  const tl = titleDisplay.toLowerCase();
  const op = (t.operatorName || '').trim();
  const method = t.paymentMethodName || '';
  const ml = method.toLowerCase();

  // ❌ убираем операции, у которых paymentMethodName содержит "deposit" (кроме бонусов)
  if (ml.includes('deposit') && !ml.includes('бонус')) continue;

  // оператор: Admin / Администратор / фактический оператор / пустой
  const okOp = op === '' || operators.has(op);
  if (!okOp) continue;

  // игнорируем явно служебные авто-операции
  if (tl.startsWith('auto invoice') || tl.startsWith('auto payment')) continue;

  // Void / Аннулирование не учитываем (но "Deposit Void" — это ДЕНЕЖНАЯ отмена депозита, её считаем)
  if (tl === 'void') continue;

  let isMoney = false;

  // ✅ Deposit/Payment/Withdraw — денежные
  if (tl === 'payment' || tl === 'deposit' || tl === 'withdraw') isMoney = true;

  // ✅ Deposit Void — денежная отмена депозита
  if (tl === 'deposit void') isMoney = true;

  if (
    tl.includes('refund') ||
    tl.includes('return') ||
    tl.includes('withdraw') ||
    tl.includes('возврат')
  ) {
    isMoney = true;
  }

  // любые операции с методом "Бонус" считаем денежными
  if (ml.includes('бонус')) isMoney = true;

  if (!isMoney) continue;

  const dt = parseGizmoDate(t.transactionDate);

  let amount = 0;
  if (t.total != null) amount = Number(t.total);
  else if (t.value != null) amount = Number(t.value);

  let payType = classifyGizmoMethod(method);

  // Нормализуем title для логики схлопывания:
  // Deposit Void -> Withdraw (но в выводе оставляем "Deposit Void")
  let titleNorm = titleDisplay;
  if (tl === 'deposit void') titleNorm = 'Withdraw';

  // Deposit/Withdraw: деньги приходят/уходят через реальный способ оплаты
  if (titleNorm === 'Deposit' || titleNorm === 'Withdraw') {
    if (ml.includes('cash')) payType = 'cash';
    else if (ml.includes('card')) payType = 'noncash';
  }

  gizmoPayments.push({
    kind: 'gizmo',
    id: t.invoiceId || null,
    time: dt,
    timeStr: fmtTime(dt),
    amount,
    payType,
    method,
    title: titleNorm,          // для логики (Deposit/Withdraw)
    titleDisplay,              // для вывода (Deposit/Deposit Void/Withdraw)
    customer: t.customerName || '',
  });
}

// --- 3.1. Взаимное уничтожение Payment/Refund по одному invoiceId ---
const totalsByInvoice = new Map();

for (const g of gizmoPayments) {
  if (!g.id) continue;
  const cur = totalsByInvoice.get(g.id) || 0;
  totalsByInvoice.set(g.id, cur + g.amount);
}

const cancelledInvoices = new Set(
  [...totalsByInvoice.entries()].filter(([, sum]) => nearlyEqual(sum, 0)).map(([id]) => id),
);

if (cancelledInvoices.size > 0) {
  out(
    'Инвойсы, у которых Payment+Refund взаимно уничтожились: ' +
      [...cancelledInvoices].join(', '),
  );
}

gizmoPayments = gizmoPayments.filter(g => !(g.id && cancelledInvoices.has(g.id)));

// --- 3.2. Парное уничтожение бонусов по пользователю и сумме ---
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
  out('Бонусные операции, взаимно уничтоженные по пользователю и сумме: ' + bonusToRemove.size);
}

gizmoPayments = gizmoPayments.filter((_, idx) => !bonusToRemove.has(idx));

// --- 3.3. Парное уничтожение Deposit(+X) ↔ Withdraw(-X) (НЕ бонус) без invoiceId ---
const DEP_WD_WINDOW_MS = 30 * 60 * 1000;

const depWdByKey = new Map();
gizmoPayments.forEach((g, idx) => {
  if (g.payType === 'bonus') return;
  const tl = String(g.title || '').toLowerCase();
  if (tl !== 'deposit' && tl !== 'withdraw') return;

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
    x => x.g.amount > 0 && String(x.g.title).toLowerCase() === 'deposit',
  );
  const negatives = ops.filter(
    x => x.g.amount < 0 && String(x.g.title).toLowerCase() === 'withdraw',
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
  out('Deposit/Withdraw, взаимно уничтоженные по пользователю/методу/сумме: ' + depWdToRemove.size);
}

gizmoPayments = gizmoPayments.filter((_, idx) => !depWdToRemove.has(idx));

gizmoPayments.sort((a, b) => a.time - b.time);

out(
  `Отфильтровано денежных операций Gizmo (с учётом возвратов, депозиты не учитываютяся, бонусы для информации): ${gizmoPayments.length}`,
);

// ----- 4. Смена Evotor (тут логика выбора смены) -----

let evotorSessionNumber = null;
let evotorSessionId = null;

let evotorOpenCreatedAt = null; // created_at выбранной OPEN_SESSION
let evotorPickReason = ''; // критерии выбора текстом

// 1) Ищем OPEN_SESSION, ближайшую к dtFrom
const openNear = await loadEvotorSessionByOpenNear(dtFrom, 8);

if (openNear) {
  evotorSessionNumber = openNear.session_number;
  evotorSessionId = openNear.session_id;
  evotorOpenCreatedAt = parseEvotorDate(openNear.created_at);

  const diffSec =
    evotorOpenCreatedAt && dtFrom
      ? Math.round(Math.abs(evotorOpenCreatedAt - dtFrom) / 1000)
      : null;

  evotorPickReason =
    `Критерии выбора Evotor:\n` +
    `1) Ищем OPEN_SESSION, ближайшую по времени к началу смены Gizmo (dtFrom).\n` +
    `2) Берём запись с минимальным |created_at - dtFrom| в окне ±8 часов.\n` +
    `3) Это надёжнее, чем "последняя OPEN_SESSION", потому что смены могут перекрываться/быть дневные и ночные.\n` +
    (diffSec != null ? `4) Фактическая разница времени: ${diffSec} сек.\n` : '');

  out(
    `Найдена смена Evotor (по OPEN_SESSION около начала Gizmo): session_number=${evotorSessionNumber}`,
  );
} else {
  // fallback: для текущего режима — последняя OPEN_SESSION
  if (isCurrentMode) {
    const open = await loadLastOpenEvotorSession();
    if (open) {
      evotorSessionNumber = open.session_number;
      evotorSessionId = open.session_id;
      evotorOpenCreatedAt = parseEvotorDate(open.created_at);

      evotorPickReason =
        `Критерии выбора Evotor (fallback):\n` +
        `1) Не нашли OPEN_SESSION около начала смены Gizmo (dtFrom) в окне ±8 часов.\n` +
        `2) Поэтому взяли последнюю OPEN_SESSION по created_at DESC.\n` +
        `3) Внимание: этот режим менее надёжен, если в таблице есть "чужие" смены.\n`;

      out(
        `Найдена смена Evotor (fallback last OPEN_SESSION): session_number=${evotorSessionNumber}`,
      );
    } else {
      out('⚠ Не найдена OPEN_SESSION Evotor (evotor_sessions).');
    }
  } else {
    // Для режима --shift: ближайшая CLOSE_SESSION к dtTo
    const evotorSessionRows = await q(
      `
        SELECT session_number, session_id, close_date
        FROM evotor_sessions
        WHERE evotor_type = 'CLOSE_SESSION'
          AND close_date BETWEEN ? - INTERVAL 40 MINUTE AND ? + INTERVAL 40 MINUTE
        ORDER BY ABS(TIMESTAMPDIFF(SECOND, close_date, ?)) ASC
        LIMIT 1
      `,
      [dtTo, dtTo, dtTo],
    );

    if (evotorSessionRows.length) {
      evotorSessionNumber = evotorSessionRows[0].session_number;
      evotorSessionId = evotorSessionRows[0].session_id;

      const closeDt = parseEvotorDate(evotorSessionRows[0].close_date);
      const diffSec = closeDt && dtTo ? Math.round(Math.abs(closeDt - dtTo) / 1000) : null;

      evotorPickReason =
        `Критерии выбора Evotor (по CLOSE_SESSION):\n` +
        `1) Режим заданной смены (--shift): ориентируемся на конец смены Gizmo (dtTo).\n` +
        `2) Берём CLOSE_SESSION с минимальным |close_date - dtTo| в окне ±40 минут.\n` +
        (diffSec != null ? `3) Фактическая разница времени: ${diffSec} сек.\n` : '');

      out(
        `Найдена смена Evotor (по CLOSE_SESSION около конца Gizmo): session_number=${evotorSessionNumber}`,
      );
    } else {
      out('⚠ Не найдена подходящая смена Evotor для этой смены Gizmo.');
    }
  }
}

// Диагностика выбранных смен
out('');
out('ВЫБОР СМЕН ДЛЯ СВЕРКИ');
out('================================================================================');
out(`GIZMO: shift_id=${shiftIdForTitle} | open=${fmtDateTime(dtFrom)} | end=${fmtDateTime(dtTo)}`);
out(
  `EVOTOR: session_number=${evotorSessionNumber ?? '??'} | open=${
    evotorOpenCreatedAt ? fmtDateTime(evotorOpenCreatedAt) : '—'
  }`,
);
out('--------------------------------------------------------------------------------');
if (evotorPickReason) out(evotorPickReason.trim());
out('================================================================================');
out('');

// ----- 5. Загружаем платежи Evotor по SERVICE (кроме "Своя еда") -----

const evotorPayments = [];

if (evotorSessionNumber != null) {
  const evRowsRaw = await q(
    `
      SELECT
        id,
        close_date,
        result_sum,
        payments_type,
        session_number,
        position_uuid,
        evotor_type
      FROM evotor_sales
      WHERE session_number = ?
        AND device_id = ?
        AND product_type = 'SERVICE'
        AND product_name <> 'Своя еда'
    `,
    [evotorSessionNumber, DEVICE_ID],
  );

  // --- 5.1. Исключаем пары продажа/возврат Evotor по position_uuid + одинаковой сумме ---
  const saleBuckets = new Map();

  evRowsRaw.forEach((r, idx) => {
    if (isEvotorReturnType(r.evotor_type)) return;

    const positionUuid = String(r.position_uuid || '').trim();
    if (!positionUuid) return;

    const key = `${positionUuid}|${moneyAbsKey(r.result_sum)}`;

    let arr = saleBuckets.get(key);
    if (!arr) {
      arr = [];
      saleBuckets.set(key, arr);
    }
    arr.push(idx);
  });

  const evotorDropIdx = new Set();
  let evotorCanceledPairs = 0;

  for (let idx = 0; idx < evRowsRaw.length; idx++) {
    const r = evRowsRaw[idx];
    if (!isEvotorReturnType(r.evotor_type)) continue;

    const positionUuid = String(r.position_uuid || '').trim();
    if (!positionUuid) continue;

    const key = `${positionUuid}|${moneyAbsKey(r.result_sum)}`;
    const bucket = saleBuckets.get(key);
    if (!bucket || !bucket.length) continue;

    let saleIdx = -1;

    while (bucket.length) {
      const candidateIdx = bucket.shift();
      if (candidateIdx == null) continue;
      if (evotorDropIdx.has(candidateIdx)) continue;
      saleIdx = candidateIdx;
      break;
    }

    if (saleIdx < 0) continue;

    evotorDropIdx.add(idx);
    evotorDropIdx.add(saleIdx);
    evotorCanceledPairs++;
  }

  const evRows = evRowsRaw.filter((_, idx) => !evotorDropIdx.has(idx));

  out(`Evotor filter: session_number=${evotorSessionNumber}, device_id=${DEVICE_ID}`);
  out(`Всего операций Evotor категории "SERVICE" (без учета "Своя еда"): ${evRowsRaw.length}`);
  if (evotorCanceledPairs > 0) {
    out(
      `Исключено пар продажа/возврат Evotor по position_uuid + сумме: ${evotorCanceledPairs}`,
    );
  }
  out(`Осталось операций Evotor для сверки: ${evRows.length}`);

  for (const r of evRows) {
    const dt = parseEvotorDate(r.close_date);
    const amount = Number(r.result_sum || 0);
    const payType = classifyEvotorPaymentType(r.payments_type);

    evotorPayments.push({
      kind: 'evotor',
      id: r.id,
      time: dt,
      timeStr: fmtTime(dt),
      amount,
      payType,
      payments_type: r.payments_type,
      session_number: r.session_number,
      position_uuid: r.position_uuid || null,
      evotor_type: r.evotor_type || null,
    });
  }

  evotorPayments.sort((a, b) => a.time - b.time);
}

// ----- 6. Матчинг транзакций GIZMO ↔ EVOTOR -----

const MATCH_WINDOW_MINUTES = 15;
const MATCH_WINDOW_MS = MATCH_WINDOW_MINUTES * 60 * 1000;

const MAX_SPLIT = 5;

const evotorUsed = new Array(evotorPayments.length).fill(false);
const gizmoUsed = new Array(gizmoPayments.length).fill(false);

// структура: { gizmos: [...], evotors: [...] }
const matches = [];

function findBestEvotorMatch(g, evList, used) {
  let bestIdx = -1;
  let bestDt = Infinity;

  for (let i = 0; i < evList.length; i++) {
    if (used[i]) continue;
    const e = evList[i];

    if (g.payType !== e.payType) continue;
    if (!nearlyEqual(g.amount, e.amount)) continue;

    const diff = Math.abs(e.time - g.time);
    if (diff <= MATCH_WINDOW_MS && diff < bestDt) {
      bestDt = diff;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// 6.1 1:1
for (let gi = 0; gi < gizmoPayments.length; gi++) {
  const g = gizmoPayments[gi];
  if (g.payType !== 'cash' && g.payType !== 'noncash') continue;

  const idx = findBestEvotorMatch(g, evotorPayments, evotorUsed);
  if (idx >= 0) {
    evotorUsed[idx] = true;
    gizmoUsed[gi] = true;
    matches.push({ gizmos: [g], evotors: [evotorPayments[idx]] });
  }
}

// 6.2 group A: одна Evotor ↔ до 5 подряд Gizmo (2..MAX_SPLIT)
const remainingEvotorIdx = [];
for (let ei = 0; ei < evotorPayments.length; ei++) {
  if (!evotorUsed[ei]) remainingEvotorIdx.push(ei);
}

for (const ei of remainingEvotorIdx) {
  if (evotorUsed[ei]) continue;

  const e = evotorPayments[ei];

  const cand = [];
  for (let gi = 0; gi < gizmoPayments.length; gi++) {
    if (gizmoUsed[gi]) continue;
    const g = gizmoPayments[gi];

    if (g.payType !== 'cash' && g.payType !== 'noncash') continue;
    if (g.payType !== e.payType) continue;
    if (Math.sign(g.amount || 0) !== Math.sign(e.amount || 0)) continue;

    const diff = Math.abs(g.time - e.time);
    if (diff > MATCH_WINDOW_MS) continue;

    cand.push(gi);
  }

  if (cand.length < 2) continue;

  cand.sort((a, b) => gizmoPayments[a].time - gizmoPayments[b].time);

  let matchedGroup = null;

  for (let si = 0; si < cand.length; si++) {
    if (gizmoUsed[cand[si]]) continue;

    for (let len = 2; len <= MAX_SPLIT; len++) {
      const end = si + (len - 1);
      if (end >= cand.length) break;

      let ok = true;
      let sum = 0;
      const groupIdx = [];

      for (let j = si; j <= end; j++) {
        const gi = cand[j];
        if (gizmoUsed[gi]) {
          ok = false;
          break;
        }
        const g = gizmoPayments[gi];
        if (g.payType !== 'cash' && g.payType !== 'noncash') {
          ok = false;
          break;
        }

        sum += g.amount;
        groupIdx.push(gi);
      }

      if (!ok) continue;

      if (nearlyEqual(sum, e.amount)) {
        matchedGroup = groupIdx;
        break;
      }
    }

    if (matchedGroup) break;
  }

  if (matchedGroup && matchedGroup.length) {
    evotorUsed[ei] = true;
    for (const gi of matchedGroup) gizmoUsed[gi] = true;

    matches.push({
      gizmos: matchedGroup.map(gi => gizmoPayments[gi]),
      evotors: [e],
    });
  }
}

// 6.3 group B: одна Gizmo ↔ до 5 подряд Evotor (2..MAX_SPLIT)
const remainingGizmoIdx = [];
for (let gi = 0; gi < gizmoPayments.length; gi++) {
  if (gizmoUsed[gi]) continue;
  const g = gizmoPayments[gi];
  if (g.payType !== 'cash' && g.payType !== 'noncash') continue;
  remainingGizmoIdx.push(gi);
}

for (const gi0 of remainingGizmoIdx) {
  if (gizmoUsed[gi0]) continue;

  const g = gizmoPayments[gi0];

  const candE = [];
  for (let ei = 0; ei < evotorPayments.length; ei++) {
    if (evotorUsed[ei]) continue;
    const e = evotorPayments[ei];

    if (e.payType !== 'cash' && e.payType !== 'noncash') continue;
    if (e.payType !== g.payType) continue;
    if (Math.sign(e.amount || 0) !== Math.sign(g.amount || 0)) continue;

    const diff = Math.abs(e.time - g.time);
    if (diff > MATCH_WINDOW_MS) continue;

    candE.push(ei);
  }

  if (candE.length < 2) continue;

  candE.sort((a, b) => evotorPayments[a].time - b.time);

  let matchedEGroup = null;

  for (let si = 0; si < candE.length; si++) {
    if (evotorUsed[candE[si]]) continue;

    for (let len = 2; len <= MAX_SPLIT; len++) {
      const end = si + (len - 1);
      if (end >= candE.length) break;

      let ok = true;
      let sum = 0;
      const groupIdx = [];

      for (let j = si; j <= end; j++) {
        const ei = candE[j];
        if (evotorUsed[ei]) {
          ok = false;
          break;
        }

        const e = evotorPayments[ei];
        if (e.payType !== 'cash' && e.payType !== 'noncash') {
          ok = false;
          break;
        }

        sum += e.amount;
        groupIdx.push(ei);
      }

      if (!ok) continue;

      if (nearlyEqual(sum, g.amount)) {
        matchedEGroup = groupIdx;
        break;
      }
    }

    if (matchedEGroup) break;
  }

  if (matchedEGroup && matchedEGroup.length) {
    gizmoUsed[gi0] = true;
    for (const ei of matchedEGroup) evotorUsed[ei] = true;

    matches.push({
      gizmos: [g],
      evotors: matchedEGroup.map(ei => evotorPayments[ei]),
    });
  }
}

// 6.4 without pairs
const gizmoOnly = [];
for (let gi = 0; gi < gizmoPayments.length; gi++) {
  const g = gizmoPayments[gi];
  if (g.payType !== 'cash' && g.payType !== 'noncash') continue;
  if (!gizmoUsed[gi]) gizmoOnly.push(g);
}

const evotorOnly = [];
for (let ei = 0; ei < evotorPayments.length; ei++) {
  if (!evotorUsed[ei]) evotorOnly.push(evotorPayments[ei]);
}

// ----- 7. Итоги -----

let gizmoCash = 0;
let gizmoNonCash = 0;

for (const g of gizmoPayments) {
  if (g.payType === 'cash') gizmoCash += g.amount;
  else if (g.payType === 'noncash') gizmoNonCash += g.amount;
}

let evotorCash = 0;
let evotorNonCash = 0;

for (const e of evotorPayments) {
  if (e.payType === 'cash') evotorCash += e.amount;
  else if (e.payType === 'noncash') evotorNonCash += e.amount;
}

// ======================= OUTPUT =========================

out('');
if (isCurrentMode) out(`ОПЕРАЦИИ GIZMO ЗА ТЕКУЩУЮ СМЕНУ ${shiftIdForTitle}`);
else out(`ОПЕРАЦИИ GIZMO ЗА СМЕНУ ${shiftIdForTitle}`);
out('='.repeat(80));

for (const g of gizmoPayments) {
  const isStandard = g.payType === 'cash' || g.payType === 'noncash';
  const paired = matches.some(m => m.gizmos.includes(g));
  const mark = !isStandard ? '•' : paired ? '✔' : '✖';

  const titleOut = (g.titleDisplay || g.title || '').padEnd(12);

  out(
    `${g.timeStr} | ${titleOut} | ${String(g.amount).padStart(8)} | ${String(
      g.method || '',
    ).padEnd(12)} | ${g.customer} (inv=${g.id || ''})  ${mark}`,
  );
}

out('='.repeat(80));
out(`GIZMO НАЛ: ${gizmoCash.toFixed(2)}`);
out(`GIZMO БЕЗНАЛ: ${gizmoNonCash.toFixed(2)}`);
out(`GIZMO ИТОГО: ${(gizmoCash + gizmoNonCash).toFixed(2)}`);
out('');

out(
  `EVOTOR SERVICE (кроме "Своя еда") — смена № ${evotorSessionNumber ?? '??'}${
    evotorSessionId ? ` (session_id=${evotorSessionId})` : ''
  }`,
);
out('='.repeat(80));

for (const e of evotorPayments) {
  const paired = matches.some(m => (m.evotors || []).includes(e));
  const mark = paired ? '✔' : '✖';

  out(
    `${e.timeStr} | ${String(e.amount).padStart(8)} | ${String(e.payments_type).padEnd(
      8,
    )} | sale_id=${e.id}  ${mark}`,
  );
}

out('='.repeat(80));
out(`EVOTOR НАЛ: ${evotorCash.toFixed(2)}`);
out(`EVOTOR БЕЗНАЛ: ${evotorNonCash.toFixed(2)}`);
out(`EVOTOR ИТОГО: ${(evotorCash + evotorNonCash).toFixed(2)}`);

// ----- Несовпадения -----

out('\nНЕСОВПАДЕНИЯ: ТОЛЬКО GIZMO (нет пары в Evotor)');
if (!gizmoOnly.length) out('— нет —');
else {
  for (const g of gizmoOnly) {
    const titleOut = (g.titleDisplay || g.title || '').padEnd(12);
    out(
      `${g.timeStr} | ${titleOut} | ${String(g.amount).padStart(8)} | ${String(
        g.method || '',
      ).padEnd(12)} | ${g.customer} (inv=${g.id || ''})`,
    );
  }
}

out('\nНЕСОВПАДЕНИЯ: ТОЛЬКО EVOTOR (нет пары в GIZMO)');
if (!evotorOnly.length) out('— нет —');
else {
  for (const e of evotorOnly) {
    out(
      `${e.timeStr} | ${String(e.amount).padStart(8)} | ${String(e.payments_type).padEnd(
        8,
      )} | sale_id=${e.id}`,
    );
  }
}

// ----- Итоговые расхождения -----

out('\nРАСХОЖДЕНИЯ ПО СУММАМ (EVOTOR - GIZMO):');
out(`НАЛ: ${(evotorCash - gizmoCash).toFixed(2)}`);
out(`БЕЗНАЛ: ${(evotorNonCash - gizmoNonCash).toFixed(2)}`);
out(`ИТОГО: ${(evotorCash + evotorNonCash - (gizmoCash + gizmoNonCash)).toFixed(2)}`);

out('\nГотово.\n');

// ======================= TG SEND (HTML) =========================

try {
  const text = getText();
  const title = isCurrentMode
    ? `Проверка текущей смены Gizmo ${shiftIdForTitle}`
    : `Проверка смены Gizmo ${shiftIdForTitle}`;
  const baseName = isCurrentMode
    ? `gizmo_current_${shiftIdForTitle}`
    : `gizmo_check_${shiftIdForTitle}`;

  await maybeSendToTelegram({ title, text, baseName });
} catch (e) {
  console.error('TG send error:', e?.message || String(e));
}