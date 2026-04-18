// src/utils/report/htmlReport.mjs

export function makeHtmlFromText(text, title = 'Отчёт') {
  const esc = s =>
    s.replace(/&/g,'&amp;')
     .replace(/</g,'&lt;')
     .replace(/>/g,'&gt;');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  body {
    font-family: monospace;
    background: #fff;
    color: #000;
    padding: 16px;
  }
  pre {
    white-space: pre-wrap;
    font-size: 13px;
    line-height: 1.35;
  }
</style>
</head>
<body>
<pre>${esc(text)}</pre>
</body>
</html>`;
}
