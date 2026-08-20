import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fileURLToPath
} from 'node:url';


const __filename =
  fileURLToPath(
    import.meta.url
  );


const __dirname =
  path.dirname(
    __filename
  );


const PROJECT_DIR =
  path.resolve(
    __dirname,
    '..'
  );


const TMP_DIR =
  path.join(
    PROJECT_DIR,
    'tmp'
  );


const ADMIN_MODE_FILE =
  path.join(
    TMP_DIR,
    'ti-admin-mode.flag'
  );


// ==================================================
// STATUS
// ==================================================

export async function isTiAdminMode() {

  try {

    await fs.access(
      ADMIN_MODE_FILE
    );


    return true;

  } catch {

    return false;

  }

}


// ==================================================
// ENABLE
// ==================================================

export async function enableTiAdminMode(
  source = 'console'
) {

  await fs.mkdir(
    TMP_DIR,
    {
      recursive: true
    }
  );


  const text =
    [
      'TI ADMIN MODE',
      `enabled_at=${new Date().toISOString()}`,
      `source=${source}`
    ].join('\n');


  await fs.writeFile(
    ADMIN_MODE_FILE,
    `${text}\n`,
    'utf8'
  );


  return true;

}


// ==================================================
// DISABLE
// ==================================================

export async function disableTiAdminMode() {

  try {

    await fs.unlink(
      ADMIN_MODE_FILE
    );

  } catch (error) {

    if (
      error?.code !== 'ENOENT'
    ) {

      throw error;

    }

  }


  return false;

}


// ==================================================
// PATH
// ==================================================

export function getTiAdminModeFile() {

  return ADMIN_MODE_FILE;

}