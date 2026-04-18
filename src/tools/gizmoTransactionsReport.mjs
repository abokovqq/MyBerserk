// src/tools/gizmoTransactionsShiftReport.mjs
// Отчёт транзакций Gizmo по смене, с фильтром по оператору (“Администратор” + "Admin")

import '../env.js';
import { q } from '../db.js';
import { gizmoFetch } from '../gizmoClient.js';

// ------------------------------------------------------------
// Формат времени Gizmo
function toGizmoTime(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000`;
}

// ------------------------------------------------------------
// CLI аргументы
const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const pref = `--${name}=`;
  for (const a of argv) {
    if (a.startsWith(pref)) return a.substring(pref.length);
  }
  return def;
}

const shiftId = getArg("shift", null);
if (!shiftId) {
  console.error("❗ Использование: node gizmoTransactionsShiftReport.mjs --shift=1417");
  process.exit(1);
}

// ------------------------------------------------------------
// Загружаем смену из shift_data
const shift = await q(`
  SELECT shift_id, start_time, end_time, operator_name
  FROM shift_data
  WHERE shift_id = ?
  LIMIT 1
`, [shiftId]);

if (!shift.length) {
  console.error(`❗ Смена shift_id=${shiftId} не найдена в shift_data.`);
  process.exit(1);
}

const s = shift[0];

if (!s.start_time || !s.end_time) {
  console.error(`❗ shift_id=${shiftId}: нет start_time или end_time`);
  process.exit(1);
}

const dtFrom = new Date(s.start_time);
const dtTo   = new Date(s.end_time);

// ------------------------------------------------------------
// Фильтр операторов
// Ищем ВСЕ транзакции операторов, важных для смены:
// - "Администратор"
// - "Admin"
// - а также фактический оператор смены s.operator_name (если есть)
const operators = new Set(["Администратор", "Admin"]);
if (s.operator_name) operators.add(s.operator_name.trim());

console.log(`Фильтры операторов: ${Array.from(operators).join(", ")}`);

// ------------------------------------------------------------
// Загружаем TRANSACTIONSLOG
const params = new URLSearchParams({
  DateFrom: toGizmoTime(dtFrom),
  DateTo:   toGizmoTime(dtTo)
});

// 👇 Заметь — мы НЕ указываем OperatorName здесь,
// потому что у тебя есть транзакции с operatorName="".
// Поэтому фильтруем ПОСЛЕ получения, иначе потеряем Auto Payment/Auto Invoice.

console.log(`Запрос Gizmo: /api/reports/transactionslog?${params}`);

let response;
try {
  response = await gizmoFetch(`/api/reports/transactionslog?${params}`, {
    method: "GET",
    apiVersion: 1
  });
} catch (err) {
  console.error("❗ Ошибка запроса transactionslog:", err);
  process.exit(1);
}

const log = response?.result?.transactions || [];

console.log(`Получено транзакций: ${log.length}`);

// ------------------------------------------------------------
// Фильтруем транзакции:
// Берём:
// - Payment
// - Auto Payment
// - Deposit
// - Invoice (опционально)
// И только от операторов: "Администратор", "Admin", operator_name смены, ""
// Пустой операторName тоже важен → Auto Invoice/Auto Payment
const useful = log.filter(t => {
  const op = (t.operatorName || "").trim();

  const okOp =
    op === "" ||
    operators.has(op);

  if (!okOp) return false;

  // типы операций
  return ["Payment", "Auto Payment", "Deposit", "Invoice"].includes(t.title);
});

// ------------------------------------------------------------
// Итоги
let totalCash = 0;
let totalNonCash = 0;
let totalDeposit = 0;

function classifyPayment(methodName) {
  if (!methodName) return "unknown";

  const m = methodName.toLowerCase();
  if (m.includes("cash")) return "cash";
  if (m.includes("card")) return "noncash";
  if (m.includes("online")) return "noncash";
  if (m.includes("deposit")) return "deposit";

  return "other";
}

const rows = useful.map(t => {
  const dt = t.transactionDate?.substring(11, 19) || "--:--";

  const sum =
    t.total != null
      ? Number(t.total)
      : t.value != null
      ? Number(t.value)
      : 0;

  const method = t.paymentMethodName || "";
  const kind = classifyPayment(method);

  if (t.title.includes("Deposit")) {
    totalDeposit += sum;
  } else {
    if (kind === "cash") totalCash += sum;
    else if (kind === "noncash") totalNonCash += sum;
  }

  return {
    time: dt,
    title: t.title,
    client: t.customerName || "",
    invoice: t.invoiceId || "",
    amount: sum,
    method: method || ""
  };
});

// ------------------------------------------------------------
// Вывод таблицы
console.log("\nОПЕРАЦИИ ЗА СМЕНУ", shiftId);
console.log("=".repeat(80));

for (const r of rows) {
  console.log(
    `${r.time} | ${r.title.padEnd(12)} | ${String(r.amount).padStart(8)} | ${r.method.padEnd(12)} | ${r.client} (inv=${r.invoice})`
  );
}

console.log("=".repeat(80));
console.log(`НАЛ:      ${totalCash}`);
console.log(`БЕЗНАЛ:   ${totalNonCash}`);
console.log(`ДЕПОЗИТ:  ${totalDeposit}`);
console.log(`ИТОГО:    ${totalCash + totalNonCash + totalDeposit}`);

console.log("\nГотово.\n");
