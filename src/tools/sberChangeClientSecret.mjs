// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/sberChangeClientSecret.mjs
//
// Обновление client_secret для Sber API.
// Endpoint:
//   POST https://fintech.sberbank.ru:9443/ic/sso/api/v1/change-client-secret
//
// По умолчанию client_id НЕ отправляется.
// Это важно: по документации client_id необязательный,
// если не указан — меняется client_secret приложения,
// для которого выдан access_token.
//
// Берет из .env:
//   SBER_ACCESS_TOKEN
//   SBER_CLIENT_SECRET
//   SBER_NEW_CLIENT_SECRET
//
// После успешного ответа:
//   SBER_CLIENT_SECRET = SBER_NEW_CLIENT_SECRET
//   SBER_NEW_CLIENT_SECRET удаляется из .env
//
// mTLS:
//   SBER_CA_FILE или SBER_SERVER_CA_CERT_PATH
//   SBER_CLIENT_P12 или SBER_CLIENT_CERT_P12_PATH
//   SBER_CLIENT_P12_PASSPHRASE или SBER_CLIENT_CERT_P12_PASSWORD
//
// PEM тоже поддерживается:
//   SBER_CLIENT_CERT_PEM_PATH
//   SBER_CLIENT_KEY_PEM_PATH

console.log("SCRIPT_START", new Date().toISOString());

import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { Agent, setGlobalDispatcher } from "undici";

const DEFAULT_ENV = "/home/a/abokovsa/berserkclub.ru/MyBerserk/.env";
const DEFAULT_URL = "https://fintech.sberbank.ru:9443/ic/sso/api/v1/change-client-secret";
const DEFAULT_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const out = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (!a.startsWith("--")) continue;

    const key = a.slice(2);
    const val =
      argv[i + 1] && !argv[i + 1].startsWith("--")
        ? argv[++i]
        : true;

    out[key] = val;
  }

  return out;
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") {
      return v.trim();
    }
  }

  return undefined;
}

function isTrueValue(value) {
  if (value === true) return true;

  const s = String(value || "").trim().toLowerCase();

  return ["1", "true", "yes", "y", "on"].includes(s);
}

function mustEnv(name, envPathForMsg) {
  const v = process.env[name];

  if (!v || !String(v).trim()) {
    throw new Error(`Missing env ${name} in ${envPathForMsg}`);
  }

  return String(v).trim();
}

function safeMask(value) {
  if (!value || typeof value !== "string") return value;
  if (value.length <= 12) return "***";
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function readFileIfExists(filePath, label) {
  if (!filePath) return undefined;

  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }

  return fs.readFileSync(filePath);
}

function setupTlsOnce() {
  const caFile = firstString(
    process.env.SBER_CA_FILE,
    process.env.SBER_SERVER_CA_CERT_PATH
  );

  const p12File = firstString(
    process.env.SBER_CLIENT_P12,
    process.env.SBER_CLIENT_CERT_P12_PATH
  );

  const p12Pass = firstString(
    process.env.SBER_CLIENT_P12_PASSPHRASE,
    process.env.SBER_CLIENT_CERT_P12_PASSWORD
  );

  const certFile = firstString(process.env.SBER_CLIENT_CERT_PEM_PATH);
  const keyFile = firstString(process.env.SBER_CLIENT_KEY_PEM_PATH);

  const insecure = firstString(process.env.SBER_INSECURE_TLS);

  if (
    insecure &&
    String(insecure) !== "0" &&
    String(insecure).toLowerCase() !== "false"
  ) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.log("WARN: TLS verification disabled via SBER_INSECURE_TLS");
    return;
  }

  const connect = {};

  let combinedCa = tls.rootCertificates.join("\n");

  if (caFile) {
    if (!fs.existsSync(caFile)) {
      throw new Error(`CA file not found: ${caFile}`);
    }

    combinedCa += "\n" + fs.readFileSync(caFile, "utf8");
  }

  if (combinedCa.trim()) {
    connect.ca = combinedCa;
  }

  if (certFile && keyFile) {
    connect.cert = readFileIfExists(certFile, "client cert");
    connect.key = readFileIfExists(keyFile, "client key");

    console.log("TLS: configured:");
    if (caFile) console.log("  - extra CA file:", caFile);
    console.log("  - client cert:", certFile);
    console.log("  - client key:", keyFile);
  } else if (p12File) {
    connect.pfx = readFileIfExists(p12File, "client p12");

    if (p12Pass) {
      connect.passphrase = p12Pass;
    }

    console.log("TLS: configured:");
    if (caFile) console.log("  - extra CA file:", caFile);
    console.log("  - client p12:", p12File);
  } else {
    throw new Error(
      "mTLS не настроен. Укажи SBER_CLIENT_P12 или SBER_CLIENT_CERT_P12_PATH, либо SBER_CLIENT_CERT_PEM_PATH + SBER_CLIENT_KEY_PEM_PATH."
    );
  }

  setGlobalDispatcher(new Agent({ connect }));
}

async function postJson(url, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("Request timeout")), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
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

    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return {
      meta,
      json,
      raw: text,
    };
  } finally {
    clearTimeout(t);
  }
}

function escapeEnvDoubleQuotes(val) {
  return String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatEnvLine(key, value) {
  return `${key}="${escapeEnvDoubleQuotes(value)}"`;
}

async function updateEnvFileAtomic(envPath, updates, removeKeys = []) {
  const originalStat = await fs.promises.stat(envPath);
  const original = await fs.promises.readFile(envPath, "utf8");

  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);

  const updateKeys = Object.keys(updates);
  const seen = new Set();
  const removeSet = new Set(removeKeys);

  const newLines = [];

  for (const line of lines) {
    if (!line || /^\s*#/.test(line)) {
      newLines.push(line);
      continue;
    }

    const m = line.match(/^\s*(export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);

    if (!m) {
      newLines.push(line);
      continue;
    }

    const exportPrefix = m[1] || "";
    const key = m[2];

    if (removeSet.has(key)) {
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(updates, key)) {
      newLines.push(line);
      continue;
    }

    seen.add(key);
    newLines.push(`${exportPrefix}${formatEnvLine(key, updates[key])}`);
  }

  for (const k of updateKeys) {
    if (!seen.has(k)) {
      newLines.push(formatEnvLine(k, updates[k]));
    }
  }

  let next = newLines.join(eol);

  if (!next.endsWith(eol)) {
    next += eol;
  }

  await fs.promises.copyFile(envPath, `${envPath}.bak`);

  const dir = path.dirname(envPath);
  const tmp = path.join(
    dir,
    `.${path.basename(envPath)}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );

  await fs.promises.writeFile(tmp, next, { mode: originalStat.mode & 0o777 });
  await fs.promises.rename(tmp, envPath);

  return {
    path: envPath,
    keys: updateKeys,
    removed: removeKeys,
  };
}

function maskResponseJson(json) {
  if (!json || typeof json !== "object") return json;

  const out = Array.isArray(json) ? [...json] : { ...json };

  for (const key of Object.keys(out)) {
    const low = String(key).toLowerCase();

    if (low.includes("secret") || low.includes("token")) {
      out[key] = safeMask(String(out[key]));
    }
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const envPath = firstString(
    args.env,
    process.env.SBER_ENV_PATH,
    DEFAULT_ENV
  );

  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }

  dotenv.config({ path: envPath });

  setupTlsOnce();

  const url = firstString(
    args.url,
    process.env.SBER_CHANGE_CLIENT_SECRET_URL,
    DEFAULT_URL
  );

  const timeoutMs = Number(
    firstString(
      args.timeout_ms,
      process.env.SBER_TIMEOUT_MS,
      String(DEFAULT_TIMEOUT_MS)
    )
  );

  const accessToken = mustEnv("SBER_ACCESS_TOKEN", envPath);
  const clientSecret = mustEnv("SBER_CLIENT_SECRET", envPath);
  const newClientSecret = mustEnv("SBER_NEW_CLIENT_SECRET", envPath);

  const includeClientId = isTrueValue(
    firstString(
      args.with_client_id === true ? "1" : undefined,
      process.env.SBER_CHANGE_CLIENT_SECRET_WITH_CLIENT_ID
    )
  );

  const clientId = firstString(process.env.SBER_CLIENT_ID);

  if (!/^[a-zA-Z0-9]{38}$/.test(accessToken)) {
    console.log(
      `WARN: SBER_ACCESS_TOKEN не совпадает с regex ^[a-zA-Z0-9]{38}$, length=${accessToken.length}. Запрос все равно будет отправлен.`
    );
  }

  if (clientSecret.length < 8 || clientSecret.length > 256) {
    throw new Error("SBER_CLIENT_SECRET должен быть от 8 до 256 символов.");
  }

  if (newClientSecret.length < 8 || newClientSecret.length > 256) {
    throw new Error("SBER_NEW_CLIENT_SECRET должен быть от 8 до 256 символов.");
  }

  const payload = {
    access_token: accessToken,
    client_secret: clientSecret,
    new_client_secret: newClientSecret,
  };

  if (includeClientId) {
    if (!clientId) {
      throw new Error("Запрошена отправка client_id, но SBER_CLIENT_ID не задан.");
    }

    payload.client_id = clientId;
  }

  console.log("== Sber change client_secret ==");
  console.log("env_path:", envPath);
  console.log("url:", url);
  console.log("timeout_ms:", timeoutMs);
  console.log("client_id_sent:", includeClientId ? "yes" : "no");
  if (includeClientId) console.log("client_id:", clientId);
  console.log("access_token:", safeMask(accessToken));
  console.log("access_token_length:", accessToken.length);
  console.log("client_secret:", safeMask(clientSecret));
  console.log("client_secret_length:", clientSecret.length);
  console.log("new_client_secret:", safeMask(newClientSecret));
  console.log("new_client_secret_length:", newClientSecret.length);
  console.log("");

  const out = await postJson(url, payload, timeoutMs);

  console.log("== Response meta ==");
  console.log(JSON.stringify(out.meta, null, 2));

  if (out.json) {
    console.log("\n== JSON ==");
    console.log(JSON.stringify(maskResponseJson(out.json), null, 2));
  } else if (out.raw) {
    console.log("\n== Raw ==");
    console.log(out.raw);
  }

  if (!out.meta.ok) {
    console.log("");
    console.log("client_secret не изменен.");
    console.log("Если снова будет BAD REQUEST, значит Сбер не принимает текущий client_secret или access_token для этой операции.");
    process.exit(2);
  }

  await updateEnvFileAtomic(
    envPath,
    {
      SBER_CLIENT_SECRET: newClientSecret,
    },
    ["SBER_NEW_CLIENT_SECRET"]
  );

  console.log("");
  console.log(".env updated:");
  console.log(`SBER_CLIENT_SECRET=${safeMask(newClientSecret)}`);
  console.log("SBER_NEW_CLIENT_SECRET removed");
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);

  if (e?.cause) {
    console.error("CAUSE:", e.cause);
  }

  process.exit(2);
});