// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/workers/evotorOfdStores.mjs
import '../env.js';

const API_BASE = (process.env.API_URL || 'https://api.evotor.ru').replace(/\/+$/, '');
const TOKEN    = process.env.EVOTOR_ACCESS_TOKEN || process.env.EVOTOR_OFD_TOKEN || '';

if (!TOKEN) {
  console.error('evotorOfdStores: missing EVOTOR_ACCESS_TOKEN or EVOTOR_OFD_TOKEN in .env');
  process.exit(1);
}

async function main() {
  const url = `${API_BASE}/api/v1/ofd/stores`;

  console.log('GET', url);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Authorization': TOKEN,
      'Authorization': TOKEN, // попробуем оба варианта
      'Content-Type': 'application/json'
    }
  });

  console.log('status =', res.status);

  const text = await res.text().catch(() => '');
  console.log('body:');
  console.log(text);
}

main().catch(err => {
  console.error('evotorOfdStores error:', err);
  process.exit(1);
});
