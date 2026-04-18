#!/usr/bin/env node
import '../env.js';

/**
 * gsCashUpdate.mjs
 * Обновляет "Выручка налички" в карточке смены Google Sheet через Apps Script Web App.
 *
 * Аргументы (ОБЯЗАТЕЛЬНЫЕ):
 *  --monthSheet
 *  --year
 *  --day
 *  --shift      (day | night)
 *  --cashRevenue
 *
 * ENV:
 *  - GS_CASHUPDATE_URL
 *  - GS_CASHUPDATE_SECRET
 */

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;

    const [k, vEq] = a.split('=');
    const key = k.replace(/^--/, '');

    if (vEq !== undefined) {
      out[key] = vEq;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function requiredEnv(name) {
  const v = String(process.env[name] || '').trim();
  if (!v) throw new Error(`ENV ${name} is required`);
  return v;
}

function numRequired(label, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${label}: "${v}"`);
  }
  return n;
}

async function main() {
  const args = parseArgs(process.argv);

  const monthSheet = String(args.monthSheet || '').trim();
  const year        = numRequired('year', args.year);
  const day         = numRequired('day', args.day);
  const shift       = String(args.shift || '').trim().toLowerCase();
  const cashRevenue = numRequired('cashRevenue', args.cashRevenue);

  if (!monthSheet) {
    throw new Error('Arg --monthSheet is required');
  }

  if (day < 1 || day > 31) {
    throw new Error(`Invalid day: ${day}`);
  }

  if (shift !== 'day' && shift !== 'night') {
    throw new Error(`Invalid shift: ${shift} (expected day|night)`);
  }

  if (cashRevenue < 0) {
    throw new Error(`Invalid cashRevenue: ${cashRevenue}`);
  }

  const url    = requiredEnv('GS_CASHUPDATE_URL');
  const secret = requiredEnv('GS_CASHUPDATE_SECRET');

  const payload = {
    secret,
    monthSheet,
    year,
    day,
    shift,
    cashRevenue
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  if (!json || json.ok !== true) {
    throw new Error(`Bad response: ${text.slice(0, 400)}`);
  }

  console.log(JSON.stringify(json, null, 2));
}

main().catch((e) => {
  console.error('gsCashUpdate error:', e?.message || e);
  process.exitCode = 1;
});
