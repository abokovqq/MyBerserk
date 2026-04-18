// src/tools/gizmoPingV1_advanced.mjs
// Улучшенный пингер Gizmo API v1 — с классификацией ошибок и безопасной обработкой бинарных данных.

import '../env.js';
import { gizmoFetch } from '../gizmoClient.js';
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ----------------- путь к API-файлу -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

const candidates = [
  "api/gizmo_api_v1.json",
  "gizmo_api_v1.json"
];

let apiFile = null;
for (const c of candidates) {
  const full = path.join(ROOT, c);
  if (fs.existsSync(full)) {
    apiFile = full;
    break;
  }
}

if (!apiFile) {
  console.error("❗ gizmo_api_v1.json не найден.");
  process.exit(1);
}

console.log(`Используем API файл: ${apiFile}\n`);

const api = JSON.parse(fs.readFileSync(apiFile, "utf8"));
const paths = api.paths || {};

const endpoints = [];

for (const [url, methods] of Object.entries(paths)) {
  for (const [method, meta] of Object.entries(methods)) {
    if (method.toLowerCase() !== "get") continue;

    endpoints.push({
      url,
      method: "GET",
      params: meta.parameters || [],
      summary: meta.summary || ""
    });
  }
}

console.log(`Найдено GET эндпоинтов: ${endpoints.length}`);
console.log("====================================================\n");

// ----------------- генерация параметров -----------------
function dummyParams(params) {
  const p = {};

  for (const param of params) {
    if (!param.required) continue;

    const type = param.schema?.type;
    const format = param.schema?.format;

    if (format === "date-time") {
      p[param.name] = new Date().toISOString();
    } else if (type === "integer") {
      p[param.name] = "1";
    } else {
      p[param.name] = "test";
    }
  }

  return p;
}

// ----------------- классификатор -----------------
function classifyError(err) {
  const msg = String(err);

  if (msg.includes("404")) return "404_NOT_FOUND";
  if (msg.includes("401")) return "401_UNAUTHORIZED";
  if (msg.includes("400") && msg.includes("ValidationError")) return "400_VALIDATION";
  if (msg.includes("Unexpected token") || msg.includes("not valid JSON")) return "NON_JSON";
  if (msg.includes("500")) return "500_SERVER";
  return "OTHER";
}

async function testEndpoint(ep) {
  const qp = dummyParams(ep.params);
  const query = Object.keys(qp).length ? "?" + new URLSearchParams(qp).toString() : "";
  const fullPath = ep.url + query;

  try {
    const res = await gizmoFetch(fullPath, { method: "GET", apiVersion: 1 });
    console.log(`🟩 200 | ${ep.url}   ${ep.summary}`);
    return { url: ep.url, status: 200 };
  } catch (err) {
    const type = classifyError(err);

    switch (type) {
      case "404_NOT_FOUND":
        console.log(`🟥 404 | ${ep.url}`);
        break;
      case "401_UNAUTHORIZED":
        console.log(`🟨 401 | ${ep.url} (недостаточно прав / ограничено лицензией)`);
        break;
      case "400_VALIDATION":
        console.log(`🔵 400 | ${ep.url} (нужен реальный ID / параметры)`);
        break;
      case "NON_JSON":
        console.log(`⚪ BIN | ${ep.url} (бинарный контент/картинка)`);
        break;
      case "500_SERVER":
        console.log(`🟧 500 | ${ep.url} (ошибка сервера)`);
        break;
      default:
        console.log(`⬜ ERR | ${ep.url} → ${String(err).slice(0, 60)}...`);
    }
  }
}

console.log("Начинаем пинг...\n");

for (const ep of endpoints) {
  await testEndpoint(ep);
}

console.log("\n🏁 Готово.");
process.exit(0);
