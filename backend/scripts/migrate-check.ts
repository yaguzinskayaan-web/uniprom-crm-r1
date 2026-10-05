import { readFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.js';
import { config } from '../src/config.js';

/**
 * A43: проверка миграции копии действующей базы данных.
 *
 * Скрипт не переносит данные сам — это делает `backup.ts restore`. Он отвечает на
 * другой вопрос: после переноса сохранены ли статусы, условия постоплаты,
 * закрывающие документы и история. Сравниваются количества и контрольные суммы
 * до и после, а результат печатается в виде отчёта.
 *
 * Использование:
 *   npx tsx scripts/migrate-check.ts before <путь-к-исходной-БД>
 *   npx tsx scripts/migrate-check.ts after  <путь-к-копии-БД>
 *   npx tsx scripts/migrate-check.ts compare before.json after.json
 *
 * Первый шаг — снимок состояния действующей базы, второй — то же самое для копии
 * после миграции, третий — сравнение отчётов.
 */

interface Section {
  name: string;
  count: number;
  /** Сумма значимых полей: позволяет заметить потерю содержимого при том же числе строк. */
  digest: string;
}

async function snapshot(): Promise<Section[]> {
  const sections: Section[] = [];

  const apps = await prisma.application.findMany({
    select: { id: true, stage: true, complexity: true, versionNo: true, closedAt: true },
    orderBy: { id: 'asc' },
  });
  sections.push({
    name: 'applications:stage',
    count: apps.length,
    digest: digestOf(apps.map((a) => `${a.id}|${a.stage}|${a.complexity}|${a.versionNo}|${a.closedAt?.toISOString() ?? ''}`)),
  });

  const commercials = await prisma.applicationCommercial.findMany({
    select: {
      applicationId: true,
      paymentTerms: true,
      paymentSchedule: true,
      deliveryTerms: true,
      basisCurrency: true,
      contractNumber: true,
      contractStatus: true,
      versionNo: true,
    },
    orderBy: { applicationId: 'asc' },
  });
  sections.push({
    name: 'commercials:terms',
    count: commercials.length,
    digest: digestOf(
      commercials.map(
        (c) =>
          `${c.applicationId}|${c.paymentTerms}|${c.paymentSchedule}|${c.deliveryTerms}|${c.basisCurrency}|${c.contractNumber ?? ''}|${c.contractStatus}|v${c.versionNo}`,
      ),
    ),
  });

  const documents = await prisma.closingDocument.findMany({
    select: { applicationId: true, docType: true, status: true, number: true, isRequired: true },
    orderBy: { id: 'asc' },
  });
  sections.push({
    name: 'closing-documents',
    count: documents.length,
    digest: digestOf(documents.map((d) => `${d.applicationId}|${d.docType}|${d.status}|${d.number ?? ''}|req=${d.isRequired}`)),
  });

  const audit = await prisma.auditEvent.count();
  sections.push({ name: 'audit-events', count: audit, digest: digestOf([String(audit)]) });

  const activities = await prisma.crmActivity.count();
  sections.push({ name: 'activities', count: activities, digest: digestOf([String(activities)]) });

  const releases = await prisma.productionRelease.count();
  sections.push({ name: 'production-releases', count: releases, digest: digestOf([String(releases)]) });

  const invoices = await prisma.invoice.findMany({ select: { extId: true, status: true, amount: true, currency: true }, orderBy: { extId: 'asc' } });
  sections.push({
    name: 'invoices',
    count: invoices.length,
    digest: digestOf(invoices.map((i) => `${i.extId}|${i.status}|${i.amount}|${i.currency}`)),
  });

  const shipments = await prisma.shipment.count();
  sections.push({ name: 'shipments', count: shipments, digest: digestOf([String(shipments)]) });

  const quotes = await prisma.crmQuote.findMany({ select: { versionNo: true, status: true, approvalStatus: true }, orderBy: { versionNo: 'asc' } });
  sections.push({
    name: 'quotes',
    count: quotes.length,
    digest: digestOf(quotes.map((q) => `${q.versionNo}|${q.status}|${q.approvalStatus}`)),
  });

  return sections;
}

function digestOf(parts: string[]): string {
  return simpleHash(parts.join('\n'));
}

/** FNV-1a: достаточно для контроля совпадения, криптостойкость не требуется. */
function simpleHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function compare(before: Section[], after: Section[]): number {
  const afterByName = new Map(after.map((s) => [s.name, s]));
  let problems = 0;
  for (const b of before) {
    const a = afterByName.get(b.name);
    if (!a) {
      process.stdout.write(`ПРОБЛЕМА  ${b.name}: раздел отсутствует в копии\n`);
      problems += 1;
      continue;
    }
    if (a.count < b.count) {
      process.stdout.write(`ПРОБЛЕМА  ${b.name}: записей стало меньше ${b.count} → ${a.count}\n`);
      problems += 1;
    } else if (a.count > b.count) {
      process.stdout.write(`ОК        ${b.name}: записей больше ${b.count} → ${a.count} (допустимо)\n`);
    }
    if (a.digest !== b.digest) {
      process.stdout.write(`ПРОБЛЕМА  ${b.name}: содержимое изменилось (${b.digest} → ${a.digest})\n`);
      problems += 1;
    } else {
      process.stdout.write(`ОК        ${b.name}: ${b.count} записей, содержимое совпадает\n`);
    }
  }
  return problems;
}

const [command, file] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command === 'before' || command === 'after') {
    const sections = await snapshot();
    const payload = { at: new Date().toISOString(), databaseUrl: config.databaseUrl, sections };
    if (file) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
      process.stdout.write(`Снимок сохранён: ${file}\n`);
    }
    for (const s of sections) process.stdout.write(`${s.name.padEnd(24)} ${s.count}\n`);
    return;
  }

  if (command === 'compare') {
    if (!file) {
      process.stderr.write('Укажите файл «после»: npx tsx scripts/migrate-check.ts compare after.json\n');
      process.exit(1);
    }
    const after = JSON.parse(readFileSync(file, 'utf8')) as { sections: Section[] };
    const beforeFile = process.argv[4];
    const before = beforeFile
      ? (JSON.parse(readFileSync(beforeFile, 'utf8')) as { sections: Section[] })
      : { sections: [] };
    const problems = compare(before.sections, after.sections);
    process.stdout.write(problems === 0 ? 'МИГРАЦИЯ КОРРЕКТНА\n' : `НАЙДЕНО РАСХОЖДЕНИЙ: ${problems}\n`);
    process.exit(problems === 0 ? 0 : 1);
  }

  process.stderr.write('Укажите команду: before | after | compare\n');
  process.exit(1);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err: unknown) => {
    process.stderr.write(`ОШИБКА: ${err instanceof Error ? err.message : String(err)}\n`);
    await prisma.$disconnect();
    process.exit(1);
  });