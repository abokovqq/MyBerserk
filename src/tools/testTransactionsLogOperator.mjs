// src/tools/testTransactionsLogOperator.mjs
import '../env.js';
import { gizmoFetch } from '../gizmoClient.js';

// Формат Gizmo date-time
function toGizmoTime(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000`;
}

// Сегодняшние границы
const dateFrom = new Date();
dateFrom.setHours(0, 0, 0, 0);

const dateTo = new Date();
dateTo.setHours(23, 59, 59, 999);

// Параметры запроса
const params = new URLSearchParams({
  OperatorName: "Администратор",
  DateFrom: toGizmoTime(dateFrom),
  DateTo: toGizmoTime(dateTo)
});

const url = `/api/reports/transactionslog?${params}`;

console.log("Запрос:", url);

try {
  const data = await gizmoFetch(url, { method: "GET", apiVersion: 1 });
  console.log("Ответ Gizmo:");
  console.log(JSON.stringify(data, null, 2));
} catch (err) {
  console.error("Ошибка запроса:", err);
}
