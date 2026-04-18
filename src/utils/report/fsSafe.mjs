// src/utils/report/fsSafe.mjs
import fs from 'fs';

export async function safeUnlink(path) {
  if (!path) return;
  try {
    await fs.promises.unlink(path);
  } catch {}
}

export async function safeWriteFile(path, data, enc = 'utf8') {
  if (!path) throw new Error('safeWriteFile: empty path');
  await fs.promises.writeFile(path, data, enc);
}
