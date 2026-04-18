// Вывод всех операций (позиций) по чеку Evotor
// usage: node evotorCheckDump.mjs --number=2003

import '../env.js';
import { q } from '../db.js';

const argv = process.argv.slice(2);

function getArg(name) {
  const pref = `--${name}=`;
  const found = argv.find(a => a.startsWith(pref));
  return found ? found.slice(pref.length) : null;
}

const evotorNumber = getArg('number');

if (!evotorNumber) {
  console.error('Укажи номер чека: --number=XXXX');
  process.exit(1);
}

(async () => {
  const rows = await q(
    `
    SELECT
      evotor_number,
      evotor_type,
      close_date,
      product_name,
      product_code,
      product_type,
      quantity,
      price,
      sum,
      payments_type
    FROM evotor_sales
    WHERE evotor_number = ?
    ORDER BY position_id
    `,
    [evotorNumber]
  );

  if (!rows.length) {
    console.log(`Чек ${evotorNumber} не найден`);
    return;
  }

  console.log(`\nЧЕК ${evotorNumber}`);
  console.log('='.repeat(80));

  for (const r of rows) {
    console.log(
      `${r.product_name} (${r.product_code}) | ` +
      `qty=${r.quantity} | price=${r.price} | sum=${r.sum} | ` +
      `pay=${r.payments_type}`
    );
  }

  const total = rows.reduce((s, r) => s + Number(r.sum || 0), 0);

  console.log('-'.repeat(80));
  console.log(`ИТОГО ПО ЧЕКУ: ${total}`);
})();
