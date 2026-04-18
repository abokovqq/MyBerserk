// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorLastSessions.mjs

import '../env.js';

const API_BASE = 'https://api.evotor.ru';

const STORE_ID  = process.env.STORE_ID;
const DEVICE_ID = process.env.DEVICE_ID;
const TOKEN     = process.env.EVOTOR_ACCESS_TOKEN;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Отсутствует переменная окружения ${name} в .env (${name})`);
    process.exit(1);
  }
}

requireEnv('STORE_ID', STORE_ID);
requireEnv('DEVICE_ID', DEVICE_ID);
requireEnv('EVOTOR_ACCESS_TOKEN', TOKEN);

async function fetchDocuments() {
  const url = `${API_BASE}/stores/${STORE_ID}/devices/${DEVICE_ID}/documents`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Authorization': TOKEN,
      'Accept': 'application/vnd.evotor.v2+json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ошибка запроса: ${res.status} ${res.statusText}\n${text}`);
  }

  const data = await res.json();

  // Формат: { items: [ ... ], paging: {} }
  if (Array.isArray(data.items)) return data.items;

  throw new Error('Неожиданный формат ответа от Эвотор (не нашли items)');
}

function findLastByType(docs, type) {
  const found = docs.filter(d => d.type === type);
  if (found.length === 0) return null;

  const getDate = d =>
    new Date(
      d.close_date ||
      d.created_at ||
      d.created ||
      d.moment ||
      d.date ||
      0
    ).getTime();

  found.sort((a, b) => getDate(b) - getDate(a));
  return found[0];
}

(async () => {
  try {
    const docs = await fetchDocuments();

    const lastOpen = findLastByType(docs, 'OPEN_SESSION');
    const lastClose = findLastByType(docs, 'CLOSE_SESSION');

    console.log('==============================');
    console.log('Последняя OPEN_SESSION:');
    console.dir(lastOpen, { depth: null });

    console.log('==============================');
    console.log('Последняя CLOSE_SESSION:');
    console.dir(lastClose, { depth: null });

  } catch (err) {
    console.error('Ошибка выполнения скрипта:', err.message);
  }
})();
