// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorMonthCashToGsTest.mjs
import '../env.js';
import { q } from '../db.js';
import { spawn } from 'node:child_process';

// ===================== НАСТРОЙКИ (КОНСТАНТЫ) =====================

// Год и месяц, за который считаем Z-отчёты
const YEAR = 2025;
// месяц 1..12
const MONTH = 12;

// Название листа месяца в Google Sheet
const MONTH_SHEET = 'Декабрь';

// Обновлять или только показывать что бы сделали
const DRY_RUN = false;

// Ограничение на кол-во обновлений (0 = без лимита)
const LIMIT = 0;

// Если true — не суммировать дубли (день+смена), а падать
const STRICT_NO_DUPES = false;

// =================================================================

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toLocalDateParts(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return {
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
    hour: dt.getHours(),
    date: dt,
  };
}

// ✅ ПРАВИЛО: определение по ОТКРЫТИЮ смены
// ДНЕВНАЯ: 04:00–15:59
// НОЧНАЯ: 16:00–03:59
function shiftFromHour(hour) {
  return (hour >= 4 && hour < 16) ? 'day' : 'night';
}

function fmt(dt) {
  if (!dt) return '--';
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return '--';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

// Загружаем Z-отчёты и времена открытия/закрытия смены
// ФИЛЬТР МЕСЯЦА/ДНЯ/СМЕНЫ — по OPEN_SESSION (opened_at)
async function loadMonthZCash({ year, month }) {
  const rows = await q(
    `
    SELECT
      zr.session_id,
      zr.session_number,
      zr.z_cash,
      zr.z_refund_cash,
      MIN(CASE WHEN s.evotor_type='OPEN_SESSION'  THEN s.close_date END) AS opened_at,
      MAX(CASE WHEN s.evotor_type='CLOSE_SESSION' THEN s.close_date END) AS closed_at
    FROM evotor_z_reports zr
    JOIN evotor_sessions s
      ON s.session_id = zr.session_id
    GROUP BY
      zr.session_id,
      zr.session_number,
      zr.z_cash,
      zr.z_refund_cash
    HAVING opened_at IS NOT NULL
       AND YEAR(opened_at) = ?
       AND MONTH(opened_at) = ?
    ORDER BY opened_at ASC
    `,
    [year, month],
  );

  return rows.map(r => ({
    session_id: r.session_id,
    session_number: r.session_number,
    cash: Number(r.z_cash ?? 0),
    refundCash: Number(r.z_refund_cash ?? 0),
    opened_at: r.opened_at,
    closed_at: r.closed_at,
  }));
}

function aggregateByDayShift(items) {
  // key = YYYY-MM-DD|day/night (по OPEN_SESSION времени)
  const map = new Map();

  for (const it of items) {
    const parts = toLocalDateParts(it.opened_at);
    if (!parts) continue;

    const shift = shiftFromHour(parts.hour);
    const key = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}|${shift}`;

    const cur = map.get(key);
    if (!cur) {
      map.set(key, {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        shift,
        cash: it.cash,
        refundCash: it.refundCash,
        diffCash: it.cash - it.refundCash,
        sessions: [{
          session_id: it.session_id,
          session_number: it.session_number,
          cash: it.cash,
          refundCash: it.refundCash,
          opened_at: it.opened_at,
          closed_at: it.closed_at,
        }],
      });
    } else {
      cur.cash += it.cash;
      cur.refundCash += it.refundCash;
      cur.diffCash += (it.cash - it.refundCash);
      cur.sessions.push({
        session_id: it.session_id,
        session_number: it.session_number,
        cash: it.cash,
        refundCash: it.refundCash,
        opened_at: it.opened_at,
        closed_at: it.closed_at,
      });
    }
  }

  // сортировка по дате + смене
  return [...map.values()].sort((a, b) => {
    const ta = new Date(a.year, a.month - 1, a.day, a.shift === 'day' ? 8 : 20, 0, 0).getTime();
    const tb = new Date(b.year, b.month - 1, b.day, b.shift === 'day' ? 8 : 20, 0, 0).getTime();
    return ta - tb;
  });
}

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

    const p = spawn('node', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.stderr.on('data', d => (err += d.toString()));

    p.on('close', code => {
      if (code === 0) return resolve(out.trim());
      reject(new Error(`gsCashUpdate failed (code=${code}): ${err || out}`));
    });
  });
}

async function main() {
  console.log(`EVOTOR → GS cash update test`);
  console.log(`YEAR=${YEAR}, MONTH=${MONTH} (${MONTH_SHEET}), DRY_RUN=${DRY_RUN}`);
  console.log(`Shift rule (by OPEN): day=04..15, night=16..03\n`);

  const zItems = await loadMonthZCash({ year: YEAR, month: MONTH });

  console.log(`Z-reports loaded: ${zItems.length}`);
  if (!zItems.length) {
    console.log('Нет Z-отчётов за этот период.');
    return;
  }

  const aggregated = aggregateByDayShift(zItems);

  // Проверка дублей (день+смена)
  for (const a of aggregated) {
    if (a.sessions.length > 1) {
      const msg =
        `DUPLICATE day+shift: ${pad2(a.day)}.${pad2(a.month)}.${a.year} ` +
        `shift=${a.shift} sessions=${a.sessions.length} (суммирую)`;

      if (STRICT_NO_DUPES) throw new Error(msg);

      console.warn('WARN:', msg);
      for (const s of a.sessions) {
        console.warn(
          `  - session №${s.session_number} cash=${round2(s.cash)} refundCash=${round2(s.refundCash)} ` +
          `open=${fmt(s.opened_at)} close=${fmt(s.closed_at)}`
        );
      }
    }
  }

  console.log(`Aggregated updates: ${aggregated.length}\n`);

  let done = 0;
  for (const a of aggregated) {
    if (LIMIT && done >= LIMIT) {
      console.log(`LIMIT reached: ${LIMIT}`);
      break;
    }

    const cash = round2(a.cash);
    const refundCash = round2(a.refundCash);
    const diffCash = round2(cash - refundCash); // ✅ в таблицу пишем cash - refundCash

    console.log(
      `-> ${pad2(a.day)}.${pad2(a.month)}.${a.year} shift=${a.shift} | ` +
      `cash=${cash} refundCash=${refundCash} diff=${diffCash}`
    );

    if (DRY_RUN) {
      done++;
      continue;
    }

    try {
      const res = await runGsCashUpdate({
        monthSheet: MONTH_SHEET,
        year: a.year,
        day: a.day,
        shift: a.shift,
        cashRevenue: diffCash,
      });
      console.log('   OK:', res);
      done++;
    } catch (e) {
      console.error('   FAIL:', e?.message || e);
      // продолжаем дальше
    }
  }

  console.log(`\nDone: ${done}/${aggregated.length} (DRY_RUN=${DRY_RUN})`);
}

main().catch(e => {
  console.error('evotorMonthCashToGsTest error:', e?.message || e);
  process.exitCode = 1;
});
