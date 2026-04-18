// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/sberTokenCheck.mjs
console.log("SCRIPT_START", new Date().toISOString());

import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { Agent, setGlobalDispatcher } from "undici";

const DEFAULT_ENV = "/home/a/abokovsa/berserkclub.ru/MyBerserk/.env";
const DEFAULT_TOKEN_URL = "https://fintech.sberbank.ru:9443/ic/sso/api/v2/oauth/token";
const DEFAULT_ACCEPT = "application/json";
const DEFAULT_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    out[key] = val;
  }
  return out;
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

function mustGetEnv(name, envPathForMsg) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name} in ${envPathForMsg}`);
  return v;
}

function safeMaskToken(t) {
  if (!t || typeof t !== "string") return t;
  if (t.length <= 12) return "***";
  return `${t.slice(0, 6)}…${t.slice(-6)}`;
}

function formUrlEncoded(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  }
  return p.toString();
}

function setupTlsOnce() {
  const caFile = firstString(process.env.SBER_CA_FILE);
  const p12File = firstString(process.env.SBER_CLIENT_P12);
  const p12Pass = firstString(process.env.SBER_CLIENT_P12_PASSPHRASE);

  const insecure = firstString(process.env.SBER_INSECURE_TLS);
  if (insecure && String(insecure) !== "0" && String(insecure).toLowerCase() !== "false") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.log("WARN: TLS verification disabled via SBER_INSECURE_TLS");
    return;
  }

  const connect = {};

  // Базовые системные CA (Node)
  let combinedCa = tls.rootCertificates.join("\n");
  if (caFile) {
    if (!fs.existsSync(caFile)) throw new Error(`CA file not found: ${caFile}`);
    combinedCa += "\n" + fs.readFileSync(caFile, "utf8");
  }
  if (combinedCa.trim()) connect.ca = combinedCa;

  if (p12File) {
    if (!fs.existsSync(p12File)) throw new Error(`Client p12 not found: ${p12File}`);
    connect.pfx = fs.readFileSync(p12File);
    if (p12Pass) connect.passphrase = p12Pass;
  }

  if (Object.keys(connect).length) {
    setGlobalDispatcher(new Agent({ connect }));
    console.log("TLS: configured:");
    if (caFile) console.log("  - extra CA file:", caFile);
    if (p12File) console.log("  - client p12:", p12File);
  }
}

async function postForm(url, body, accept, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("Request timeout")), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": accept,
      },
      body,
      signal: ac.signal,
    });

    const text = await res.text();
    const meta = {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      contentType: res.headers.get("content-type"),
    };

    if (!res.ok) return { meta, raw: text };

    try {
      return { meta, json: JSON.parse(text) };
    } catch {
      return { meta, raw: text };
    }
  } finally {
    clearTimeout(t);
  }
}

// ----- .env update -----

function escapeEnvDoubleQuotes(val) {
  return String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatEnvLine(key, value) {
  return `${key}="${escapeEnvDoubleQuotes(value)}"`;
}

async function updateEnvFileAtomic(envPath, updates) {
  const originalStat = await fs.promises.stat(envPath);
  const original = await fs.promises.readFile(envPath, "utf8");

  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);

  const updateKeys = Object.keys(updates);
  const seen = new Set();

  const newLines = lines.map((line) => {
    if (!line || /^\s*#/.test(line)) return line;

    const m = line.match(/^\s*(export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) return line;

    const exportPrefix = m[1] || "";
    const key = m[2];

    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;

    seen.add(key);
    return `${exportPrefix}${formatEnvLine(key, updates[key])}`;
  });

  for (const k of updateKeys) {
    if (!seen.has(k)) newLines.push(formatEnvLine(k, updates[k]));
  }

  let next = newLines.join(eol);
  if (!next.endsWith(eol)) next += eol;

  // backup всегда
  await fs.promises.copyFile(envPath, `${envPath}.bak`);

  const dir = path.dirname(envPath);
  const tmp = path.join(
    dir,
    `.${path.basename(envPath)}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );

  await fs.promises.writeFile(tmp, next, { mode: originalStat.mode & 0o777 });
  await fs.promises.rename(tmp, envPath);

  return { path: envPath, keys: updateKeys };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const envPath = firstString(args.env, process.env.SBER_ENV_PATH, DEFAULT_ENV);
  if (!fs.existsSync(envPath)) throw new Error(`.env not found at ${envPath}`);
  dotenv.config({ path: envPath });

  setupTlsOnce();

  const tokenUrl = firstString(args.token_url, process.env.SBER_TOKEN_URL, DEFAULT_TOKEN_URL);
  const accept = firstString(args.accept, process.env.SBER_ACCEPT, DEFAULT_ACCEPT);
  const timeoutMs = Number(firstString(args.timeout_ms, process.env.SBER_TIMEOUT_MS, String(DEFAULT_TIMEOUT_MS)));

  const client_id = mustGetEnv("SBER_CLIENT_ID", envPath);
  const client_secret = mustGetEnv("SBER_CLIENT_SECRET", envPath);
  const refresh_token = mustGetEnv("SBER_REFRESH_TOKEN", envPath);

  const payload = {
    grant_type: "refresh_token",
    refresh_token,
    client_id,
    client_secret, // ВАЖНО: всегда в теле, чтобы не было Missing parameters: client_secret
  };

  console.log("== Sber OAuth refresh ==");
  console.log("env_path:", envPath);
  console.log("token_url:", tokenUrl);
  console.log("accept:", accept);
  console.log("timeout_ms:", timeoutMs);
  console.log("client_id:", client_id);
  console.log("refresh_token:", safeMaskToken(refresh_token));
  console.log("");

  const out = await postForm(tokenUrl, formUrlEncoded(payload), accept, timeoutMs);

  console.log("== Response meta ==");
  console.log(JSON.stringify(out.meta, null, 2));

  if (!out.json) {
    console.log("\n== Raw ==");
    console.log(out.raw);
    process.exit(out.meta?.ok ? 0 : 2);
  }

  const j = { ...out.json };
  const access_token = j.access_token;
  const new_refresh_token = j.refresh_token;

  if (j.access_token) j.access_token = safeMaskToken(j.access_token);
  if (j.refresh_token) j.refresh_token = safeMaskToken(j.refresh_token);
  if (j.id_token) j.id_token = safeMaskToken(j.id_token);

  console.log("\n== JSON ==");
  console.log(JSON.stringify(j, null, 2));

  const updates = {};
  if (access_token) updates.SBER_ACCESS_TOKEN = access_token;

  const expiresIn = Number(out.json.expires_in);
  if (!Number.isNaN(expiresIn) && expiresIn > 0) {
    updates.SBER_ACCESS_TOKEN_EXPIRES_AT = new Date(Date.now() + expiresIn * 1000).toISOString();
    const mins = Math.round((expiresIn / 60) * 10) / 10;
    console.log(`\nexpires_in: ${expiresIn}s (~${mins} min)`);
  }

  // Если сервер вернул новый refresh_token — сохраним
  if (new_refresh_token) updates.SBER_REFRESH_TOKEN = new_refresh_token;

  if (Object.keys(updates).length) {
    const res = await updateEnvFileAtomic(envPath, updates);
    const masked = Object.entries(updates).map(([k, v]) =>
      k.includes("TOKEN") ? `${k}=${safeMaskToken(v)}` : `${k}=${v}`
    );
    console.log(`\n.env updated (${res.path}): ${masked.join(", ")}`);
  } else {
    console.log("\nNothing to persist to .env (no tokens in response).");
  }
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  if (e?.cause) console.error("CAUSE:", e.cause);
  process.exit(2);
});