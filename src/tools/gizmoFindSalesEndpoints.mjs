// src/tools/gizmoFindSalesEndpoints.mjs
// Ищем GET-эндпоинты, связанные с продажами — sales, payments, invoices, transactions.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Определяем корень проекта
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// Кандидаты путей к API-файлам
const CANDIDATES = [
  "api/gizmo_api_v1.json",
  "api/gizmo_api_v2.json",
  "gizmo_api_v1.json",
  "gizmo_api_v2.json"
];

function findFile(name) {
  for (const rel of CANDIDATES) {
    if (path.basename(rel) !== name) continue;
    const full = path.join(PROJECT_ROOT, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

// Ключевые слова для поиска
const KEYWORDS = [
  "sale",
  "sales",
  "transaction",
  "transactions",
  "payment",
  "payments",
  "invoice",
  "invoices",
  "order",
  "orders",
  "ticket",
  "tickets"
];

function hasKeyword(str) {
  str = str.toLowerCase();
  return KEYWORDS.some(k => str.includes(k));
}

function loadJson(name) {
  const file = findFile(name);
  if (!file) {
    console.error(`❗ Файл не найден: ${name}`);
    return null;
  }
  const data = fs.readFileSync(file, "utf8");
  return JSON.parse(data);
}

function parseApi(json, version) {
  console.log("");
  console.log("=====================================================");
  console.log(` 🔍 ПРОДАЖИ / ТРАНЗАКЦИИ — GIZMO API ${version}`);
  console.log("=====================================================\n");

  if (!json || !json.paths) {
    console.log("❗ JSON не содержит paths");
    return;
  }

  const paths = json.paths;
  const results = [];

  for (const [url, methods] of Object.entries(paths)) {
    for (const [method, meta] of Object.entries(methods)) {
      if (method.toLowerCase() !== "get") continue;

      const inUrl = hasKeyword(url);
      const inSummary = meta.summary ? hasKeyword(meta.summary) : false;

      if (!inUrl && !inSummary) continue;

      results.push({
        url,
        method: method.toUpperCase(),
        summary: meta.summary || ""
      });
    }
  }

  if (!results.length) {
    console.log("❗ GET-эндпоинтов, связанных с продажами, не найдено");
    return;
  }

  for (const ep of results) {
    console.log(`${ep.method} ${ep.url}`);
    if (ep.summary) console.log(`   → ${ep.summary}`);
    console.log("");
  }
}

// Загрузка V1
parseApi(loadJson("gizmo_api_v1.json"), "V1");

// Загрузка V2
parseApi(loadJson("gizmo_api_v2.json"), "V2");
