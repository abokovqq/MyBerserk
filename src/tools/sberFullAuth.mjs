// /home/a/abokovsa/berserkclub.ru/MyBerserk/src/tools/sberFullAuth.mjs
//
// Full Authorization Code flow for Sber API (SberBusiness user token).
// - Builds authorize URL
// - Runs local callback server to capture `code`
// - Exchanges code for tokens via /oauth/token (mTLS required)
//
// .env required:
//   SBER_CLIENT_ID=...
//   SBER_CLIENT_SECRET=...
// Optional:
//   SBER_REDIRECT_URI=...
//   SBER_SCOPE=...

import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import dotenv from "dotenv";
import { spawnSync } from "node:child_process";
import { Agent, setGlobalDispatcher } from "undici";

const DEFAULT_ENV = "/home/a/abokovsa/berserkclub.ru/MyBerserk/.env";

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

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name} in ${DEFAULT_ENV}`);
  return v;
}

function maybeEnv(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : null;
}

function formUrlEncoded(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  }
  return p.toString();
}

function mask(t) {
  if (!t || typeof t !== "string") return t;
  if (t.length <= 12) return "***";
  return `${t.slice(0, 6)}…${t.slice(-6)}`;
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

function setupTls(args) {
  const ca = args.ca ? fs.readFileSync(String(args.ca)) : undefined;

  const hasCertKey = args.mtls_cert && args.mtls_key;
  const hasPfx = args.mtls_pfx;

  if (!hasCertKey && !hasPfx) {
    throw new Error(
      `mTLS required. Provide --mtls_cert/--mtls_key or --mtls_pfx (and ideally --ca).`
    );
  }

  const connect = { ca };

  if (hasCertKey) {
    connect.cert = fs.readFileSync(String(args.mtls_cert));
    connect.key = fs.readFileSync(String(args.mtls_key));
  } else {
    connect.pfx = fs.readFileSync(String(args.mtls_pfx));
    if (args.mtls_pass) connect.passphrase = String(args.mtls_pass);
  }

  setGlobalDispatcher(new Agent({ connect }));
}

async function postForm(url, body, accept = "application/json") {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": accept,
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
  if (accept === "application/jose") return { meta, jose: text };

  try {
    return { meta, json: JSON.parse(text) };
  } catch {
    return { meta, raw: text };
  }
}

function buildAuthorizeUrl({
  authorizeBase,
  clientId,
  redirectUri,
  scope,
  state,
  pkce, // {challenge, method}
}) {
  // Default authorize path used in many Sber examples:
  // /ic/sso/api/v2/oauth/authorize
  const u = new URL(authorizeBase);
  const path = u.pathname && u.pathname !== "/" ? u.pathname : "/ic/sso/api/v2/oauth/authorize";
  const full = new URL(path, u.origin);

  full.searchParams.set("response_type", "code");
  full.searchParams.set("client_id", clientId);
  full.searchParams.set("redirect_uri", redirectUri);
  if (scope) full.searchParams.set("scope", scope);
  if (state) full.searchParams.set("state", state);

  if (pkce?.challenge) {
    full.searchParams.set("code_challenge", pkce.challenge);
    full.searchParams.set("code_challenge_method", pkce.method || "S256");
  }

  return full.toString();
}

function tryOpenBrowser(url) {
  const candidates = [
    ["xdg-open", url],
    ["gio", "open", url],
    ["open", url], // mac
  ];

  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "ignore" });
      if (r.status === 0) return true;
    } catch {}
  }
  return false;
}

function saveTokens(tokens, outPath) {
  fs.mkdirSync(new URL(`file://${outPath}`).pathname.replace(/\/[^/]+$/, ""), { recursive: true });
  const toSave = { saved_at: new Date().toISOString(), ...tokens };
  fs.writeFileSync(outPath, JSON.stringify(toSave, null, 2), "utf-8");
}

async function exchangeCode({ tokenUrl, accept, clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const body = formUrlEncoded({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  return await postForm(tokenUrl, body, accept);
}

async function main() {
  console.log("SCRIPT_START", new Date().toISOString());

  if (!fs.existsSync(DEFAULT_ENV)) {
    throw new Error(`.env not found at ${DEFAULT_ENV}`);
  }
  dotenv.config({ path: DEFAULT_ENV });

  const args = parseArgs(process.argv.slice(2));

  const clientId = mustEnv("SBER_CLIENT_ID");
  const clientSecret = mustEnv("SBER_CLIENT_SECRET");

  const redirectUri = String(args.redirect_uri || maybeEnv("SBER_REDIRECT_URI") || "");
  if (!redirectUri) {
    throw new Error(`Set SBER_REDIRECT_URI in .env or pass --redirect_uri`);
  }

  const authorizeBase = String(args.authorize_base || "https://sbi.sberbank.ru:9443");
  const tokenUrl = String(args.token_url || "https://fintech.sberbank.ru:9443/ic/sso/api/v2/oauth/token");
  const accept = String(args.accept || "application/json");

  const scope = String(args.scope || maybeEnv("SBER_SCOPE") || "");
  const state = String(args.state || crypto.randomUUID());

  const outFile = String(args.out || "/home/a/abokovsa/berserkclub.ru/MyBerserk/var/sber_tokens.json");

  const doStart = !!args.start;
  const doManual = !!args.manual;
  const doExchange = !!args.exchange;

  const listenHost = String(args.listen_host || "127.0.0.1");
  const listenPort = Number(args.listen_port || 8765);

  const usePkce = !!args.pkce;
  const pk = usePkce ? pkcePair() : null;

  // IMPORTANT: your fintech token endpoint requires mTLS
  setupTls(args);

  // Exchange-only mode: code provided manually
  if (doExchange) {
    if (!args.code || typeof args.code !== "string") {
      throw new Error(`--exchange requires --code "..."`);
    }

    const out = await exchangeCode({
      tokenUrl,
      accept,
      clientId,
      clientSecret,
      code: args.code,
      redirectUri,
      codeVerifier: pk?.verifier || (typeof args.code_verifier === "string" ? args.code_verifier : undefined),
    });

    console.log("== Response meta ==");
    console.log(JSON.stringify(out.meta, null, 2));

    if (out.json) {
      const masked = { ...out.json };
      if (masked.access_token) masked.access_token = mask(masked.access_token);
      if (masked.refresh_token) masked.refresh_token = mask(masked.refresh_token);
      if (masked.id_token) masked.id_token = mask(masked.id_token);

      console.log("\n== JSON (masked) ==");
      console.log(JSON.stringify(masked, null, 2));

      saveTokens(out.json, outFile);
      console.log(`\nSaved tokens to: ${outFile}`);
    } else {
      console.log("\n== Raw ==");
      console.log(out.raw || out.jose);
    }
    return;
  }

  const authorizeUrl = buildAuthorizeUrl({
    authorizeBase,
    clientId,
    redirectUri,
    scope,
    state,
    pkce: pk ? { challenge: pk.challenge, method: pk.method } : null,
  });

  console.log("== Authorize URL ==");
  console.log(authorizeUrl);

  if (usePkce) {
    console.log("\n== PKCE (save these) ==");
    console.log("code_verifier:", pk.verifier);
    console.log("code_challenge:", pk.challenge);
  }

  if (doManual && !doStart) {
    console.log("\nManual mode: open the URL, login/consent, copy `code` from redirect URL, then run:");
    console.log(`  node src/tools/sberFullAuth.mjs --exchange --code "PASTE_CODE" --redirect_uri "${redirectUri}" ...mTLS args...`);
    return;
  }

  if (!doStart) {
    console.log("\nNothing else to do. Use --start to run callback server, or --manual.");
    return;
  }

  // Callback server (works only if your browser reaches THIS machine's 127.0.0.1)
  const cbUrl = new URL(redirectUri);
  const cbPath = cbUrl.pathname || "/";

  console.log(`\n== Callback server ==`);
  console.log(`Listening on http://${listenHost}:${listenPort}${cbPath}`);

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);

      if (reqUrl.pathname !== cbPath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      const code = reqUrl.searchParams.get("code");
      const gotState = reqUrl.searchParams.get("state");
      const err = reqUrl.searchParams.get("error");
      const errDesc = reqUrl.searchParams.get("error_description");

      if (err) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Authorization error: ${err}\n${errDesc || ""}`);
        server.close();
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing `code` in query string.");
        return;
      }

      if (gotState && gotState !== state) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("State mismatch.");
        server.close();
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK. You can close this tab. Tokens are being fetched in terminal...");
      server.close();

      const out = await exchangeCode({
        tokenUrl,
        accept,
        clientId,
        clientSecret,
        code,
        redirectUri,
        codeVerifier: pk?.verifier || undefined,
      });

      console.log("\n== Token exchange result ==");
      console.log(JSON.stringify(out.meta, null, 2));

      if (out.json) {
        const masked = { ...out.json };
        if (masked.access_token) masked.access_token = mask(masked.access_token);
        if (masked.refresh_token) masked.refresh_token = mask(masked.refresh_token);
        if (masked.id_token) masked.id_token = mask(masked.id_token);

        console.log("\n== JSON (masked) ==");
        console.log(JSON.stringify(masked, null, 2));

        saveTokens(out.json, outFile);
        console.log(`\nSaved tokens to: ${outFile}`);
      } else {
        console.log("\n== Raw ==");
        console.log(out.raw || out.jose);
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal error");
      console.error("Callback server error:", e);
      server.close();
    }
  });

  server.listen(listenPort, listenHost, () => {
    console.log("\nOpen this URL in a browser to login/consent:");
    console.log(authorizeUrl);

    if (!args.no_open) {
      // best-effort
      tryOpenBrowser(authorizeUrl);
    }
  });
}

main().catch((e) => {
  console.error("ERROR:", e);
  if (e?.cause) console.error("CAUSE:", e.cause);
  process.exit(2);
});