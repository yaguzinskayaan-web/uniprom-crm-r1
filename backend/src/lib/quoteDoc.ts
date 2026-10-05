import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';

/**
 * Генерация документа коммерческого предложения (QUOTE-01).
 *
 * Требования, зафиксированные в реализации:
 *  - документ содержит номер и версию, реквизиты клиента, позиции, суммы,
 *    условия оплаты/поставки, срок действия и условия заключения КО (ENG-06);
 *  - в PDF попадает только содержимое версии: подмена файла согласованной
 *    версии запрещена на уровне сервиса (QUOTE-03);
 *  - шрифт с кириллицей подключается явно: стандартные 14 шрифтов PDF
 *    не содержат кириллицу, поэтому используется TTF из окружения.
 */

const BRAND = '#1C5CFF';
const INK = '#242424';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';

const FONT_CANDIDATES = [
  'arial.ttf',
  'segoeui.ttf',
  'calibri.ttf',
  'verdana.ttf',
  'tahoma.ttf',
  'times.ttf',
];

let cached: { regular?: string; bold?: string } | null = null;

/** Возвращает пути к TTF с поддержкой кириллицы либо undefined. */
function resolveFonts(): { regular?: string; bold?: string } {
  if (cached) return cached;
  const explicitRegular = process.env.FONT_REGULAR_PATH;
  const explicitBold = process.env.FONT_BOLD_PATH;
  const regular =
    (explicitRegular && existsSync(explicitRegular) ? explicitRegular : undefined) ??
    FONT_CANDIDATES.map((f) => join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts', f)).find((p) => existsSync(p));
  const bold =
    (explicitBold && existsSync(explicitBold) ? explicitBold : undefined) ??
    [join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts', 'arialbd.ttf'), regular].find(
      (p): p is string => Boolean(p) && existsSync(p as string),
    );
  cached = { regular, bold };
  return cached;
}

export function money(value: number, currency: string): string {
  const digits = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const symbol = currency === 'RUB' ? 'руб.' : currency;
  return `${digits} ${symbol}`;
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

export interface QuoteDocLine {
  name: string;
  quantity: number;
  unit: string;
  price: number;
  amount: number;
}

export interface QuoteDocInput {
  quote: {
    number: string;
    versionNo: number;
    amount: number;
    currency: string;
    discountPct: number;
    taxAttribute: string;
    validUntil: Date | null;
    leadTimeDays: number | null;
    deliveryTerms: string | null;
    paymentTermsNote: string | null;
    technicalNotes: string | null;
    conditionsNote: string | null;
  };
  application: {
    number: string;
    complexity: string;
    organization: { name: string; fullName: string | null; inn: string | null; kpp: string | null; address: string | null };
    contact: { fullName: string; position: string | null; phone: string | null; email: string | null } | null;
  };
  lines: QuoteDocLine[];
  conclusionConditions: string | null;
  author: string;
}

const TAX_LABELS: Record<string, string> = {
  NDS_20: 'в том числе НДС 20%',
  NDS_10: 'в том числе НДС 10%',
  NDS_0: 'НДС 0%',
  NO_NDS: 'Без НДС',
};

const COMPLEXITY_LABELS: Record<string, string> = {
  NEEDS_CLASSIFICATION: 'Требуется классификация',
  STANDARD: 'Стандартное изделие',
  MODIFIED: 'Модифицированное исполнение',
  CUSTOM: 'Нестандартное изделие',
};

export async function renderQuoteDocument(input: QuoteDocInput): Promise<{ pdf: Buffer }> {
  const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: {
    Title: `${input.quote.number} — коммерческое предложение`,
    Author: 'ООО «Унипром»',
    Subject: `Заявка ${input.application.number}`,
  } });

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const fonts = resolveFonts();
  if (fonts.regular) {
    doc.registerFont('body', fonts.regular);
    doc.registerFont('body-bold', fonts.bold ?? fonts.regular);
  } else {
    doc.registerFont('body', 'Helvetica');
    doc.registerFont('body-bold', 'Helvetica-Bold');
  }

  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const contentWidth = pageRight - pageLeft;

  // ── Шапка
  doc.rect(pageLeft, doc.y, contentWidth, 4).fill(BRAND);
  doc.moveDown(0.8);
  doc.font('body-bold').fontSize(16).fillColor(INK).text('ООО «Унипром»', { continued: false });
  doc
    .font('body')
    .fontSize(9)
    .fillColor(MUTED)
    .text('Коммерческое предложение', { continued: false })
    .text(`Заявка № ${input.application.number}`, { continued: false });
  doc.moveDown(0.6);

  const titleY = doc.y;
  doc.font('body-bold').fontSize(14).fillColor(INK).text(input.quote.number, pageLeft, titleY, {
    width: contentWidth * 0.6,
    continued: false,
  });
  doc
    .font('body')
    .fontSize(10)
    .fillColor(MUTED)
    .text(`Версия ${input.quote.versionNo}`, pageLeft, titleY + 2, { width: contentWidth * 0.6, align: 'right' });
  doc
    .font('body')
    .fontSize(9)
    .fillColor(MUTED)
    .text(`Сформировано: ${formatDate(new Date())}`, pageLeft, titleY + 18, {
      width: contentWidth * 0.6,
      align: 'right',
    });
  doc.y = Math.max(doc.y, titleY + 34);
  doc.moveDown(0.4);

  // ── Клиент
  const clientTop = doc.y;
  doc.rect(pageLeft, clientTop, contentWidth, 0.5).fill(LINE);
  doc.moveDown(0.4);
  doc.font('body-bold').fontSize(10).fillColor(INK).text('Клиент');
  doc
    .font('body')
    .fontSize(10)
    .fillColor(INK)
    .text(input.application.organization.fullName || input.application.organization.name);
  const innLine = [input.application.organization.inn && `ИНН ${input.application.organization.inn}`]
    .concat(input.application.organization.kpp ? [`КПП ${input.application.organization.kpp}`] : [])
    .filter(Boolean)
    .join(', ');
  if (innLine) doc.text(innLine);
  if (input.application.organization.address) doc.text(input.application.organization.address);
  if (input.application.contact) {
    const c = input.application.contact;
    const parts = [c.position, c.fullName, c.phone, c.email].filter(Boolean).join(', ');
    doc.text(`Контактное лицо: ${parts}`);
  }
  doc
    .font('body')
    .fontSize(9)
    .fillColor(MUTED)
    .text(`Категория изделия: ${COMPLEXITY_LABELS[input.application.complexity] ?? input.application.complexity}`);
  doc.moveDown(0.8);

  // ── Позиции
  const columns = [
    { key: 'n', title: '№', width: 26, align: 'left' as const },
    { key: 'name', title: 'Наименование', width: 250, align: 'left' as const },
    { key: 'qty', title: 'Кол-во', width: 60, align: 'right' as const },
    { key: 'unit', title: 'Ед.', width: 50, align: 'left' as const },
    { key: 'price', title: 'Цена', width: 90, align: 'right' as const },
    { key: 'amount', title: 'Сумма', width: 100, align: 'right' as const },
  ];
  const totalTableWidth = columns.reduce((s, c) => s + c.width, 0);

  function drawHeader() {
    const y = doc.y;
    doc.rect(pageLeft, y, totalTableWidth, 20).fill('#F7F7F7');
    doc.font('body-bold').fontSize(9).fillColor(INK);
    let x = pageLeft;
    for (const c of columns) {
      doc.text(c.title, x + 4, y + 6, { width: c.width - 8, align: c.align, lineBreak: false });
      x += c.width;
    }
    doc.y = y + 20;
  }

  drawHeader();

  input.lines.forEach((line, index) => {
    const rowTop = doc.y;
    const cells: Record<string, string> = {
      n: String(index + 1),
      name: line.name,
      qty: new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(line.quantity),
      unit: line.unit,
      price: money(line.price, input.quote.currency),
      amount: money(line.amount, input.quote.currency),
    };
    doc.font('body').fontSize(9).fillColor(INK);
    let x = pageLeft;
    let maxHeight = 0;
    for (const c of columns) {
      const h = doc.heightOfString(cells[c.key] ?? '', { width: c.width - 8 });
      if (h > maxHeight) maxHeight = h;
      doc.text(cells[c.key] ?? '', x + 4, rowTop + 5, { width: c.width - 8, align: c.align });
      x += c.width;
    }
    doc.y = rowTop + Math.max(20, maxHeight + 10);
    doc.moveTo(pageLeft, doc.y).lineTo(pageLeft + totalTableWidth, doc.y).strokeColor(LINE).lineWidth(0.5).stroke();
  });

  doc.moveDown(0.6);

  // ── Итог
  const totalTop = doc.y;
  doc.font('body-bold').fontSize(11).fillColor(INK);
  doc.text('Итого:', pageLeft, totalTop, { width: totalTableWidth - 220, continued: false });
  doc.text(money(input.quote.amount, input.quote.currency), pageLeft + totalTableWidth - 210, totalTop, {
    width: 210,
    align: 'right',
  });
  doc.moveDown(0.2);
  if (input.quote.discountPct) {
    doc
      .font('body')
      .fontSize(9)
      .fillColor(MUTED)
      .text(`Применена скидка: ${input.quote.discountPct}%`, { align: 'right' });
  }
  doc
    .font('body')
    .fontSize(9)
    .fillColor(MUTED)
    .text(TAX_LABELS[input.quote.taxAttribute] ?? input.quote.taxAttribute, { align: 'right' });
  doc.moveDown(0.8);

  // ── Условия
  const block = (title: string, body: string | null | undefined) => {
    if (!body) return;
    doc.font('body-bold').fontSize(10).fillColor(INK).text(title);
    doc.font('body').fontSize(9).fillColor(INK).text(body, { align: 'left' });
    doc.moveDown(0.4);
  };

  block('Срок действия', `Предложение действительно до ${formatDate(input.quote.validUntil)}.`);
  block('Срок изготовления', input.quote.leadTimeDays ? `${input.quote.leadTimeDays} календарных дней с момента оплаты и подписания договора.` : null);
  block('Условия поставки', input.quote.deliveryTerms);
  block('Условия оплаты', input.quote.paymentTermsNote);
  block('Технические условия', input.quote.technicalNotes);
  block('Условия заключения конструкторского отдела', input.conclusionConditions);
  block('Прочие условия', input.quote.conditionsNote);

  doc
    .font('body')
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      'Настоящее коммерческое предложение не является публичной офертой. Конкретные условия определяются договором и спецификацией.',
      { align: 'left' },
    );

  // ── Колонтитулы на всех страницах
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const footerY = doc.page.height - 34;
    doc.moveTo(pageLeft, footerY - 8).lineTo(pageRight, footerY - 8).strokeColor(LINE).lineWidth(0.5).stroke();
    doc
      .font('body')
      .fontSize(8)
      .fillColor(MUTED)
      .text(`${input.quote.number} · версия ${input.quote.versionNo} · подготовил(а): ${input.author}`, pageLeft, footerY, {
        width: contentWidth * 0.75,
        lineBreak: false,
      });
    doc.text(`Стр. ${i + 1} из ${range.count}`, pageLeft + contentWidth * 0.75, footerY, {
      width: contentWidth * 0.25,
      align: 'right',
      lineBreak: false,
    });
  }

  doc.end();
  return { pdf: await done };
}
