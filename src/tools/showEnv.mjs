import { config } from 'https://cdn.skypack.dev/dotenv-es';
import fs from 'node:fs';

const ENV_PATH = '/home/a/abokovsa/berserkclub.ru/MyBerserk/.env';

if (fs.existsSync(ENV_PATH)) {
  config({ path: ENV_PATH });
  console.log('[showEnv] loaded', ENV_PATH);
} else {
  console.log('[showEnv] NOT FOUND', ENV_PATH);
}

const keys = Object.keys(process.env)
  .filter(k => k.startsWith('DB_') || k === 'TZ' || k.startsWith('TG_'))
  .sort();

for (const k of keys) {
  console.log(k + '=' + process.env[k]);
}
