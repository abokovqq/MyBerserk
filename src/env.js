import fs from 'fs';

const ENV_FILE = '/home/a/abokovsa/berserkclub.ru/MyBerserk/.env';

function loadEnv(path) {
  if (!fs.existsSync(path)) return;
  const txt = fs.readFileSync(path, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();

    // убираем кавычки
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    // не перетираем, если уже есть в окружении
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnv(ENV_FILE);

// часовой пояс из .env
if (process.env.TZ) {
  process.env.TZ = process.env.TZ;
}
