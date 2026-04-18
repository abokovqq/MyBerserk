export function renderGizmoReportHtml(data) {
  const rowsGizmo = data.gizmoPayments.map(g => `
    <tr>
      <td>${g.timeStr}</td>
      <td>${g.title}</td>
      <td class="right">${g.amount}</td>
      <td>${g.method}</td>
      <td>${g.customer}</td>
      <td>${g.payType === 'bonus' ? '•' : '✔'}</td>
    </tr>
  `).join('');

  return `
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Gizmo смена ${data.shiftId}</title>
<style>
  body { font-family: Arial; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; }
  th { background: #eee; }
  .right { text-align: right; }
</style>
</head>
<body>

<h1>Gizmo ↔ Evotor — смена ${data.shiftId}</h1>

<h2>GIZMO</h2>
<table>
<tr>
  <th>Время</th><th>Тип</th><th>Сумма</th><th>Метод</th><th>Клиент</th><th></th>
</tr>
${rowsGizmo}
</table>

<h3>Итого Gizmo</h3>
<p>Нал: ${data.gizmoTotals.cash}</p>
<p>Безнал: ${data.gizmoTotals.noncash}</p>
<p><b>Итого: ${data.gizmoTotals.total}</b></p>

</body>
</html>
`;
}
