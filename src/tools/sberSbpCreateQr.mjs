// src/tools/sberSbpCreateQr.mjs
console.log("SCRIPT_START", new Date().toISOString());

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import tls from "node:tls";

import dotenv from "dotenv";
import QRCode from "qrcode";
import { Agent, setGlobalDispatcher } from "undici";

const DEFAULT_ENV = "/home/a/abokovsa/berserkclub.ru/MyBerserk/.env";
const DEFAULT_ACCEPT = "application/json";

// В доке путь метода: qr/order/v3/creation :contentReference[oaicite:5]{index=5}
const CREATE_PATHES = [
  "/qr/order/v3/creation",
  "/qr/order/v3/creation/",
];

// Частые префиксы шлюзов
const PREFIXES = ["", "/prod", "/ru/prod"];

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

function safeMaskToken(t) {
  if (!t || typeof t !== "string") return t;
  if (t.length <= 12) return "***";
  return `${t.slice(0, 6)}…${t.slice(-6)}`;
}

function rqUid32Hex() {
  return crypto.randomBytes(16).toString("hex");
}

function isoZNoMillis(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function rubToKopecks(amountStr) {
  const s = String(amountStr).replace(",", ".").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Bad --amount: ${amountStr}`);
  const [i, f = ""] = s.split(".");
  const frac = (f + "00").slice(0, 2);
  return Number(i) * 100 + Number(frac);
}

// ---- TLS (как в твоём sberTokenCheck) ----
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

function setupTlsFromEnvOrArgs(args) {
  const caBaseMode = firstString(args.ca_base, process.env.SBER_CA_BASE, "system");
  const caFile = firstString(args.ca_file, process.env.SBER_CA_FILE);

  const p12File = firstString(args.client_p12, process.env.SBER_CLIENT_P12);
  const p12Pass = firstString(args.client_p12_pass, process.env.SBER_CLIENT_P12_PASSPHRASE);

  const connectTimeout = Number(firstString(args.connect_timeout_ms, process.env.SBER_CONNECT_TIMEOUT_MS, "30000"));

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
}

function validateMemberId(v) {
  return typeof v === "string" && /^[a-zA-Z0-9_\-\\]{1,8}$/.test(v);
}
function validateIdQr(v) {
  return typeof v === "string" && /^[a-zA-Z0-9_\-\\]{1,36}$/.test(v);
}

function readAccessToken(envPath) {
  const token = firstString(process.env.SBER_ACCESS_TOKEN, process.env.SBER_OAUTH_ACCESS_TOKEN, process.env.ACCESS_TOKEN);
  if (!token) throw new Error(`Missing access token in env. Expected SBER_ACCESS_TOKEN (env: ${envPath})`);
  return token;
}

function getSbpMemberId(args) {
  const v = firstString(args.sbp_member_id, process.env.SBER_SBP_MEMBER_ID);
  if (v) {
    const s = String(v).trim().toLowerCase();
    if (s === "none" || s === "0" || s === "false" || s === "off") return undefined;
    return String(v).trim();
  }
  // частый дефолт из доки/примеров
  return "100000000111";
}

function joinUrl(base, prefix, pth) {
  const b = String(base).replace(/\/+$/, "");
  const pr = prefix ? (prefix.startsWith("/") ? prefix : `/${prefix}`) : "";
  const pa = pth.startsWith("/") ? pth : `/${pth}`;
  return `${b}${pr}${pa}`;
}

async function postJson(url, bodyObj, { headers = {}, accept = DEFAULT_ACCEPT } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept, ...headers },
    body: JSON.stringify(bodyObj),
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

function isHtml404(resp) {
  if (!resp?.meta) return false;
  if (resp.meta.status !== 404) return false;
  const ct = String(resp.meta.contentType || "");
  if (!ct.includes("text/html")) return false;
  return typeof resp.raw === "string" && /<html/i.test(resp.raw);
}

async function saveQrPng(text, outPath) {
  const png = await QRCode.toBuffer(text, {
    type: "png",
    errorCorrectionLevel: "M",
    width: 512,
    margin: 2,
  });
  await fs.promises.writeFile(outPath, png);
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const envPath = firstString(args.env, process.env.SBER_ENV_PATH, DEFAULT_ENV);
  if (!fs.existsSync(envPath)) throw new Error(`.env not found at ${envPath}`);
  dotenv.config({ path: envPath });

  setupTlsFromEnvOrArgs(args);

  const accept = firstString(args.accept, process.env.SBER_ACCEPT, DEFAULT_ACCEPT);
  const accessToken = readAccessToken(envPath);

  // member_id = SBER_CLIENT_ID (как ты просил)
  const memberId = firstString(args.member_id, process.env.SBER_CLIENT_ID);
  if (!memberId) throw new Error("Missing member_id: set SBER_CLIENT_ID or pass --member_id");
  if (!validateMemberId(memberId)) throw new Error(`Bad member_id from SBER_CLIENT_ID="${memberId}" (need 1..8 chars)`);

  const tid = firstString(args.tid, process.env.SBER_TID, process.env.SBER_ID_QR);
  if (!tid) throw new Error("Missing tid/id_qr: set SBER_TID (or SBER_ID_QR) or pass --tid");
  if (!validateIdQr(tid)) throw new Error(`Bad tid/id_qr format: "${tid}"`);

  const currency = String(firstString(args.currency, process.env.SBER_CURRENCY, "643"));

  const amountRub = firstString(args.amount);
  const amountMinor = firstString(args.amount_minor);
  if (!amountRub && !amountMinor) throw new Error("Provide --amount 199.00 or --amount_minor 19900");

  const sumMinor = amountMinor ? Number(amountMinor) : rubToKopecks(amountRub);
  if (!Number.isFinite(sumMinor) || sumMinor < 0) throw new Error(`Bad amount: ${amountMinor || amountRub}`);

  const orderNumber = String(firstString(args.order, `INV-${Date.now()}`)).slice(0, 36);
  const description = String(firstString(args.desc, process.env.DEFAULT_DESCRIPTION, "Оплата через СБП")).slice(0, 256);
  const positionName = String(firstString(args.pos, process.env.DEFAULT_POSITION_NAME, "Платёж")).slice(0, 256);

  const rq_uid = rqUid32Hex();
  const rq_tm = isoZNoMillis();

  const body = {
    rq_uid,
    rq_tm,
    member_id: String(memberId),
    order_number: orderNumber,
    order_create_date: rq_tm,
    order_params_type: [
      {
        position_name: positionName,
        position_count: 1,
        position_sum: sumMinor,
        position_description: description,
      },
    ],
    id_qr: String(tid),
    order_sum: sumMinor,
    currency,
    description,
  };

  const sbpMemberId = getSbpMemberId(args);
  if (sbpMemberId) body.sbp_member_id = sbpMemberId;

  const explicitCreateUrl = firstString(args.qr_url, process.env.SBER_QR_CREATE_URL);

  const tokenUrl = firstString(process.env.SBER_TOKEN_URL);
  const originFromToken = tokenUrl ? new URL(tokenUrl).origin : undefined;

  // Официальный тестовый baseUrl из Postman-страницы :contentReference[oaicite:6]{index=6}
  const bases = [
    firstString(args.api_base, process.env.SBER_API_BASE_URL),
    originFromToken,
    "https://mc.api.sberbank.ru",
    "https://iftfintech.testsbi.sberbank.ru:9443",
  ].filter(Boolean);

  const headersBase = {
    Authorization: `Bearer ${accessToken}`,
    RqUID: rqUid32Hex(),
  };

  console.log("== Sber SBP Create QR ==");
  console.log("env_path:", envPath);
  console.log("token_url:", tokenUrl);
  console.log("explicit_create_url:", explicitCreateUrl || "(not set)");
  console.log("member_id(SBER_CLIENT_ID):", memberId);
  console.log("tid(id_qr):", tid);
  console.log("order_number:", orderNumber);
  console.log("sum_minor:", sumMinor);
  console.log("currency:", currency);
  console.log("sbp_member_id:", body.sbp_member_id || "(not set)");
  console.log("access_token:", safeMaskToken(accessToken));
  console.log("");

  let usedUrl = null;
  let resp = null;

  async function tryUrl(u) {
    const r = await postJson(u, body, { accept, headers: { ...headersBase, RqUID: rqUid32Hex() } });
    if (isHtml404(r)) {
      console.log(`TRY ${u} -> 404 html (skip)`);
      return null;
    }
    return r;
  }

  // 1) пробуем явный URL (если задан), но НЕ падаем на html-404
  if (explicitCreateUrl) {
    const r = await tryUrl(explicitCreateUrl);
    if (r) {
      usedUrl = explicitCreateUrl;
      resp = r;
    }
  }

  // 2) автоподбор
  if (!resp) {
    outer: for (const base of bases) {
      for (const pref of PREFIXES) {
        for (const pth of CREATE_PATHES) {
          const u = joinUrl(base, pref, pth);
          const r = await tryUrl(u);
          if (r) {
            usedUrl = u;
            resp = r;
            break outer;
          }
        }
      }
    }
  }

  if (!resp) {
    throw new Error("All candidate URLs returned 404 html. Set SBER_QR_CREATE_URL to the correct gateway URL (often mc.api.sberbank.ru).");
  }

  console.log("== Response meta ==");
  console.log(JSON.stringify({ ...resp.meta, usedUrl }, null, 2));

  if (!resp.meta.ok) {
    console.log("\n== Raw ==");
    console.log(resp.raw);
    throw new Error(`Create order failed HTTP ${resp.meta.status}`);
  }

  const j = resp.json || {};
  const orderFormUrl = j.order_form_url || j.orderFormUrl;
  if (!orderFormUrl) {
    console.log("\n== JSON ==");
    console.log(JSON.stringify(j, null, 2));
    throw new Error("No order_form_url in response JSON");
  }

  const outFile = firstString(args.out, "qr.png");
  await saveQrPng(orderFormUrl, outFile);

  console.log("\n== Result ==");
  console.log(JSON.stringify({
    ok: true,
    usedUrl,
    order_number: orderNumber,
    order_form_url: orderFormUrl,
    qr_png: path.resolve(outFile),
  }, null, 2));
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  if (e?.cause) console.error("CAUSE:", e.cause);
  process.exit(2);
});