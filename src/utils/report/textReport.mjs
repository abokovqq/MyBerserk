// src/utils/report/textReport.mjs

export function createTextReport() {
  const lines = [];

  function out(line = '') {
    lines.push(line);
    console.log(line); // консоль всегда работает
  }

  function getText() {
    return lines.join('\n');
  }

  return { out, getText };
}
