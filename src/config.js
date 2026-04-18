import 'dotenv/config';

export const CHATS = {
  MAIN: { id: process.env.TG_CHAT_MAIN,  name: process.env.TG_CHAT_MAIN_NAME  || 'MAIN'  },
  CLEAN:{ id: process.env.TG_CHAT_CLEAN, name: process.env.TG_CHAT_CLEAN_NAME || 'CLEAN' },
  TEST: { id: process.env.TG_CHAT_TEST,  name: process.env.TG_CHAT_TEST_NAME  || 'TEST'  },
};

export const TEST_MODE = (process.env.TG_TEST_MODE || 'false').toLowerCase() === 'true';
export const FORCE = (process.env.TG_FORCE_CHAT || '').toUpperCase();

/** Вернёт ID чата с учётом тестового режима и форса */
export function chat(key = 'MAIN') {
  if (FORCE && CHATS[FORCE]?.id) return CHATS[FORCE].id;     // приоритет форса
  if (TEST_MODE && CHATS.TEST?.id) return CHATS.TEST.id;      // глобальный тестовый режим
  const k = String(key).toUpperCase();
  return CHATS[k]?.id || CHATS.MAIN?.id || CHATS.TEST?.id;
}

/** Умолчание — основной чат */
export function defaultChat() { return chat('MAIN'); }