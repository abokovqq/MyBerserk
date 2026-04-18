// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/lib/sberTls.mjs
// Reusable TLS setup for Sber endpoints (Node fetch/undici).
//
// Reads from env (expected to be already loaded via dotenv in caller):
//   SBER_CA_BASE=system|node|none        (default: system)
//   SBER_CA_FILE=/path/to/extra-ca.pem   (optional; appended to base)
//   SBER_CLIENT_P12=/path/to/client.p12  (optional; mTLS)
//   SBER_CLIENT_P12_PASSPHRASE=...       (optional)
//   SBER_INSECURE_TLS=1                 (debug only; disables TLS verify)
//   SBER_TLS_LOG=1                      (optional; log configuration)
//
// Usage in other scripts:
//   import dotenv from "dotenv";
//   dotenv.config({ path: "/home/a/abokovsa/berserkclub.ru/MyBerserk/.env" });
//   import { configureSberTls } from "../lib/sberTls.mjs";
//   configureSberTls(); // before first fetch()

import fs from "node:fs";
import tls from "node:tls";
import { Agent, setGlobalDispatcher } from "undici";

let _configured = false;

function envBool(name, def = false) {
  const v = process.env[name];
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  return !(s === "" || s === "0" || s === "false" || s === "no" || s === "off");
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

function loadBaseCa(modeRaw = "system") {
  const mode = String(modeRaw).trim().toLowerCase();

  if (mode === "none") return "";

  if (mode === "system") {
    const candidates = [
      "/etc/ssl/certs/ca-certificates.crt", // Debian/Ubuntu
      "/etc/pki/tls/certs/ca-bundle.crt", // RHEL/CentOS
      "/etc/ssl/ca-bundle.pem",
      "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
    // fallback to node roots if system bundle not found
  }

  // "node" base (or fallback)
  return tls.rootCertificates.join("\n");
}

function buildCombinedCa({ caBaseMode, caFile }) {
  const base = loadBaseCa(caBaseMode);
  let combined = base ? `${base}\n` : "";

  if (caFile) {
    if (!fs.existsSync(caFile)) {
      throw new Error(`SBER_CA_FILE not found: ${caFile}`);
    }
    combined += fs.readFileSync(caFile, "utf8");
  }

  return combined.trim() ? combined : "";
}

/**
 * Configure global TLS for undici (Node fetch).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]    Reconfigure even if already configured
 * @param {boolean} [opts.quiet=false]    Suppress logs (unless SBER_TLS_LOG=1)
 * @param {string}  [opts.caBase]         Override SBER_CA_BASE
 * @param {string}  [opts.caFile]         Override SBER_CA_FILE
 * @param {string}  [opts.clientP12]      Override SBER_CLIENT_P12
 * @param {string}  [opts.clientP12Pass]  Override SBER_CLIENT_P12_PASSPHRASE
 * @returns {{mode:string, agent?:Agent, caBaseMode?:string, caFile?:string, p12File?:string}}
 */
export function configureSberTls(opts = {}) {
  const force = !!opts.force;
  if (_configured && !force) {
    return { mode: "already_configured" };
  }

  const logEnabled = envBool("SBER_TLS_LOG", false);
  const quiet = !!opts.quiet && !logEnabled;

  const insecure = firstString(process.env.SBER_INSECURE_TLS);
  if (insecure && String(insecure) !== "0" && String(insecure).toLowerCase() !== "false") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    if (!quiet) console.log("WARN: TLS verification disabled via SBER_INSECURE_TLS=1");
    _configured = true;
    return { mode: "insecure" };
  }

  const caBaseMode = firstString(opts.caBase, process.env.SBER_CA_BASE, "system");
  const caFile = firstString(opts.caFile, process.env.SBER_CA_FILE);

  const p12File = firstString(opts.clientP12, process.env.SBER_CLIENT_P12);
  const p12Pass = firstString(opts.clientP12Pass, process.env.SBER_CLIENT_P12_PASSPHRASE);

  const connect = {};

  const combinedCa = buildCombinedCa({ caBaseMode, caFile });
  if (combinedCa) connect.ca = combinedCa;

  if (p12File) {
    if (!fs.existsSync(p12File)) {
      throw new Error(`SBER_CLIENT_P12 not found: ${p12File}`);
    }
    connect.pfx = fs.readFileSync(p12File);
    if (p12Pass) connect.passphrase = p12Pass;
  }

  if (!connect.ca && !connect.pfx) {
    if (!quiet) console.log("TLS: using defaults (no SBER_CA_FILE / no SBER_CLIENT_P12).");
    _configured = true;
    return { mode: "default" };
  }

  const agent = new Agent({ connect });
  setGlobalDispatcher(agent);

  if (!quiet) {
    console.log("TLS: configured for Sber (undici global dispatcher):");
    console.log("  - ca_base:", caBaseMode);
    if (caFile) console.log("  - extra CA file:", caFile);
    if (p12File) console.log("  - client p12:", p12File);
  }

  _configured = true;
  return { mode: "custom", agent, caBaseMode, caFile, p12File };
}