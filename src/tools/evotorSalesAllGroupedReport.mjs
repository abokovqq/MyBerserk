// src/tools/evotorSalesAllGroupedReport.mjs
// Вывод всех позиций Evotor по смене: сначала CASH, затем ELECTRON — без фильтров.

import '../env.js';
import { q } from '../db.js';

// --------------------------------------------
// Helpers
// --------------------------------------------
function parseDateFlexible(dt) {
  if (!dt) return null;
  if (dt instanceof Date && !Number.isNaN(dt.getTime())) return dt;

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
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// --------------------------------------------
// CLI args
// --------------------------------------------
const argv = process.argv.slice(2);
function getArg(name, def = null) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  return found ? found.substring(pref.length) : def;
}

let sessionNumber = getArg("shift", null);
if (!sessionNumber) {
  const pos = argv.find(a => !a.startsWith("--"));
  if (pos) sessionNumber = pos;
}

if (!sessionNumber) {
  console.log(`Использование:\n  node evotorSalesAllGroupedReport.mjs --shift=1401`);
  process.exit(1);
}

console.log(`Загружаю ВСЕ позиции по Evotor смене № ${sessionNumber}\n`);

// --------------------------------------------
// SQL: все строки по session_number
// --------------------------------------------
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
ORDER BY
  CASE
    WHEN payments_type = 'CASH'     THEN 0
    WHEN payments_type = 'ELECTRON' THEN 1
    ELSE 2
  END,
  close_date ASC
`,
  [sessionNumber]
);

// --------------------------------------------
// Итоги
// --------------------------------------------
let totalCash = 0;
let totalNonCash = 0;

let currentType = null;

// --------------------------------------------
// Вывод
// --------------------------------------------

for (const r of rows) {
  const payType = r.payments_type || "";

  // заголовки секций
  if (payType !== currentType) {
    currentType = payType;
    console.log("");

    if (currentType === "CASH") {
      console.log("------------- CASH -------------");
    } else if (currentType === "ELECTRON") {
      console.log("----------- ELECTRON -----------");
    } else {
      console.log(`----------- ${currentType || "OTHER"} -----------`);
    }
  }

  const time = fmtTime(r.close_date);

  const sum = Number(r.result_sum || 0);
  const sumText = sum.toFixed(2).padStart(8);

  const discount = Number(r.discount_sum || 0);
  const discText = (discount > 0 ? `-${discount.toFixed(2)}` : "").padStart(8);

  const pay = (r.payments_type || "").padEnd(8);

  const type = (r.product_type || "").padEnd(10);
  const name = (r.product_name || "").slice(0, 60);

  // подсчёт итогов
  if (payType === "CASH") totalCash += sum;
  if (payType === "ELECTRON") totalNonCash += sum;

  console.log(
    `${time} | ${sumText} | ${discText} | ${pay} | ${type} | ${name}`
  );
}

// --------------------------------------------
// Итоговый блок
// --------------------------------------------
const total = totalCash + totalNonCash;

console.log("\n=======================================");
console.log(`НАЛ:      ${totalCash.toFixed(2)}`);
console.log(`БЕЗНАЛ:   ${totalNonCash.toFixed(2)}`);
console.log(`ИТОГО:    ${total.toFixed(2)}`);
console.log("=======================================\n");
