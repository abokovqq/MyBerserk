// src/utils/report/pdfReport.mjs
import PDFDocument from 'pdfkit';
import fs from 'fs';

export async function makePdfFromText(text, outPath, title = 'Отчёт') {
  return new Promise(resolve => {
    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(outPath);

    doc.pipe(stream);
    doc.font('Courier').fontSize(9);
    doc.text(title, { align: 'center' });
    doc.moveDown();
    doc.text(text);
    doc.end();

    stream.on('finish', resolve);
  });
}
