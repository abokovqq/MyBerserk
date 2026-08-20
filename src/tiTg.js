import './env.js';

import fs from 'node:fs/promises';
import path from 'node:path';


const TOKEN = process.env.TI_BOT_TOKEN;

if (!TOKEN) {
  throw new Error('TI_BOT_TOKEN is not set');
}

const API = `https://api.telegram.org/bot${TOKEN}`;


// ==================================================
// TELEGRAM API
// ==================================================

export async function tiTg(
  method,
  payload = {}
) {
  const params =
    new URLSearchParams();


  for (
    const [key, value]
    of Object.entries(payload)
  ) {
    if (
      value === undefined ||
      value === null
    ) {
      continue;
    }


    if (
      typeof value === 'object'
    ) {
      params.append(
        key,
        JSON.stringify(value)
      );
    } else {
      params.append(
        key,
        String(value)
      );
    }
  }


  const response =
    await fetch(
      `${API}/${method}`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded'
        },

        body:
          params.toString()
      }
    );


  const data =
    await response.json();


  if (
    !response.ok ||
    !data.ok
  ) {
    throw new Error(
      `TI TG ${method} ${response.status}: ` +
      JSON.stringify(data)
    );
  }


  return data.result;
}


// ==================================================
// SEND MESSAGE
// ==================================================

export async function tiSend(
  chat_id,
  text,
  extra = {}
) {
  return tiTg(
    'sendMessage',
    {
      chat_id,
      text,

      parse_mode:
        'HTML',

      disable_web_page_preview:
        true,

      ...extra
    }
  );
}


// ==================================================
// SEND PHOTO
// ==================================================

export async function tiSendPhoto(
  chat_id,
  filePath,
  caption = '',
  extra = {}
) {
  const file =
    await fs.readFile(
      filePath
    );


  const form =
    new FormData();


  form.append(
    'chat_id',
    String(chat_id)
  );


  if (caption) {
    form.append(
      'caption',
      caption
    );

    form.append(
      'parse_mode',
      'HTML'
    );
  }


  for (
    const [key, value]
    of Object.entries(extra)
  ) {
    if (
      value === undefined ||
      value === null
    ) {
      continue;
    }


    form.append(
      key,

      typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
    );
  }


  form.append(
    'photo',

    new Blob(
      [file],
      {
        type:
          'image/png'
      }
    ),

    path.basename(
      filePath
    )
  );


  const response =
    await fetch(
      `${API}/sendPhoto`,
      {
        method: 'POST',
        body: form
      }
    );


  const data =
    await response.json();


  if (
    !response.ok ||
    !data.ok
  ) {
    throw new Error(
      `TI TG sendPhoto ${response.status}: ` +
      JSON.stringify(data)
    );
  }


  return data.result;
}