// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorMonthlySalesReport.mjs
//
// Отчёт по операциям Evotor за месяц (ИЗ evotor_sales)
// Данные:
// - close_date
// - sum
// - payments_type
//
// Правила:
// - возврат: payments_type = 'return'
// - наличные: payments_type = 'CASH'
// - безнал: payments_type = 'ELECTRON'
//
// Аргументы:
//   --month=1..12
//   --year=2025 (опционально, по умолчанию текущий год)
//
// Вывод: только в консоль

import '../env.js';
import { q } from '../db.js';

const TZ = process.env.TZ || 'Europe/Moscow';
process.env.TZ = TZ;

const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  if (!found) return def;
  return found.substring(pref.length);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function money(v) {
  const n = Number(v ?? 0);
  return (Math.round(n * 100) / 100).toFixed(2);
}

function monthRange(year, month1to12) {
  const m = Number(month1to12);
  const start = `${year}-${pad2(m)}-01 00:00:00`;

  let endY = year;
  let endM = m + 1;
  if (endM === 13) {
    endM = 1;
    endY = year + 1;
  }
  const end = `${endY}-${pad2(endM)}-01 00:00:00`;

  return { start, end };
}

async function main() {
  const monthRaw = getArg('month', null);
  if (!monthRaw) {
    console.error('❗ Нужен аргумент --month=1..12');
    process.exit(1);
  }

  const month = Number(monthRaw);
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    console.error('❗ Некорректный месяц. Нужно --month=1..12');
    process.exit(1);
  }

  const year = Number(getArg('year', String(new Date().getFullYear())));
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    console.error('❗ Некорректный год. Например: --year=2025');
    process.exit(1);
  }

  const { start, end } = monthRange(year, month);

  // Важно: возвраты считаем как ABS(sum), чтобы не зависеть от знака в базе
  const rows = await q(
    `
    SELECT
      COUNT(*) AS rows_total,

      SUM(CASE WHEN payments_type <> 'return' THEN \`sum\` ELSE 0 END) AS sales_total,
      SUM(CASE WHEN payments_type =  'return' THEN ABS(\`sum\`) ELSE 0 END) AS returns_total_abs,

      SUM(CASE WHEN payments_type = 'CASH'     THEN \`sum\` ELSE 0 END) AS cash_total,
      SUM(CASE WHEN payments_type = 'ELECTRON' THEN \`sum\` ELSE 0 END) AS noncash_total

    FROM evotor_sales
    WHERE close_date >= ?
      AND close_date <  ?
  `,
    [start, end],
  );

  const r = rows?.[0] || {};

  const rowsTotal = Number(r.rows_total ?? 0);
  const salesTotal = Number(r.sales_total ?? 0);
  const returnsTotal = Number(r.returns_total_abs ?? 0);
  const cashTotal = Number(r.cash_total ?? 0);
  const noncashTotal = Number(r.noncash_total ?? 0);

  const net = salesTotal - returnsTotal;

  console.log('EVOTOR — ОПЕРАЦИИ ЗА МЕСЯЦ (из evotor_sales)');
  console.log('='.repeat(80));
  console.log(`Период: ${year}-${pad2(month)} (TZ=${TZ})`);
  console.log(`Диапазон close_date: [${start} .. ${end})`);
  console.log(`Строк (evotor_sales): ${rowsTotal}`);
  console.log('-'.repeat(80));
  console.log(`Сумма всех операций:                 ${money(salesTotal)} ₽`);
  console.log(`Сумма возвратов (payments_type=return): ${money(returnsTotal)} ₽`);
  console.log(`Итого (операции - возвраты):         ${money(net)} ₽`);
  console.log('-'.repeat(80));
  console.log(`Сумма нала (CASH):                   ${money(cashTotal)} ₽`);
  console.log(`Сумма безнала (ELECTRON):            ${money(noncashTotal)} ₽`);
  console.log('='.repeat(80));
}

main().catch(e => {
  console.error('evotorMonthlySalesReport error:', e);
  process.exit(1);
});
