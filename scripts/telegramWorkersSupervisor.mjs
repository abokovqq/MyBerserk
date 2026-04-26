#!/home/a/abokovsa/opt/node/bin/node

// /home/a/abokovsa/berserkclub.ru/MyBerserk/scripts/telegramWorkersSupervisor.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PROJECT_DIR = '/home/a/abokovsa/berserkclub.ru/MyBerserk';
const NODE_BIN = '/home/a/abokovsa/opt/node/bin/node';

const LOG_DIR = path.join(PROJECT_DIR, 'logs/telegram-workers');

const SUPERVISOR_LOG = path.join(LOG_DIR, 'supervisor.log');

const LOCK_DIR = '/tmp/myberserk_telegram_workers_supervisor.lock';

const RESTART_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 15_000;
const LOCK_REFRESH_INTERVAL_MS = 30_000;
const STALE_LOCK_MAX_AGE_MS = 180_000;

const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

const PROCESSES = [
  {
    name: 'telegram-poller',
    script: path.join(PROJECT_DIR, 'background/telegram/telegramPoller.mjs'),
    outLog: path.join(LOG_DIR, 'telegram-poller.out.log'),
    errLog: path.join(LOG_DIR, 'telegram-poller.err.log'),
  },
  {
    name: 'telegram-worker',
    script: path.join(PROJECT_DIR, 'background/telegram/telegramWorker.mjs'),
    outLog: path.join(LOG_DIR, 'telegram-worker.out.log'),
    errLog: path.join(LOG_DIR, 'telegram-worker.err.log'),
  },
];

const state = new Map();

let stopping = false;

fs.mkdirSync(LOG_DIR, { recursive: true });

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLogDateMs(line) {
  const match = String(line).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);

  if (!match) {
    return null;
  }

  const time = Date.parse(match[1]);

  if (Number.isNaN(time)) {
    return null;
  }

  return time;
}

function readRecentLogLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const cutoff = Date.now() - LOG_RETENTION_MS;

    const raw = fs.readFileSync(filePath, 'utf8');

    return raw
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .filter((line) => {
        const time = parseLogDateMs(line);

        if (time === null) {
          return false;
        }

        return time >= cutoff;
      });
  } catch {
    return [];
  }
}

function writeNewestTop(filePath, message) {
  const line = `${now()} ${message}`;
  const recentLines = readRecentLogLines(filePath);

  const nextContent = [line, ...recentLines].join('\n') + '\n';

  fs.writeFileSync(filePath, nextContent, 'utf8');
}

function log(message) {
  writeNewestTop(SUPERVISOR_LOG, message);

  if (process.stdout.isTTY) {
    console.log(`${now()} ${message}`);
  }
}

function logWorkerLine(filePath, processName, streamName, line) {
  const cleanLine = String(line).trimEnd();

  if (!cleanLine) {
    return;
  }

  writeNewestTop(filePath, `[${processName} ${streamName}] ${cleanLine}`);
}

function logWorkerChunk(filePath, processName, streamName, chunk) {
  const text = chunk.toString('utf8');

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    logWorkerLine(filePath, processName, streamName, line);
  }
}

function cleanupLogFile(filePath) {
  const recentLines = readRecentLogLines(filePath);
  const nextContent = recentLines.length > 0 ? recentLines.join('\n') + '\n' : '';

  fs.writeFileSync(filePath, nextContent, 'utf8');
}

function cleanupAllLogs() {
  cleanupLogFile(SUPERVISOR_LOG);

  for (const item of PROCESSES) {
    cleanupLogFile(item.outLog);
    cleanupLogFile(item.errLog);
  }
}

function assertExecutable(filePath) {
  fs.accessSync(filePath, fs.constants.X_OK);
}

function assertReadable(filePath) {
  fs.accessSync(filePath, fs.constants.R_OK);
}

function checkRequiredFiles() {
  assertExecutable(NODE_BIN);

  for (const item of PROCESSES) {
    assertReadable(item.script);
  }
}

function acquireLock() {
  try {
    fs.mkdirSync(LOCK_DIR);
    fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid));
    return true;
  } catch {
    try {
      const stat = fs.statSync(LOCK_DIR);
      const ageMs = Date.now() - stat.mtimeMs;

      if (ageMs > STALE_LOCK_MAX_AGE_MS) {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        fs.mkdirSync(LOCK_DIR);
        fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid));
        log('[LOCK] stale lock removed');
        return true;
      }
    } catch {
      // ignore
    }

    log('[LOCK] another supervisor instance is running, exit');
    return false;
  }
}

function refreshLock() {
  try {
    fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid));
    const nowDate = new Date();
    fs.utimesSync(LOCK_DIR, nowDate, nowDate);
  } catch {
    // ignore
  }
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function readCmdline(pid) {
  try {
    return fs
      .readFileSync(`/proc/${pid}/cmdline`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function readUid(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const uidLine = status.split('\n').find((line) => line.startsWith('Uid:'));

    if (!uidLine) {
      return null;
    }

    return Number(uidLine.trim().split(/\s+/)[1]);
  } catch {
    return null;
  }
}

function findProcessesByScript(scriptPath) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const result = [];

  const entries = fs
    .readdirSync('/proc', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));

  for (const entry of entries) {
    const pid = Number(entry.name);

    if (pid === process.pid) {
      continue;
    }

    if (currentUid !== null) {
      const uid = readUid(pid);

      if (uid !== currentUid) {
        continue;
      }
    }

    const args = readCmdline(pid);

    if (!args || args.length === 0) {
      continue;
    }

    if (args.includes(scriptPath)) {
      result.push({
        pid,
        args,
      });
    }
  }

  return result;
}

async function killPid(pid, name) {
  try {
    process.kill(pid, 'SIGTERM');
    log(`[KILL TERM] ${name} pid=${pid}`);
  } catch (error) {
    log(`[KILL TERM FAIL] ${name} pid=${pid} error=${error.message}`);
    return;
  }

  await sleep(1500);

  try {
    process.kill(pid, 0);
  } catch {
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
    log(`[KILL FORCE] ${name} pid=${pid}`);
  } catch (error) {
    log(`[KILL FORCE FAIL] ${name} pid=${pid} error=${error.message}`);
  }
}

async function killExistingProcesses(item) {
  const found = findProcessesByScript(item.script);

  for (const proc of found) {
    await killPid(proc.pid, item.name);
  }
}

function startChild(item) {
  const child = spawn(NODE_BIN, [item.script], {
    cwd: PROJECT_DIR,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: '/home/a/abokovsa/opt/node/bin:/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'production',
      TZ: 'Europe/Moscow',
    },
  });

  state.set(item.name, {
    child,
    pid: child.pid,
    restarting: false,
  });

  log(`[STARTED] ${item.name} pid=${child.pid}`);

  child.stdout.on('data', (chunk) => {
    logWorkerChunk(item.outLog, item.name, 'OUT', chunk);
  });

  child.stderr.on('data', (chunk) => {
    logWorkerChunk(item.errLog, item.name, 'ERR', chunk);
  });

  child.on('exit', async (code, signal) => {
    log(`[EXIT] ${item.name} pid=${child.pid} code=${code} signal=${signal}`);

    const current = state.get(item.name);

    if (current && current.pid === child.pid) {
      state.delete(item.name);
    }

    if (stopping) {
      return;
    }

    log(`[RESTART SCHEDULED] ${item.name} in ${RESTART_DELAY_MS}ms`);

    await sleep(RESTART_DELAY_MS);

    if (!stopping) {
      await restartItem(item, 'exit');
    }
  });

  child.on('error', async (error) => {
    log(`[ERROR] ${item.name} error=${error.stack || error.message}`);

    if (!stopping) {
      await restartItem(item, 'error');
    }
  });
}

async function restartItem(item, reason) {
  const current = state.get(item.name);

  if (current && current.restarting) {
    log(`[RESTART SKIP] ${item.name} already restarting`);
    return;
  }

  if (current) {
    current.restarting = true;
  }

  log(`[RESTART] ${item.name} reason=${reason}`);

  await killExistingProcesses(item);

  if (!stopping) {
    startChild(item);
  }
}

async function ensureNoDuplicates(item) {
  const found = findProcessesByScript(item.script);
  const current = state.get(item.name);

  if (!current) {
    log(`[CHECK] ${item.name} no supervised child, restart`);
    await restartItem(item, 'no-supervised-child');
    return;
  }

  if (found.length === 1 && found[0].pid === current.pid) {
    log(`[CHECK OK] ${item.name} pid=${current.pid}`);
    return;
  }

  if (found.length === 0) {
    log(`[CHECK FAIL] ${item.name} supervised pid=${current.pid} not found, restart`);
    await restartItem(item, 'missing-process');
    return;
  }

  log(
    `[CHECK DUPLICATE] ${item.name} supervised=${current.pid} found=${found
      .map((proc) => proc.pid)
      .join(',')}`,
  );

  await restartItem(item, 'duplicate-processes');
}

async function startAll() {
  for (const item of PROCESSES) {
    await killExistingProcesses(item);
    startChild(item);
  }
}

async function stopAll() {
  stopping = true;

  log('[SUPERVISOR] stopping');

  for (const item of PROCESSES) {
    const found = findProcessesByScript(item.script);

    for (const proc of found) {
      await killPid(proc.pid, item.name);
    }
  }

  releaseLock();

  log('[SUPERVISOR] stopped');
}

async function main() {
  if (!acquireLock()) {
    return;
  }

  checkRequiredFiles();

  cleanupAllLogs();

  log('[SUPERVISOR] started');

  await startAll();

  setInterval(() => {
    refreshLock();
    cleanupAllLogs();
  }, LOCK_REFRESH_INTERVAL_MS);

  setInterval(async () => {
    if (stopping) {
      return;
    }

    refreshLock();

    for (const item of PROCESSES) {
      await ensureNoDuplicates(item);
    }
  }, CHECK_INTERVAL_MS);
}

process.on('SIGTERM', async () => {
  await stopAll();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await stopAll();
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  log(`[FATAL uncaughtException] ${error.stack || error.message}`);
  await stopAll();
  process.exit(1);
});

process.on('unhandledRejection', async (error) => {
  log(`[FATAL unhandledRejection] ${error.stack || error}`);
  await stopAll();
  process.exit(1);
});

main().catch(async (error) => {
  log(`[FATAL main] ${error.stack || error.message}`);
  await stopAll();
  process.exit(1);
});