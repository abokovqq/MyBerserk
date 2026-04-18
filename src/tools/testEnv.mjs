// Убедитесь, что у вас установлен dotenv пакет. Если нет, установите его с помощью команды:
// npm install dotenv

import dotenv from 'dotenv';


dotenv.config({ path: '/home/a/abokovsa/berserkclub.ru/MyBerserk/.env' });

console.log('[showEnv] loaded', process.env.PATH);

const keys = Object.keys(process.env)
  .filter(k => k.startsWith('DB_') || k === 'TZ' || k.startsWith('TG_'))
  .sort();

for (const k of keys) {
  console.log(k + '=' + process.env[k]);
}




import { env } from 'process';
console.log('DB_HOST:', env.DB_HOST);
console.log('TG_CHAT_MAIN:', env.TG_CHAT_MAIN);
