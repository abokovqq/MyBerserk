// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/sberStatementTransactions.mjs
//
// Получение операций по счету из Sber API.
// Основной список:
//   GET /fintech/api/v2/statement/transactions
//
// Детали операции:
//   GET /fintech/api/v2/statement/transactionId
//
// Сохраняет Excel-файл в:
//   /home/a/abokovsa/berserkclub.ru/MyBerserk/output
//
// Листы:
//   1) Кратко  — нормализованная таблица
//   2) RawList — сырой список операций
//   3) Details — сырые детали операций
//
// Токен берется напрямую из .env:
//   SBER_ACCESS_TOKEN=...
//
// Основные env:
//   SBER_BASE_URL=https://fintech.sberbank.ru:9443
//   SBER_ACCOUNT_NUMBER=40802810438000495317
//   SBER_TRANSACTIONS_URL=https://fintech.sberbank.ru:9443/fintech/api/v2/statement/transactions
//   SBER_TRANSACTION_DETAILS_URL=https://fintech.sberbank.ru:9443/fintech/api/v2/statement/transactionId
//   SBER_AUTH_SCHEME=bearer
//
// mTLS env:
//   SBER_CA_FILE=...
//   SBER_CLIENT_P12=...
//   SBER_CLIENT_P12_PASSPHRASE=...
//
// Запуск за день:
//   node src/tools/sberStatementTransactions.mjs --date 2026-05-17
//
// Запуск за диапазон:
//   node src/tools/sberStatementTransactions.mjs --from 2026-05-11 --to 2026-05-17
//
// Без запроса деталей:
//   node src/tools/sberStatementTransactions.mjs --date 2026-05-17 --no_details

console.log("SCRIPT_START", new Date().toISOString());

import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import dotenv from "dotenv";
import { Agent, setGlobalDispatcher } from "undici";

let ExcelJS;

try {
  const mod = await import("exceljs");
  ExcelJS = mod.default || mod;
} catch {
  throw new Error(
    "Не установлен пакет exceljs. Выполни: cd /home/a/abokovsa/berserkclub.ru/MyBerserk && /home/a/abokovsa/opt/node/bin/npm i exceljs"
  );
}

const PROJECT_ROOT = "/home/a/abokovsa/berserkclub.ru/MyBerserk";
const DEFAULT_ENV = `${PROJECT_ROOT}/.env`;
const DEFAULT_BASE_URL = "https://fintech.sberbank.ru:9443";
const DEFAULT_TRANSACTIONS_PATH = "/fintech/api/v2/statement/transactions";
const DEFAULT_DETAILS_PATH = "/fintech/api/v2/statement/transactionId";
const DEFAULT_OUTPUT_DIR = `${PROJECT_ROOT}/output`;
const DEFAULT_TIMEOUT_MS = 30000;

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

function getEnv(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : null;
}

function isFalseValue(value) {
  if (value === false) return true;

  const s = String(value || "").trim().toLowerCase();

  return ["0", "false", "no", "n", "off"].includes(s);
}

function requireValue(value, message) {
  if (!value || !String(value).trim()) {
    throw new Error(message);
  }

  return String(value).trim();
}

function isValidAccountNumber(accountNumber) {
  return /^[0-9]{20}$/.test(String(accountNumber || ""));
}

function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""));
}

function todayMoscowDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;

  return `${y}-${m}-${d}`;
}

function parseDateUtc(dateStr) {
  if (!isValidDate(dateStr)) {
    throw new Error(`Некорректная дата: ${dateStr}. Формат должен быть yyyy-MM-dd.`);
  }

  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDateUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

function addDaysUtc(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function buildStatementDates(args) {
  if (args.from || args.to) {
    const from = String(args.from || "").trim();
    const to = String(args.to || "").trim();

    if (!from || !to) {
      throw new Error("Для диапазона нужно указать обе даты: --from yyyy-MM-dd --to yyyy-MM-dd");
    }

    const fromDate = parseDateUtc(from);
    const toDate = parseDateUtc(to);

    if (fromDate > toDate) {
      throw new Error(`Дата --from не может быть больше --to: ${from} > ${to}`);
    }

    const dates = [];

    for (let d = fromDate; d <= toDate; d = addDaysUtc(d, 1)) {
      dates.push(formatDateUtc(d));
    }

    return dates;
  }

  const baseDate = String(args.date || todayMoscowDate());

  if (!isValidDate(baseDate)) {
    throw new Error(`Некорректная дата: ${baseDate}. Формат должен быть yyyy-MM-dd.`);
  }

  const days = Number(args.days || 1);

  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`Некорректный --days: ${args.days}`);
  }

  const endDate = parseDateUtc(baseDate);
  const startDate = addDaysUtc(endDate, -(days - 1));

  const dates = [];

  for (let d = startDate; d <= endDate; d = addDaysUtc(d, 1)) {
    dates.push(formatDateUtc(d));
  }

  return dates;
}

function safeMask(value) {
  if (!value || typeof value !== "string") return value;
  if (value.length <= 12) return "***";
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function safeFilePart(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9А-Яа-яёЁ._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function readFileIfExists(filePath, label) {
  if (!filePath) return undefined;

  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }

  return fs.readFileSync(filePath);
}

function setupTls(args) {
  const caFile = firstString(
    args.ca,
    process.env.SBER_CA_FILE,
    process.env.SBER_SERVER_CA_CERT_PATH,
    process.env.SBER_CA_PATH
  );

  const p12File = firstString(
    args.mtls_pfx,
    process.env.SBER_CLIENT_P12,
    process.env.SBER_CLIENT_CERT_P12_PATH,
    process.env.SBER_MTLS_PFX_PATH
  );

  const p12Pass = firstString(
    args.mtls_pass,
    process.env.SBER_CLIENT_P12_PASSPHRASE,
    process.env.SBER_CLIENT_CERT_P12_PASSWORD,
    process.env.SBER_MTLS_PFX_PASSWORD
  );

  const certFile = firstString(
    args.mtls_cert,
    process.env.SBER_CLIENT_CERT_PEM_PATH,
    process.env.SBER_MTLS_CERT_PATH
  );

  const keyFile = firstString(
    args.mtls_key,
    process.env.SBER_CLIENT_KEY_PEM_PATH,
    process.env.SBER_MTLS_KEY_PATH
  );

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

    console.log("mTLS mode: PEM cert/key");
    if (caFile) console.log("CA:", caFile);
    console.log("cert:", certFile);
    console.log("key:", keyFile);
  } else if (p12File) {
    connect.pfx = readFileIfExists(p12File, "client p12");

    if (p12Pass) {
      connect.passphrase = p12Pass;
    }

    console.log("mTLS mode: P12/PFX");
    if (caFile) console.log("CA:", caFile);
    console.log("p12:", p12File);
  } else {
    throw new Error(
      "Не заданы mTLS сертификаты. Укажи SBER_CLIENT_P12 или SBER_CLIENT_CERT_P12_PATH, либо SBER_CLIENT_CERT_PEM_PATH + SBER_CLIENT_KEY_PEM_PATH."
    );
  }

  setGlobalDispatcher(new Agent({ connect }));
}

function buildTransactionsUrl(baseUrl, accountNumber, statementDate, page, curFormat) {
  const fullUrl =
    getEnv("SBER_TRANSACTIONS_URL") ||
    `${String(baseUrl).replace(/\/+$/, "")}${DEFAULT_TRANSACTIONS_PATH}`;

  const u = new URL(fullUrl);

  u.searchParams.set("accountNumber", accountNumber);
  u.searchParams.set("statementDate", statementDate);
  u.searchParams.set("page", String(page));

  if (curFormat) {
    u.searchParams.set("curFormat", curFormat);
  }

  return u.toString();
}

function buildDetailsUrl(baseUrl, accountNumber, operationDate, id) {
  const fullUrl =
    getEnv("SBER_TRANSACTION_DETAILS_URL") ||
    `${String(baseUrl).replace(/\/+$/, "")}${DEFAULT_DETAILS_PATH}`;

  const u = new URL(fullUrl);

  u.searchParams.set("id", id);
  u.searchParams.set("accountNumber", accountNumber);
  u.searchParams.set("operationDate", operationDate);

  return u.toString();
}

function makeAuthorizationHeader(accessToken, authScheme) {
  if (authScheme === "bearer") {
    return `Bearer ${accessToken}`;
  }

  return accessToken;
}

async function requestJson(url, accessToken, authScheme, timeoutMs, throwOnError = true) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("Request timeout")), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: makeAuthorizationHeader(accessToken, authScheme),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      signal: ac.signal,
    });

    const text = await res.text();

    let parsed = null;

    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    const meta = {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      contentType: res.headers.get("content-type"),
    };

    if (!res.ok && throwOnError) {
      const error = new Error(`Sber API error: HTTP ${res.status} ${res.statusText}`);
      error.meta = meta;
      error.responseText = text;
      error.responseJson = parsed;
      throw error;
    }

    return {
      meta,
      json: parsed,
      raw: text,
    };
  } finally {
    clearTimeout(t);
  }
}

function findTransactionsArray(json) {
  if (!json) return [];

  if (Array.isArray(json)) return json;

  const candidates = [
    json.transactions,
    json.statement?.transactions,
    json.result?.transactions,
    json.response?.transactions,
    json.data?.transactions,
    json.items,
    json.data,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  return [];
}

function getPath(obj, fieldPath) {
  const parts = fieldPath.split(".");
  let cur = obj;

  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }

  return cur;
}

function hasNextPage(json) {
  if (!json || typeof json !== "object") return false;

  const candidates = [
    "_links.next.href",
    "_links.next",
    "links.next.href",
    "links.next",
    "pagination.next",
    "paging.next",
  ];

  for (const p of candidates) {
    const v = getPath(json, p);

    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return true;
    }
  }

  return false;
}

function firstValue(obj, paths) {
  for (const p of paths) {
    const v = getPath(obj, p);

    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return v;
    }
  }

  return "";
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];

  for (const v of values) {
    if (v === undefined || v === null) continue;

    if (typeof v === "object") continue;

    const s = String(v).trim();

    if (!s) continue;
    if (seen.has(s)) continue;

    seen.add(s);
    out.push(s);
  }

  return out;
}

function extractOperationIdCandidates(tx) {
  return uniqueStrings([
    firstValue(tx, ["operationId"]),
    firstValue(tx, ["id"]),
    firstValue(tx, ["transactionId"]),
    firstValue(tx, ["documentId"]),
    firstValue(tx, ["uuid"]),
    firstValue(tx, ["hashAbc"]),
    firstValue(tx, ["hash"]),
    firstValue(tx, ["operationHash"]),
  ]);
}

function normalizeAmountValue(value) {
  if (value === undefined || value === null || value === "") return "";

  if (typeof value === "object") {
    const nested = firstValue(value, [
      "amount",
      "value",
      "sum",
      "minorUnits",
      "number",
    ]);

    return normalizeAmountValue(nested);
  }

  const s = String(value).replace(/\s+/g, "").replace(",", ".");
  const n = Number(s);

  if (!Number.isFinite(n)) {
    return String(value);
  }

  return n;
}

function extractAmount(tx) {
  const raw = firstValue(tx, [
    "amount",
    "operationAmount",
    "transactionAmount",
    "documentAmount",
    "paymentAmount",
    "sum",
    "amount.value",
    "amount.amount",
    "operationAmount.value",
    "operationAmount.amount",
    "transactionAmount.value",
    "transactionAmount.amount",
  ]);

  return normalizeAmountValue(raw);
}

function extractDate(obj, fallbackDate) {
  const raw = firstValue(obj, [
    "operationDate",
    "transactionDate",
    "documentDate",
    "postingDate",
    "valueDate",
    "date",
    "createdAt",
    "operationTime",
    "transactionTime",
    "documentDateTime",
  ]);

  if (!raw) return fallbackDate || "";

  const s = String(raw);

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  return s;
}

function extractDescription(tx, detail) {
  return String(
    firstValue(detail || {}, [
      "paymentPurpose",
      "purpose",
      "operationPurpose",
      "transactionPurpose",
    ]) ||
      firstValue(tx, [
        "description",
        "paymentPurpose",
        "purpose",
        "operationPurpose",
        "transactionPurpose",
        "details",
        "documentPurpose",
        "paymentDetails",
        "narrative",
        "ground",
        "operationName",
        "typeDescription",
      ]) ||
      ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

function findAccountValue(tx, paths) {
  const raw = firstValue(tx, paths);
  return String(raw || "").replace(/\D+/g, "");
}

function extractPayerAccount(tx) {
  return findAccountValue(tx, [
    "payerAccount",
    "payerAccountNumber",
    "payer.account",
    "payer.accountNumber",
    "payer.requisites.account",
    "payer.requisites.accountNumber",
    "payer.bankAccount",
    "payer.bankAccountNumber",
    "payerInfo.account",
    "payerInfo.accountNumber",
    "payerRequisites.account",
    "payerRequisites.accountNumber",
  ]);
}

function extractReceiverAccount(tx) {
  return findAccountValue(tx, [
    "receiverAccount",
    "receiverAccountNumber",
    "recipientAccount",
    "recipientAccountNumber",
    "payeeAccount",
    "payeeAccountNumber",
    "receiver.account",
    "receiver.accountNumber",
    "recipient.account",
    "recipient.accountNumber",
    "payee.account",
    "payee.accountNumber",
    "receiver.requisites.account",
    "receiver.requisites.accountNumber",
    "recipient.requisites.account",
    "recipient.requisites.accountNumber",
    "payee.requisites.account",
    "payee.requisites.accountNumber",
    "receiverInfo.account",
    "receiverInfo.accountNumber",
    "recipientInfo.account",
    "recipientInfo.accountNumber",
    "receiverRequisites.account",
    "receiverRequisites.accountNumber",
    "recipientRequisites.account",
    "recipientRequisites.accountNumber",
  ]);
}

function mapDirection(raw) {
  const s = String(raw || "").trim().toUpperCase();

  if (s === "DEBIT") return "расход";
  if (s === "CREDIT") return "доход";

  const low = s.toLowerCase();

  if (
    low.includes("debit") ||
    low.includes("deb") ||
    low === "d" ||
    low === "db" ||
    low.includes("out") ||
    low.includes("расход") ||
    low.includes("спис") ||
    low.includes("исход")
  ) {
    return "расход";
  }

  if (
    low.includes("credit") ||
    low.includes("cr") ||
    low === "c" ||
    low.includes("in") ||
    low.includes("доход") ||
    low.includes("зачис") ||
    low.includes("вход") ||
    low.includes("приход")
  ) {
    return "доход";
  }

  return "";
}

function extractDirection(tx, detail, myAccountNumber) {
  const detailDirection = mapDirection(
    firstValue(detail || {}, [
      "direction",
      "transactionDirection",
      "operationDirection",
    ])
  );

  if (detailDirection) return detailDirection;

  const payerAccount = extractPayerAccount(tx);
  const receiverAccount = extractReceiverAccount(tx);

  if (payerAccount && payerAccount === myAccountNumber) {
    return "расход";
  }

  if (receiverAccount && receiverAccount === myAccountNumber) {
    return "доход";
  }

  const rawDirection = mapDirection(
    firstValue(tx, [
      "direction",
      "operationDirection",
      "transactionDirection",
      "debitCredit",
      "debitCreditIndicator",
      "debetCredit",
      "dcSign",
      "sign",
      "type",
      "operationType",
    ])
  );

  if (rawDirection) return rawDirection;

  const amount = Number(String(extractAmount(tx)).replace(",", "."));

  if (Number.isFinite(amount)) {
    if (amount < 0) return "расход";
    if (amount > 0) return "доход";
  }

  return "";
}

function extractPayerName(tx) {
  return String(
    firstValue(tx, [
      "payerName",
      "payer.name",
      "payer.fullName",
      "payer.organizationName",
      "payer.orgName",
      "payerInfo.name",
      "payerInfo.fullName",
      "payerRequisites.name",
      "payerRequisites.fullName",
      "payerRequisites.organizationName",
    ]) || ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractReceiverName(tx) {
  return String(
    firstValue(tx, [
      "receiverName",
      "recipientName",
      "payeeName",
      "receiver.name",
      "receiver.fullName",
      "receiver.organizationName",
      "receiver.orgName",
      "recipient.name",
      "recipient.fullName",
      "recipient.organizationName",
      "recipient.orgName",
      "payee.name",
      "payee.fullName",
      "payee.organizationName",
      "receiverInfo.name",
      "receiverInfo.fullName",
      "recipientInfo.name",
      "recipientInfo.fullName",
      "receiverRequisites.name",
      "receiverRequisites.fullName",
      "receiverRequisites.organizationName",
      "recipientRequisites.name",
      "recipientRequisites.fullName",
      "recipientRequisites.organizationName",
    ]) || ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractPartner(tx, detail, direction) {
  const payerName = extractPayerName(tx);
  const receiverName = extractReceiverName(tx);

  const correspondingAccount = String(
    firstValue(detail || {}, ["correspondingAccount"]) || ""
  ).trim();

  const filial = String(firstValue(detail || {}, ["filial"]) || "").trim();

  if (direction === "доход") {
    return payerName || receiverName || correspondingAccount || filial || "";
  }

  if (direction === "расход") {
    return receiverName || payerName || correspondingAccount || filial || "";
  }

  return payerName || receiverName || correspondingAccount || filial || "";
}

function normalizeTransactionForTable(record, myAccountNumber) {
  const tx = record.tx;
  const detail = record.detail || {};
  const direction = extractDirection(tx, detail, myAccountNumber);

  return {
    statementDate: record.statementDate,
    operationDate: extractDate(detail, extractDate(tx, record.statementDate)),
    documentDate: firstValue(detail, ["documentDate"]) || "",
    documentNumber: firstValue(detail, [
      "number",
      "documentNumber",
      "docNumber",
      "paymentDocumentNumber",
    ]) || "",
    amount: extractAmount(tx),
    direction,
    partner: extractPartner(tx, detail, direction),
    description: extractDescription(tx, detail),
    operationCode: firstValue(detail, ["operationCode"]) || "",
    operationId:
      firstValue(detail, ["operationId"]) ||
      record.detailId ||
      firstValue(tx, ["operationId", "id", "transactionId"]) ||
      "",
    hashAbc:
      firstValue(detail, ["hashAbc"]) ||
      firstValue(tx, ["hashAbc", "hash", "operationHash"]) ||
      "",
    detailError: record.detailError || "",
  };
}

function stringifyCell(value) {
  if (value === undefined || value === null) return "";

  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  return JSON.stringify(value);
}

function flattenObject(obj, prefix = "", out = {}) {
  if (obj === null || obj === undefined) {
    if (prefix) out[prefix] = "";
    return out;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      out[prefix] = "[]";
      return out;
    }

    for (let i = 0; i < obj.length; i++) {
      const key = prefix ? `${prefix}.${i}` : String(i);
      flattenObject(obj[i], key, out);
    }

    return out;
  }

  if (typeof obj === "object") {
    const keys = Object.keys(obj);

    if (keys.length === 0) {
      if (prefix) out[prefix] = "{}";
      return out;
    }

    for (const key of keys) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenObject(obj[key], nextPrefix, out);
    }

    return out;
  }

  out[prefix] = stringifyCell(obj);
  return out;
}

function collectColumns(rows, priority = []) {
  const set = new Set();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      set.add(key);
    }
  }

  const rest = Array.from(set)
    .filter((k) => !priority.includes(k))
    .sort();

  return [...priority.filter((k) => set.has(k)), ...rest];
}

function normalizeRawListRows(records) {
  return records.map((record, index) => ({
    "#": index + 1,
    statementDate: record.statementDate,
    page: record.page,
    ...flattenObject(record.tx),
  }));
}

function normalizeDetailRows(records) {
  return records.map((record, index) => ({
    "#": index + 1,
    statementDate: record.statementDate,
    page: record.page,
    requestedId: record.detailId || "",
    detailError: record.detailError || "",
    ...flattenObject(record.detail || {}),
  }));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function printJsonShape(json) {
  if (!json || typeof json !== "object") {
    console.log("JSON shape: response is not object");
    return;
  }

  console.log("JSON top-level keys:", Object.keys(json).join(", ") || "(empty)");

  if (json._links && typeof json._links === "object") {
    console.log("JSON _links keys:", Object.keys(json._links).join(", ") || "(empty)");
  }
}

async function loadPagesForDate({
  baseUrl,
  accountNumber,
  statementDate,
  curFormat,
  accessToken,
  authScheme,
  maxPages,
  delayMs,
  timeoutMs,
}) {
  const records = [];

  let page = 1;

  while (page <= maxPages) {
    const url = buildTransactionsUrl(baseUrl, accountNumber, statementDate, page, curFormat);

    console.log(`Запрос ${statementDate}, страница ${page}: ${url}`);

    const response = await requestJson(url, accessToken, authScheme, timeoutMs, true);
    const transactions = findTransactionsArray(response.json);

    if (page === 1) {
      printJsonShape(response.json);
    }

    for (const tx of transactions) {
      records.push({
        statementDate,
        page,
        tx,
        detail: null,
        detailId: "",
        detailError: "",
      });
    }

    console.log(`${statementDate}, страница ${page}: операций = ${transactions.length}`);

    const nextExists = hasNextPage(response.json);

    if (!nextExists) {
      console.log(`${statementDate}: следующей страницы нет.`);
      break;
    }

    page += 1;

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return records;
}

async function loadAllDates(params) {
  const all = [];

  for (const statementDate of params.statementDates) {
    const records = await loadPagesForDate({
      ...params,
      statementDate,
    });

    all.push(...records);

    if (params.delayMs > 0) {
      await sleep(params.delayMs);
    }
  }

  return all;
}

async function loadDetailForRecord({
  record,
  baseUrl,
  accountNumber,
  accessToken,
  authScheme,
  timeoutMs,
  delayMs,
}) {
  const candidates = extractOperationIdCandidates(record.tx);

  if (candidates.length === 0) {
    return {
      ...record,
      detailError: "operation id not found in list response",
    };
  }

  const errors = [];

  for (const id of candidates) {
    const url = buildDetailsUrl(baseUrl, accountNumber, record.statementDate, id);

    const response = await requestJson(url, accessToken, authScheme, timeoutMs, false);

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    if (response.meta.ok) {
      return {
        ...record,
        detail: response.json,
        detailId: id,
        detailError: "",
      };
    }

    const msg =
      response.responseJson?.message ||
      response.json?.message ||
      response.raw ||
      `${response.meta.status} ${response.meta.statusText}`;

    errors.push(`${id}: HTTP ${response.meta.status} ${String(msg).slice(0, 200)}`);
  }

  return {
    ...record,
    detailId: candidates[0],
    detailError: errors.join(" | "),
  };
}

async function enrichRecordsWithDetails({
  records,
  baseUrl,
  accountNumber,
  accessToken,
  authScheme,
  timeoutMs,
  delayMs,
}) {
  const enriched = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const candidates = extractOperationIdCandidates(record.tx);

    console.log(
      `Детали операции ${i + 1}/${records.length}: ${candidates[0] || "id not found"}`
    );

    const next = await loadDetailForRecord({
      record,
      baseUrl,
      accountNumber,
      accessToken,
      authScheme,
      timeoutMs,
      delayMs,
    });

    if (next.detailError) {
      console.log(`  details error: ${next.detailError}`);
    }

    enriched.push(next);
  }

  return enriched;
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" },
    };
    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
    cell.border = {
      top: { style: "thin", color: { argb: "FFBFBFBF" } },
      left: { style: "thin", color: { argb: "FFBFBFBF" } },
      bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
      right: { style: "thin", color: { argb: "FFBFBFBF" } },
    };
  });
}

function styleBody(sheet) {
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    row.eachCell((cell) => {
      cell.alignment = {
        vertical: "top",
        wrapText: true,
      };
      cell.border = {
        top: { style: "thin", color: { argb: "FFE5E5E5" } },
        left: { style: "thin", color: { argb: "FFE5E5E5" } },
        bottom: { style: "thin", color: { argb: "FFE5E5E5" } },
        right: { style: "thin", color: { argb: "FFE5E5E5" } },
      };
    });
  });
}

function setAutoFilter(sheet, columnCount) {
  if (columnCount <= 0) return;

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnCount },
  };
}

function addSummarySheet(workbook, rows) {
  const sheet = workbook.addWorksheet("Кратко");

  sheet.columns = [
    { header: "День выписки", key: "statementDate", width: 16 },
    { header: "Дата операции", key: "operationDate", width: 20 },
    { header: "Дата документа", key: "documentDate", width: 16 },
    { header: "№ документа", key: "documentNumber", width: 18 },
    { header: "Сумма", key: "amount", width: 14 },
    { header: "Тип", key: "direction", width: 14 },
    { header: "Контрагент", key: "partner", width: 42 },
    { header: "Описание", key: "description", width: 100 },
    { header: "Код операции", key: "operationCode", width: 16 },
    { header: "operationId", key: "operationId", width: 26 },
    { header: "hashAbc", key: "hashAbc", width: 36 },
    { header: "detailError", key: "detailError", width: 60 },
  ];

  for (const row of rows) {
    sheet.addRow(row);
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  styleHeader(sheet.getRow(1));
  styleBody(sheet);
  setAutoFilter(sheet, sheet.columns.length);

  sheet.getColumn("amount").numFmt = "#,##0.00";

  return sheet;
}

function addGenericSheet(workbook, name, rows, priorityColumns) {
  const sheet = workbook.addWorksheet(name);
  const columns = collectColumns(rows, priorityColumns);

  sheet.columns = columns.map((key) => ({
    header: key,
    key,
    width: key === "#" ? 8 : Math.min(Math.max(key.length + 2, 14), 40),
  }));

  for (const rawRow of rows) {
    const row = {};

    for (const key of columns) {
      row[key] = rawRow[key] ?? "";
    }

    sheet.addRow(row);
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  styleHeader(sheet.getRow(1));
  styleBody(sheet);
  setAutoFilter(sheet, sheet.columns.length);

  for (let i = 1; i <= sheet.columns.length; i++) {
    const col = sheet.getColumn(i);
    const header = String(col.header || "").toLowerCase();

    if (
      header.includes("description") ||
      header.includes("purpose") ||
      header.includes("paymentpurpose") ||
      header.includes("detailerror")
    ) {
      col.width = 80;
    }

    if (header.includes("amount") || header.includes("sum")) {
      col.width = 16;
    }

    if (header.includes("date")) {
      col.width = 18;
    }
  }

  return sheet;
}

async function saveExcel({
  records,
  summaryRows,
  statementDates,
  accountNumber,
  outputDir,
}) {
  fs.mkdirSync(outputDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();

  workbook.creator = "MyBerserk";
  workbook.created = new Date();
  workbook.modified = new Date();

  addSummarySheet(workbook, summaryRows);

  addGenericSheet(
    workbook,
    "RawList",
    normalizeRawListRows(records),
    ["#", "statementDate", "page"]
  );

  addGenericSheet(
    workbook,
    "Details",
    normalizeDetailRows(records),
    ["#", "statementDate", "page", "requestedId", "detailError", "number", "operationId", "hashAbc"]
  );

  const datePart =
    statementDates.length === 1
      ? statementDates[0]
      : `${statementDates[0]}_${statementDates[statementDates.length - 1]}`;

  const fileName = `sber_transactions_${safeFilePart(datePart)}_${safeFilePart(accountNumber)}.xlsx`;
  const filePath = path.join(outputDir, fileName);

  await workbook.xlsx.writeFile(filePath);

  return filePath;
}

async function main() {
  console.log("sberStatementTransactions: start");

  const args = parseArgs(process.argv.slice(2));

  const envPath = String(args.env || DEFAULT_ENV);

  if (!fs.existsSync(envPath)) {
    throw new Error(`.env не найден: ${envPath}`);
  }

  dotenv.config({ path: envPath });

  setupTls(args);

  const baseUrl = requireValue(
    args.base_url || getEnv("SBER_BASE_URL") || DEFAULT_BASE_URL,
    "Не задан SBER_BASE_URL в .env или --base_url."
  );

  const accountNumber = requireValue(
    args.account || getEnv("SBER_ACCOUNT_NUMBER"),
    "Не задан номер счета. Передай --account или укажи SBER_ACCOUNT_NUMBER в .env."
  );

  if (!isValidAccountNumber(accountNumber)) {
    throw new Error(`Некорректный номер счета: ${accountNumber}. Должно быть 20 цифр.`);
  }

  const accessToken = requireValue(
    getEnv("SBER_ACCESS_TOKEN"),
    "Не задан SBER_ACCESS_TOKEN в .env."
  );

  const statementDates = buildStatementDates(args);

  const curFormat = args.curFormat || getEnv("SBER_CUR_FORMAT") || null;

  const authScheme = String(
    args.auth_scheme ||
      getEnv("SBER_AUTH_SCHEME") ||
      "bearer"
  ).toLowerCase();

  if (!["raw", "bearer"].includes(authScheme)) {
    throw new Error(`Некорректный auth_scheme: ${authScheme}. Допустимо: raw или bearer.`);
  }

  const maxPages = Number(args.max_pages || getEnv("SBER_MAX_PAGES") || 100);

  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`Некорректный max_pages: ${maxPages}`);
  }

  const delayMs = Number(args.delay_ms || getEnv("SBER_DELAY_MS") || 250);

  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`Некорректный delay_ms: ${delayMs}`);
  }

  const timeoutMs = Number(args.timeout_ms || getEnv("SBER_TIMEOUT_MS") || DEFAULT_TIMEOUT_MS);

  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new Error(`Некорректный timeout_ms: ${timeoutMs}`);
  }

  const outputDir = String(
    args.output_dir ||
      getEnv("SBER_OUTPUT_DIR") ||
      DEFAULT_OUTPUT_DIR
  );

  const loadDetails =
    !args.no_details &&
    !isFalseValue(firstString(getEnv("SBER_LOAD_DETAILS"), "1"));

  console.log(`ENV: ${envPath}`);
  console.log(`BASE_URL: ${baseUrl}`);
  console.log(`TRANSACTIONS_URL: ${getEnv("SBER_TRANSACTIONS_URL") || `${String(baseUrl).replace(/\/+$/, "")}${DEFAULT_TRANSACTIONS_PATH}`}`);
  console.log(`DETAILS_URL: ${getEnv("SBER_TRANSACTION_DETAILS_URL") || `${String(baseUrl).replace(/\/+$/, "")}${DEFAULT_DETAILS_PATH}`}`);
  console.log(`ACCOUNT: ${accountNumber}`);
  console.log(`DATES: ${statementDates.join(", ")}`);
  console.log(`AUTH_SCHEME: ${authScheme}`);
  console.log(`ACCESS_TOKEN: ${safeMask(accessToken)}`);
  console.log(`LOAD_DETAILS: ${loadDetails ? "yes" : "no"}`);
  console.log(`MAX_PAGES: ${maxPages}`);
  console.log(`DELAY_MS: ${delayMs}`);
  console.log(`TIMEOUT_MS: ${timeoutMs}`);
  console.log(`OUTPUT_DIR: ${outputDir}`);
  console.log("");

  let records = await loadAllDates({
    statementDates,
    baseUrl,
    accountNumber,
    curFormat,
    accessToken,
    authScheme,
    maxPages,
    delayMs,
    timeoutMs,
  });

  if (loadDetails && records.length > 0) {
    console.log("");
    console.log("Загружаю детали операций...");
    records = await enrichRecordsWithDetails({
      records,
      baseUrl,
      accountNumber,
      accessToken,
      authScheme,
      timeoutMs,
      delayMs,
    });
  }

  const summaryRows = records.map((record) =>
    normalizeTransactionForTable(record, accountNumber)
  );

  const xlsxPath = await saveExcel({
    records,
    summaryRows,
    statementDates,
    accountNumber,
    outputDir,
  });

  console.log("");
  console.log(`Дней запрошено: ${statementDates.length}`);
  console.log(`Операций получено: ${records.length}`);
  console.log(`Excel сохранен: ${xlsxPath}`);
  console.log("");
  console.log("sberStatementTransactions: done");
}

main().catch((e) => {
  console.error("sberStatementTransactions: ERROR");
  console.error(e?.message || e);

  if (e?.meta) {
    console.error("HTTP meta:");
    console.error(JSON.stringify(e.meta, null, 2));
  }

  if (e?.responseJson) {
    console.error("Sber response JSON:");
    console.error(JSON.stringify(e.responseJson, null, 2));
  } else if (e?.responseText) {
    console.error("Sber response text:");
    console.error(e.responseText);
  }

  if (e?.cause) {
    console.error("CAUSE:");
    console.error(e.cause);
  }

  process.exit(2);
});