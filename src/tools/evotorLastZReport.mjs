// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/evotorLastZReport.mjs

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

async function fetchZReports() {
  const params = new URLSearchParams();
  params.set('type', 'Z_REPORT');

  const url =
    `${API_BASE}/stores/${STORE_ID}/devices/${DEVICE_ID}/documents?` +
    params.toString();

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

  // На всякий случай поддержим другие варианты, если что-то изменится
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.documents)) return data.documents;

  throw new Error('Неожиданный формат ответа от Эвотор (не нашли массив Z-отчетов)');
}

function findLastZReport(docs) {
  const zReports = docs.filter(d => d.type === 'Z_REPORT');
  if (zReports.length === 0) return null;

  const getDate = d => {
    const raw =
      d.close_date ||
      d.created_at ||
      d.created ||
      d.moment ||
      d.date ||
      null;

    const t = raw ? new Date(raw).getTime() : NaN;
    return Number.isNaN(t) ? 0 : t;
  };

  zReports.sort((a, b) => getDate(b) - getDate(a));
  return zReports[0];
}

(async () => {
  try {
    const docs = await fetchZReports();
    const lastZ = findLastZReport(docs);

    if (!lastZ) {
      console.log('Документы типа Z_REPORT не найдены.');
      return;
    }

    console.log('Последний Z_REPORT:');
    console.dir(lastZ, { depth: null });
  } catch (err) {
    console.error('Ошибка выполнения скрипта:', err.message);
  }
})();
