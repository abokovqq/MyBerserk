import '../env.js';
import { gizmoFetch } from '../gizmoClient.js';

function toGizmoTime(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000`;
}

const dateFrom = new Date("2025-12-05T00:00:00");
const dateTo   = new Date("2025-12-06T00:00:00");

const params = new URLSearchParams({
  SaleReportType: "0",
  DateFrom: toGizmoTime(dateFrom),
  DateTo: toGizmoTime(dateTo)
});

console.log("Запрос:", `/api/reports/sale?${params}`);

const data = await gizmoFetch(`/api/reports/sale?${params}`);
console.log(JSON.stringify(data, null, 2));
