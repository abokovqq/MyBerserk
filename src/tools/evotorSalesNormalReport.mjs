// src/tools/evotorSalesNormalReport.mjs
// Отчёт по продажам Evotor: NORMAL + "Своя еда" по смене (session_number)

import '../env.js';
import { q } from '../db.js';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function parseDateFlexible(dt) {
  if (!dt) return null;

  if (dt instanceof Date) return !Number.isNaN(dt.getTime()) ? dt : null;

  const raw = String(dt);

  let d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;

  d = new Date(raw.replace(" ", "T"));
  if (!Number.isNaN(d.getTime())) return d;

  return null;
}

function fmtTime(dt) {
  const d = parseDateFlexible(dt);
  if (!d) return "--:--:--";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------------------
// CLI аргументы
// ---------------------------------------------------------------------

const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find((a) => a.startsWith(pref));
  if (!found) return def;
  return found.substring(pref.length);
}

let sessionNumber = getArg("shift", null);
if (!sessionNumber) {
  const pos = argv.find((a) => !a.startsWith("--"));
  if (pos) sessionNumber = pos;
}

if (!sessionNumber) {
  console.log("Использование:\n  node evotorSalesNormalReport.mjs --shift=1401");
  process.exit(1);
}

console.log(`Загружаю NORMAL + "Своя еда" по Evotor смене № ${sessionNumber}\n`);

// ---------------------------------------------------------------------
// SQL выборка
// ---------------------------------------------------------------------

const rows = await q(
  `
SELECT
  id,
  close_date,
  result_sum,
  payments_type,
  product_type,
  product_name,
  discount_sum
FROM evotor_sales
WHERE session_number = ?
  AND (
       product_type = 'NORMAL'
       OR product_name = 'Своя еда'
  )
ORDER BY close_date ASC
`,
  [sessionNumber]
);

// ---------------------------------------------------------------------
// Итоги
// ---------------------------------------------------------------------

let totalCash = 0;
let totalNonCash = 0;

// ---------------------------------------------------------------------
// Вывод строк
// ---------------------------------------------------------------------

for (const r of rows) {
  const time = fmtTime(r.close_date);

  const sum = Number(r.result_sum || 0);
  const pay = (r.payments_type || "").padEnd(8);

  const type =
    r.product_name === "Своя еда" ? "Своя еда" : r.product_type;

  const name = (r.product_name || "").slice(0, 60);

  const discount = Number(r.discount_sum || 0);
  const discountText =
    discount > 0 ? `-${discount.toFixed(2).padStart(7)}` : "       ";

  // Итоги
  if (r.payments_type === "CASH") totalCash += sum;
  if (r.payments_type === "ELECTRON") totalNonCash += sum;

  console.log(
    `${time} | ${sum.toFixed(2).padStart(8)} | ${discountText} | ${pay} | ${type.padEnd(10)} | ${name}`
  );
}

// ---------------------------------------------------------------------
// Итог
// ---------------------------------------------------------------------

const total = totalCash + totalNonCash;

console.log("\n=======================================");
console.log(`НАЛ:      ${totalCash.toFixed(2)}`);
console.log(`БЕЗНАЛ:   ${totalNonCash.toFixed(2)}`);
console.log(`ИТОГО:    ${total.toFixed(2)}`);
console.log("=======================================\n");
