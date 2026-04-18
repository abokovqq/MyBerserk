// src/tools/sberTokenCheckQr.mjs
// Получение access_token для Плати QR (client_credentials) и сохранение в:
//   SBER_ACCESS_TOKEN_QR
//   SBER_ACCESS_TOKEN_QR_EXPIRES_AT
//
// Использует TLS (p12 + CA) так же, как твой sberTokenCheck.mjs (через undici Agent + setGlobalDispatcher)

console.log("SCRIPT_START", new Date().toISOString());

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import tls from "node:tls";
import dotenv from "dotenv";
import { Agent, setGlobalDispatcher } from "undici";

const DEFAULT_ENV = "/home/a/abokovsa/berserkclub.ru/MyBerserk/.env";
const DEFAULT_ACCEPT = "application/json";

// Token URL из доки Плати QR v3 (clientCredentials)
const DEFAULT_TOKEN_URL_QR = "https://dev.api.sberbank.ru/ru/prod/tokens/v2/oauth";
// Scope для создания заказа
const DEFAULT_SCOPE_QR = "https://api.sberbank.ru/qr/order.create";

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

function mustGetEnv(name, envPathForMsg = DEFAULT_ENV) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name} in ${envPathForMsg}`);
  return v;
}

function envBool(name, def = false) {
  const v = process.env[name];
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  return !(s === "" || s === "0" || s === "false" || s === "no" || s === "off");
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

function loadBaseCa(modeRaw) {
  const mode = String(modeRaw || "system").toLowerCase();
  if (mode === "none") return "";

  if (mode === "system") {
    const candidates = [
      "/etc/ssl/certs/ca-certificates.crt",
      "/etc/pki/tls/certs/ca-bundle.crt",
      "/etc/ssl/ca-bundle.pem",
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
  }

  return tls.rootCertificates.join("\n");
}

function setupTlsFromEnvOrArgs(args) {
  const caBaseMode = firstString(args.ca_base, process.env.SBER_CA_BASE, "system");
  const caFile = firstString(args.ca_file, process.env.SBER_CA_FILE);

  const p12File = firstString(args.client_p12, process.env.SBER_CLIENT_P12);
  const p12Pass = firstString(args.client_p12_pass, process.env.SBER_CLIENT_P12_PASSPHRASE);

  const connectTimeout = Number(firstString(args.connect_timeout_ms, process.env.SBER_CONNECT_TIMEOUT_MS, "30000"));

  const insecure = firstString(args.insecure_tls, process.env.SBER_INSECURE_TLS);
  if (insecure && String(insecure) !== "0" && String(insecure).toLowerCase() !== "false") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.log("WARN: TLS verification disabled via SBER_INSECURE_TLS / --insecure_tls");
    return { mode: "insecure" };
  }

  const connect = {};

  const baseCa = loadBaseCa(caBaseMode);
  let combinedCa = baseCa ? `${baseCa}\n` : "";
  if (caFile) {
    if (!fs.existsSync(caFile)) throw new Error(`CA file not found: ${caFile}`);
    combinedCa += fs.readFileSync(caFile, "utf8");
  }
  if (combinedCa.trim()) connect.ca = combinedCa;

  if (p12File) {
    if (!fs.existsSync(p12File)) throw new Error(`Client p12 not found: ${p12File}`);
    connect.pfx = fs.readFileSync(p12File);
    if (p12Pass) connect.passphrase = p12Pass;
  }

  setGlobalDispatcher(new Agent({ connect, connectTimeout }));

  console.log("TLS: configured via env/args:");
  console.log("  - ca_base:", caBaseMode);
  if (caFile) console.log("  - extra CA file:", caFile);
  if (p12File) console.log("  - client p12:", p12File);

  return { mode: "custom" };
}

function buildClientAuth(client_id, client_secret) {
  // body | basic | mtls (по аналогии с твоим скриптом)
  const mode = String(process.env.SBER_CLIENT_AUTH || "basic").toLowerCase();
  if (!["body", "basic", "mtls"].includes(mode)) {
    throw new Error(`Unknown SBER_CLIENT_AUTH=${mode}. Use body|basic|mtls`);
  }

  const headers = {};
  const bodyAuth = {};

  if (mode === "body") {
    bodyAuth.client_id = client_id;
    bodyAuth.client_secret = client_secret;
  } else if (mode === "basic") {
    const basic = Buffer.from(`${client_id}:${client_secret}`, "utf8").toString("base64");
    headers.Authorization = `Basic ${basic}`;
    // некоторые шлюзы допускают client_id в body — оставим "безвредно"
    bodyAuth.client_id = client_id;
  } else if (mode === "mtls") {
    bodyAuth.client_id = client_id;
  }

  return { mode, headers, bodyAuth };
}

async function postForm(url, body, accept = DEFAULT_ACCEPT, extraHeaders = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: accept,
      ...extraHeaders,
    },
    body,
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
}

// ----- .env update helpers -----

function escapeEnvDoubleQuotes(val) {
  return String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function formatEnvLine(key, value) {
  return `${key}="${escapeEnvDoubleQuotes(value)}"`;
}

async function updateEnvFileAtomic(envPath, updates, { backup = true } = {}) {
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

    if (!updates.hasOwnProperty(key)) return line;

    seen.add(key);
    return `${exportPrefix}${formatEnvLine(key, updates[key])}`;
  });

  for (const k of updateKeys) {
    if (!seen.has(k)) newLines.push(formatEnvLine(k, updates[k]));
  }

  let next = newLines.join(eol);
  if (!next.endsWith(eol)) next += eol;

  if (next === original) return { changed: false, path: envPath };

  if (backup) {
    const bak = `${envPath}.bak`;
    await fs.promises.copyFile(envPath, bak);
  }

  const dir = path.dirname(envPath);
  const tmp = path.join(dir, `.${path.basename(envPath)}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);

  await fs.promises.writeFile(tmp, next, { mode: originalStat.mode & 0o777 });
  await fs.promises.rename(tmp, envPath);

  return { changed: true, path: envPath };
}

async function persistQrAccessToken(envPath, tokenJson) {
  if (!envBool("SBER_UPDATE_ENV", false)) return { skipped: true };

  const backup = envBool("SBER_ENV_BACKUP", true);
  const storeAccess = envBool("SBER_STORE_ACCESS_TOKEN", true); // для QR обычно включаем по умолчанию

  const updates = {};

  if (storeAccess && tokenJson.access_token) {
    updates.SBER_ACCESS_TOKEN_QR = tokenJson.access_token;

    const expiresIn = Number(tokenJson.expires_in);
    if (!Number.isNaN(expiresIn) && expiresIn > 0) {
      updates.SBER_ACCESS_TOKEN_QR_EXPIRES_AT = new Date(Date.now() + expiresIn * 1000).toISOString();
    }
  }

  if (Object.keys(updates).length === 0) return { skipped: true };

  const res = await updateEnvFileAtomic(envPath, updates, { backup });

  console.log(
    res.changed
      ? `\n.env updated (${envPath}): SBER_ACCESS_TOKEN_QR=${safeMaskToken(updates.SBER_ACCESS_TOKEN_QR)}${updates.SBER_ACCESS_TOKEN_QR_EXPIRES_AT ? `, SBER_ACCESS_TOKEN_QR_EXPIRES_AT=${updates.SBER_ACCESS_TOKEN_QR_EXPIRES_AT}` : ""}`
      : `\n.env unchanged (${envPath})`
  );

  return { skipped: false, changed: res.changed, keys: Object.keys(updates) };
}

// ----- main -----

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const envPath = firstString(args.env, process.env.SBER_ENV_PATH, DEFAULT_ENV);
  if (!fs.existsSync(envPath)) throw new Error(`.env not found at ${envPath}`);
  dotenv.config({ path: envPath });

  // TLS before fetch
  setupTlsFromEnvOrArgs(args);

  const client_id = mustGetEnv("SBER_CLIENT_ID", envPath);
  const client_secret = mustGetEnv("SBER_CLIENT_SECRET", envPath);

  const tokenUrl = firstString(args.token_url, process.env.SBER_TOKEN_URL_QR, process.env.SBER_TOKEN_URL, DEFAULT_TOKEN_URL_QR);
  const accept = firstString(args.accept, process.env.SBER_ACCEPT, DEFAULT_ACCEPT);

  const scope = firstString(args.scope, process.env.SBER_TOKEN_SCOPE_QR, process.env.SBER_TOKEN_SCOPE, process.env.SBER_SCOPE, DEFAULT_SCOPE_QR);

  const clientAuth = buildClientAuth(client_id, client_secret);

  const payload = {
    grant_type: "client_credentials",
    scope, // можно несколько через пробел
    ...clientAuth.bodyAuth,
  };

  const body = formUrlEncoded(payload);

  console.log("== Sber OAuth token (Plati QR) ==");
  console.log("env_path:", envPath);
  console.log("token_url:", tokenUrl);
  console.log("accept:", accept);
  console.log("grant_type:", payload.grant_type);
  console.log("scope:", scope);
  console.log("client_auth:", clientAuth.mode);
  console.log("client_id:", client_id);
  console.log("");

  const out = await postForm(tokenUrl, body, accept, clientAuth.headers);

  console.log("== Response meta ==");
  console.log(JSON.stringify(out.meta, null, 2));

  if (!out.json) {
    console.log("\n== Raw ==");
    console.log(out.raw);
    process.exit(out.meta.ok ? 0 : 2);
  }

  // masked view
  const j = { ...out.json };
  if (j.access_token) j.access_token = safeMaskToken(j.access_token);
  if (j.refresh_token) j.refresh_token = safeMaskToken(j.refresh_token);

  console.log("\n== JSON ==");
  console.log(JSON.stringify(j, null, 2));

  // persist unmasked
  await persistQrAccessToken(envPath, out.json);

  if (out.json?.expires_in) {
    const seconds = Number(out.json.expires_in);
    if (!Number.isNaN(seconds)) {
      const mins = Math.round((seconds / 60) * 10) / 10;
      console.log(`\nexpires_in: ${seconds}s (~${mins} min)`);
    }
  }
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  if (e?.cause) console.error("CAUSE:", e.cause);
  process.exit(2);
});