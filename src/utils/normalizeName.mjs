// src/utils/normalizeName.mjs

function toHalfWidth(str) {
  return str
    .replace(/[\uFF01-\uFF5E]/g, ch =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
    )
    .replace(/\u3000/g, ' ');
}

/**
 * normalizeName(raw, maxLen)
 * raw    — исходный ник/имя
 * maxLen — если число > 0, обрежем до этой длины
 *          если не передано или 0/undefined → НЕ режем
 */
export function normalizeName(raw, maxLen) {
  if (!raw) return '';

  let s = toHalfWidth(String(raw));
  s = s.replace(/\s+/g, ' ').trim();

  // "D e a D" → "Dead"
  // добавили Ёё в класс
  const spacedSingleChars = /^(?:[A-Za-zА-Яа-яЁё0-9]\s+)+[A-Za-zА-Яа-яЁё0-9]$/;
  if (spacedSingleChars.test(s)) {
    s = s.replace(/\s+/g, '');
  }

  // убрать лишние символы — тоже добавили Ёё
  s = s.replace(/[^A-Za-zА-Яа-яЁё0-9 ]+/g, '').trim();
  s = s.replace(/\s+/g, '');

  if (!s) return '';

  // нормализация регистра — через русскую локаль, чтобы с ё было ок
  s = s.charAt(0).toLocaleUpperCase('ru-RU') + s.slice(1).toLocaleLowerCase('ru-RU');

  // обрезаем только если явно попросили
  if (typeof maxLen === 'number' && maxLen > 0 && s.length > maxLen) {
    s = s.slice(0, maxLen);
  }

  return s;
}
