// src/tools/sberTokenCheckPay.mjs
// Получение access_token для сервиса PAY (BscanC) и сохранение в:
//   SBER_ACCESS_TOKEN_PAY
//   SBER_ACCESS_TOKEN_PAY_EXPIRES_AT
//
// По умолчанию:
//   token_url = https://mc.api.sberbank.ru:443/prod/tokens/v3/oauth
//   scope     = https://api.sberbank.ru/qr/order.pay
//
// TLS: undici Agent + setGlobalDispatcher (p12 + CA)
// ВАЖНО: для mc.api.sberbank.ru нужен truststore Минцифры russian-trusted-cacert.pem (можно передать через SBER_CA_FILE). :contentReference[oaicite:3]{index=3}

console.log("SCRIPT_START", new Date().toISOString());

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import tls from "node:tls";
import dotenv from "dotenv";
import { Agent, setGlobalDispatcher } from "undici";

const DEFAULT_ENV = "/home/a/abokovsa/berserkclub.ru/MyBerserk/.env";
const DEFAULT_ACCEPT = "application/json";

const DEFAULT_TOKEN_URL = "https://mc.api.sberbank.ru:443/prod/tokens/v3/oauth";
const DEFAULT_SCOPE = "https://api.sberbank.ru/qr/order.pay";

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
  for (const v of vals) if (typeof v === "string" && v.trim() !== "") return v.trim();
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

function rqUid32hex() {
  return crypto.randomBytes(16).toString("hex");
}

// ---- TLS ----
function loadBaseCa(modeRaw) {
  const mode = String(modeRaw || "system").toLowerCase();
  if (mode === "none") return "";

  if (mode === "system") {
    const candidates = [
      "/etc/ssl/certs/ca-certificates.crt",
      "/etc/pki/tls/certs/ca-bundle.crt",
      "/etc/ssl/ca-bundle.pem",
    ];
    for (const p of candidates) if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return tls.rootCertificates.join("\n");
}

function splitCaFiles(v) {
  if (!v) return [];
  return String(v)
    .split(/[:;,]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function setupTlsFromEnvOrArgs(args) {
  const caBaseMode = firstString(args.ca_base, process.env.SBER_CA_BASE, "system");
  const caFileRaw = firstString(args.ca_file, process.env.SBER_CA_FILE);

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

  const caFiles = splitCaFiles(caFileRaw);
  for (const caFile of caFiles) {
    if (!fs.existsSync(caFile)) throw new Error(`CA file not found: ${caFile}`);
    combinedCa += fs.readFileSync(caFile, "utf8") + "\n";
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
  if (caFiles.length) {
    console.log("  - extra CA files:");
    for (const f of caFiles) console.log("    *", f);
  }
  if (p12File) console.log("  - client p12:", p12File);

  return { mode: "custom" };
}

function buildClientAuth(client_id, client_secret) {
  // body | basic | mtls
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
    bodyAuth.client_id = client_id; // harmless
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

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { meta, raw: text, json };
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

    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;

    seen.add(key);
    return `${exportPrefix}${formatEnvLine(key, updates[key])}`;
  });

  for (const k of updateKeys) if (!seen.has(k)) newLines.push(formatEnvLine(k, updates[k]));

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

async function persistPayAccessToken(envPath, tokenJson) {
  if (!envBool("SBER_UPDATE_ENV", false)) return { skipped: true };

  const backup = envBool("SBER_ENV_BACKUP", true);
  const updates = {};

  if (tokenJson?.access_token) {
    updates.SBER_ACCESS_TOKEN_PAY = tokenJson.access_token;

    const expiresIn = Number(tokenJson.expires_in);
    if (!Number.isNaN(expiresIn) && expiresIn > 0) {
      updates.SBER_ACCESS_TOKEN_PAY_EXPIRES_AT = new Date(Date.now() + expiresIn * 1000).toISOString();
    }
  }

  if (Object.keys(updates).length === 0) return { skipped: true };

  const res = await updateEnvFileAtomic(envPath, updates, { backup });

  console.log(
    res.changed
      ? `\n.env updated (${envPath}): SBER_ACCESS_TOKEN_PAY=${safeMaskToken(updates.SBER_ACCESS_TOKEN_PAY)}${
          updates.SBER_ACCESS_TOKEN_PAY_EXPIRES_AT ? `, SBER_ACCESS_TOKEN_PAY_EXPIRES_AT=${updates.SBER_ACCESS_TOKEN_PAY_EXPIRES_AT}` : ""
        }`
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

  setupTlsFromEnvOrArgs(args);

  const client_id = mustGetEnv("SBER_CLIENT_ID", envPath);
  const client_secret = mustGetEnv("SBER_CLIENT_SECRET", envPath);

  const tokenUrl = firstString(args.token_url, process.env.SBER_TOKEN_URL_PAY, DEFAULT_TOKEN_URL);
  const accept = firstString(args.accept, process.env.SBER_ACCEPT, DEFAULT_ACCEPT);
  const scope = firstString(args.scope, process.env.SBER_TOKEN_SCOPE_PAY, DEFAULT_SCOPE);

  const ibmClientId = firstString(args.ibm_client_id, process.env.SBER_IBM_CLIENT_ID, process.env.SBER_CLIENT_ID);
  if (!ibmClientId) throw new Error(`Missing X-Ibm-Client-Id value. Set SBER_IBM_CLIENT_ID (or pass --ibm_client_id).`);

  const clientAuth = buildClientAuth(client_id, client_secret);

  const payload = {
    grant_type: "client_credentials",
    scope,
    ...clientAuth.bodyAuth,
  };

  const body = formUrlEncoded(payload);

  const rq = rqUid32hex();
  // По примерам Сбера: "RqUID" :contentReference[oaicite:4]{index=4}
  const rquidHeaderName = firstString(args.rquid_header, process.env.SBER_RQUID_HEADER_NAME, "RqUID");

  console.log("== Sber OAuth token (PAY / BscanC) ==");
  console.log("env_path:", envPath);
  console.log("token_url:", tokenUrl);
  console.log("accept:", accept);
  console.log("scope:", scope);
  console.log("client_auth:", clientAuth.mode);
  console.log("client_id:", client_id);
  console.log("X-Ibm-Client-Id:", ibmClientId);
  console.log(`${rquidHeaderName}:`, rq);
  console.log("");

  const out = await postForm(tokenUrl, body, accept, {
    ...clientAuth.headers,
    "X-Ibm-Client-Id": ibmClientId,
    [rquidHeaderName]: rq,
  });

  console.log("== Response meta ==");
  console.log(JSON.stringify(out.meta, null, 2));

  if (!out.json) {
    console.log("\n== Raw ==");
    console.log(out.raw);
    process.exit(out.meta.ok ? 0 : 2);
  }

  const j = { ...out.json };
  if (j.access_token) j.access_token = safeMaskToken(j.access_token);
  if (j.refresh_token) j.refresh_token = safeMaskToken(j.refresh_token);

  console.log("\n== JSON ==");
  console.log(JSON.stringify(j, null, 2));

  await persistPayAccessToken(envPath, out.json);
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  if (e?.cause) console.error("CAUSE:", e.cause);
  process.exit(2);
});