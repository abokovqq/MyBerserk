// src/tools/backfillShiftActualsFromGizmo.mjs
import '../env.js';
import { gizmoFetch } from '../gizmoClient.js';
import { q } from '../db.js';

const TZ = process.env.TZ || 'Europe/Moscow';

// ===== helpers =====
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

// CLI флаги: можно передать --all, чтобы обновить все смены
const argv = process.argv.slice(2);
function hasFlag(name) {
  return argv.includes(`--${name}`);
}

const UPDATE_ALL = hasFlag('all');

/**
 * Разбор фактических сумм по способам оплаты из details[]
 *
 * details: [
 *   { paymentMethodName: "Credit Card", actual: 1600, ... },
 *   { paymentMethodName: "Cash",        actual: 0,    ... },
 *   { paymentMethodName: "tinkoff",     actual: 0,    ... },
 *   { paymentMethodName: "Online",      actual: 0,    ... }
 * ]
 *
 * Логика:
 *  - method.toLowerCase() === 'cash' → cash
 *  - всё остальное → nonCash
 */
function extractPaymentActuals(details) {
  const res = {
    cash: 0,
    nonCash: 0,
    other: []
  };

  const list = Array.isArray(details) ? details : [];
  let seenAny = false;

  for (const d of list) {
    if (d.actual == null) continue;

    const method = String(d.paymentMethodName || '').toLowerCase();
    const val = Number(d.actual);
    seenAny = true;

    if (method === 'cash') {
      res.cash += val;
    } else {
      res.nonCash += val;
    }

    // просто для отладки / анализа, не используется в БД
    res.other.push({
      name: d.paymentMethodName,
      actual: val,
    });
  }

  // если вообще не было ни одного actual — считаем, что данных нет
  if (!seenAny) {
    res.cash = null;
    res.nonCash = null;
  }

  return res;
}

(async () => {
  console.log('🔧 backfillShiftActualsFromGizmo.mjs стартовал...');
  console.log(`   режим: ${UPDATE_ALL ? 'обновляем все смены' : 'только где actual/cash/noncash NULL'}`);

  // 1) выбираем диапазон дат по сменам, которые нужно обновить
  const whereCond = UPDATE_ALL
    ? '1=1'
    : '(actual IS NULL OR cash_actual IS NULL OR noncash_actual IS NULL)';

  const [range] = await q(
    `SELECT
       MIN(start_time) AS min_start,
       MAX(COALESCE(end_time, start_time)) AS max_end
     FROM shift_data
     WHERE ${whereCond}`
  );

  if (!range || (!range.min_start && !range.max_end)) {
    console.log('❌ Нет смен для обновления (по выбранному условию). Выходим.');
    process.exit(0);
  }

  const dateFrom = range.min_start ? new Date(range.min_start) : nowTZ();
  const dateTo   = range.max_end   ? new Date(range.max_end)   : nowTZ();

  console.log(
    `📅 Диапазон смен из MySQL: ${dateFrom.toISOString()} → ${dateTo.toISOString()}`
  );

  // 2) запрашиваем отчёт по сменам из Gizmo с детализацией
  const params = new URLSearchParams({
    ShiftsLogReportType: '2', // детальный отчёт, чтобы были details[]
    DateFrom: toGizmoTime(dateFrom),
    DateTo: toGizmoTime(dateTo),
  });

  console.log('🌐 Запрашиваем Gizmo /api/reports/shiftslog ...');

  let rep;
  try {
    rep = await gizmoFetch(`/api/reports/shiftslog?${params.toString()}`);
  } catch (e) {
    console.error('❌ Ошибка вызова gizmoFetch:', e);
    process.exit(1);
  }

  const root = rep?.result ? rep.result : rep;
  const shifts = Array.isArray(root?.shifts) ? root.shifts : [];

  console.log(`📋 Получено смен из Gizmo: ${shifts.length}`);

  if (!shifts.length) {
    console.log('❌ Gizmo не вернул ни одной смены для этого диапазона. Выходим.');
    process.exit(1);
  }

  // 3) карта shiftId → ShiftDTO
  const byId = new Map();
  for (const sh of shifts) {
    const sid = Number(sh.shiftId) || 0;
    if (!sid) continue;
    byId.set(sid, sh);
  }

  console.log(`🗺  Карта shiftId → ShiftDTO построена, записей: ${byId.size}`);

  // 4) список смен из MySQL для обновления
  const dbShifts = await q(
    `SELECT shift_id
       FROM shift_data
      WHERE ${whereCond}
   ORDER BY shift_id ASC`
  );

  console.log(`🧾 Смен для обновления в MySQL: ${dbShifts.length}`);

  let updated = 0;
  let skippedNoApi = 0;

  for (const row of dbShifts) {
    const shiftId = Number(row.shift_id);
    const sh = byId.get(shiftId);

    if (!sh) {
      console.log(`⚠️ shift_id=${shiftId}: не найден в отчёте Gizmo (пропуск)`);
      skippedNoApi++;
      continue;
    }

    // общая фактическая сумма по смене
    const actualTotal =
      sh.actual !== undefined && sh.actual !== null ? Number(sh.actual) : null;

    // разбивка по способам оплаты
    const paymentActuals = extractPaymentActuals(sh.details);
    const cashActual     = paymentActuals.cash;
    const nonCashActual  = paymentActuals.nonCash;

    // ВСЕГДА переписываем raw_json свежими данными + paymentActuals
    const rawJson = JSON.stringify({
      ...sh,
      paymentActuals,
    });

    const res = await q(
      `UPDATE shift_data
          SET actual         = ?,
              cash_actual    = ?,
              noncash_actual = ?,
              raw_json       = ?,
              updated_at     = NOW()
        WHERE shift_id = ?`,
      [actualTotal, cashActual, nonCashActual, rawJson, shiftId]
    );

    if (res.affectedRows) {
      updated++;
      console.log(
        `✅ shift_id=${shiftId}: actual=${actualTotal ?? 'NULL'}, cash=${cashActual ?? 'NULL'}, noncash=${nonCashActual ?? 'NULL'} (raw_json обновлён)`
      );
    } else {
      console.log(`⚠️ shift_id=${shiftId}: UPDATE не изменил строку`);
    }
  }

  console.log('🏁 Готово.');
  console.log(`   Обновлено строк: ${updated}`);
  console.log(`   Пропущено (нет в Gizmo): ${skippedNoApi}`);
  process.exit(0);
})();
