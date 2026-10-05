import { prisma } from '../lib/prisma.js';
import { ErrorCode, badRequest, notFound } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { P, assertPermission } from '../domain/rbac.js';
import type { Principal } from '../domain/scope.js';
import { jparse, sha256 } from '../lib/query.js';
import { createApplication, normalizeInn, normalizePhone } from './applications.js';

/**
 * Импорт Excel/CSV (§5.3, IMP-01..04).
 *
 * Пакет: сопоставление колонок → предпросмотр → подтверждение. Ошибки
 * указываются строкой, полем, причиной и способом исправления; частичная
 * загрузка группы запрещена (IMP-03). Повтор определяется по источнику,
 * внешнему идентификатору и отпечатку пакета; повторная загрузка ничего не
 * перезаписывает. Лимит пакета R1 — 5 000 строк (IMP-04).
 */

export const IMPORT_ROW_LIMIT = 5000;

export type ImportSource = 'EXCEL' | 'CSV';

export interface ImportBatchRow {
  /** Идентификатор группы заявки из шаблона: строки с одним значением образуют одну заявку. */
  groupId: string;
  externalNumber?: string;
  organizationName: string;
  inn?: string;
  kpp?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  lineId?: string;
  lineName: string;
  quantity: number;
  unit?: string;
  price?: number;
  rowNo: number;
}

export interface ImportMapping {
  groupId: string;
  organizationName: string;
  externalNumber?: string;
  inn?: string;
  kpp?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  lineId?: string;
  lineName: string;
  quantity: string;
  unit?: string;
  price?: string;
}

export interface RowIssue {
  rowNo: number;
  field: string;
  reason: string;
  fix: string;
}

export async function createBatch(input: {
  source: ImportSource;
  fileName: string;
  checksum: string;
  mapping: ImportMapping;
  rows: ImportBatchRow[];
  correlationId: string;
  actor: Principal;
}) {
  assertPermission(input.actor.role as never, P.IMPORT_RUN);
  if (input.rows.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Файл не содержит строк для импорта');
  }
  if (input.rows.length > IMPORT_ROW_LIMIT) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, `Пакет до ${IMPORT_ROW_LIMIT} строк: разделите файл на части`, {
      details: { rows: input.rows.length, limit: IMPORT_ROW_LIMIT },
    });
  }

  const issues: RowIssue[] = [];
  const groups = new Map<string, ImportBatchRow[]>();
  for (const row of input.rows) {
    const problems: RowIssue[] = [];
    if (!row.groupId?.trim()) problems.push({ rowNo: row.rowNo, field: 'groupId', reason: 'Не задан идентификатор группы', fix: 'Укажите идентификатор группы заявки' });
    if (!row.organizationName?.trim()) problems.push({ rowNo: row.rowNo, field: 'organizationName', reason: 'Не указано наименование контрагента', fix: 'Укажите наименование контрагента' });
    if (!row.lineName?.trim()) problems.push({ rowNo: row.rowNo, field: 'lineName', reason: 'Не указана номенклатура позиции', fix: 'Укажите наименование позиции' });
    if (!Number.isFinite(row.quantity) || row.quantity <= 0) {
      problems.push({ rowNo: row.rowNo, field: 'quantity', reason: 'Количество должно быть положительным числом', fix: 'Укажите количество больше нуля' });
    }
    // Технические поля и суммы проверяются как при ручном вводе (IMP-02)
    if (row.inn && !/^\d{10}(\d{2})?$/.test(normalizeInn(row.inn))) {
      problems.push({ rowNo: row.rowNo, field: 'inn', reason: 'ИНН имеет неверный формат', fix: 'Укажите ИНН из 10 или 12 цифр' });
    }
    if (row.contactPhone && normalizePhone(row.contactPhone).length < 10) {
      problems.push({ rowNo: row.rowNo, field: 'contactPhone', reason: 'Телефон имеет неверный формат', fix: 'Укажите телефон в формате +7 900 000-00-00' });
    }
    if (row.price !== undefined && (!Number.isFinite(row.price) || row.price < 0)) {
      problems.push({ rowNo: row.rowNo, field: 'price', reason: 'Цена должна быть неотрицательным числом', fix: 'Укажите цену числом ≥ 0' });
    }
    if (problems.length) {
      issues.push(...problems);
      continue;
    }
    const key = row.groupId.trim();
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }

  // Группа с любой ошибочной строкой исключается целиком: половина заявки не импортируется (IMP-03)
  const badGroups = new Set(issues.map((i) => input.rows.find((r) => r.rowNo === i.rowNo)?.groupId?.trim()).filter(Boolean) as string[]);
  for (const gid of badGroups) groups.delete(gid);

  // A09: принятый пакет повторно не загружается. Ключ идемпотентности заявок
  // строится по содержимому группы, а не по идентификатору пакета, поэтому
  // повторная загрузка того же файла не создаёт ни заявок, ни позиций.
  const checksum = sha256(`${input.source}:${input.checksum}:${JSON.stringify(input.mapping)}`);
  const duplicateOf = await prisma.importBatch.findFirst({
    where: { sourceKey: input.source, fileChecksum: checksum, status: { in: ['VALIDATED', 'COMMITTED'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, status: true },
  });

  const batch = await prisma.importBatch.create({
    data: {
      sourceKey: input.source,
      fileName: input.fileName,
      fileChecksum: checksum,
      externalBatchId: duplicateOf ? duplicateOf.id : null,
      status: 'VALIDATED',
      totalRows: input.rows.length,
      validGroups: groups.size,
      errorGroups: badGroups.size,
      errors: JSON.stringify(issues),
      mapping: JSON.stringify(input.mapping),
      rows: JSON.stringify(input.rows),
      createdById: input.actor.id,
    },
  });

  const preview = [...groups.entries()].map(([groupId, rows]) => ({
    groupId,
    rows: rows.length,
    organizationName: rows[0]!.organizationName,
    inn: rows[0]!.inn ?? null,
    totalQty: rows.reduce((s, r) => s + r.quantity, 0),
    totalAmount: rows.reduce((s, r) => s + (r.price ?? 0) * r.quantity, 0),
    // Совпадения показываются пользователю; при повторе содержимого заявка не дублируется (A09)
    duplicateHint: rows[0]!.externalNumber ? `внешний номер ${rows[0]!.externalNumber}` : null,
  }));

  await audit(prisma, {
    actor: input.actor,
    actionCode: duplicateOf ? AuditAction.IMPORT_DUPLICATE_BLOCKED : AuditAction.IMPORT_VALIDATE,
    entityType: 'ImportBatch',
    entityId: batch.id,
    payload: { source: input.source, rows: input.rows.length, groups: groups.size, issues: issues.length, duplicateOf: duplicateOf?.id ?? null },
    correlationId: input.correlationId,
  });

  return { batch, preview, issues, rejectedGroups: [...badGroups], duplicateOf: duplicateOf?.id ?? null };
}

export async function confirmBatch(input: {
  id: string;
  onlyGroupIds?: string[];
  correlationId: string;
  actor: Principal;
}) {
  assertPermission(input.actor.role as never, P.IMPORT_COMMIT);
  const batch = await prisma.importBatch.findUnique({ where: { id: input.id } });
  if (!batch) throw notFound('Пакет импорта');
  if (batch.status === 'COMMITTED' || batch.status === 'REJECTED') {
    throw badRequest(ErrorCode.RESOURCE_LOCKED, 'Пакет уже обработан');
  }
  if (batch.errorGroups > 0 && !input.onlyGroupIds?.length) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'В пакете есть группы с ошибками. Загрузите корректные группы или исправьте файл.', {
      details: { errorGroups: batch.errorGroups },
    });
  }

  const issues = jparse<RowIssue[]>(batch.errors, []);
  const allRows = jparse<ImportBatchRow[]>(batch.rows, []);
  const badRows = new Set(issues.map((i) => i.rowNo));
  // IMP-03: ошибочная группа исключается целиком — частичная загрузка позиций
  // одной группы в одну заявку недопустима.
  const badGroups = new Set(allRows.filter((r) => badRows.has(r.rowNo)).map((r) => r.groupId));
  const selectedBadGroups = [...badGroups].filter((g) => !input.onlyGroupIds || input.onlyGroupIds.includes(g));
  if (selectedBadGroups.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Выбраны группы с ошибками. Исправьте их в исходном файле и загрузите заново.', {
      details: { groups: selectedBadGroups },
    });
  }
  const groups = new Map<string, ImportBatchRow[]>();
  for (const row of allRows) {
    if (input.onlyGroupIds && !input.onlyGroupIds.includes(row.groupId)) continue;
    if (badRows.has(row.rowNo) || badGroups.has(row.groupId)) continue;
    const arr = groups.get(row.groupId) ?? [];
    arr.push(row);
    groups.set(row.groupId, arr);
  }
  if (groups.size === 0) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Нет корректных групп для загрузки');

  const created: { groupId: string; number: string; deduplicated: boolean }[] = [];
  const failed: { groupId: string; reason: string }[] = [];

  for (const [groupId, rows] of groups) {
    try {
      const first = rows[0]!;
      const result = await createApplication({
        organizationName: first.organizationName,
        inn: first.inn,
        kpp: first.kpp,
        contactName: first.contactName,
        contactPhone: first.contactPhone,
        contactEmail: first.contactEmail,
        externalNumber: first.externalNumber,
        source: 'IMPORT',
        sourceRef: `${batch.id}:${groupId}`,
        priority: 'NORMAL',
        lines: rows.map((r) => ({ lineId: r.lineId, name: r.lineName, quantity: r.quantity, unit: r.unit, price: r.price })),
        idempotencyKey: `import:${batch.sourceKey}:${batch.fileChecksum}:${groupId}`,
        correlationId: input.correlationId,
        actor: input.actor,
      });
      created.push({ groupId, number: result.application.number, deduplicated: result.deduplicated });
    } catch (e) {
      failed.push({ groupId, reason: e instanceof Error ? e.message : 'Неизвестная ошибка' });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.importBatch.update({
      where: { id: batch.id },
      data: {
        status: 'COMMITTED',
        committedAt: new Date(),
        createdGroups: created.length,
        errorGroups: failed.length,
        errors: JSON.stringify(
          failed.map((f) => ({ rowNo: 0, field: f.groupId, reason: f.reason, fix: 'Исправьте данные группы и повторите импорт' })),
        ),
      },
    });
    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.IMPORT_COMMIT,
      entityType: 'ImportBatch',
      entityId: batch.id,
      payload: { created: created.length, failed: failed.length },
      correlationId: input.correlationId,
    });
    return row;
  });

  return { batch: updated, created, failed };
}

export async function listBatches(p: Principal) {
  assertPermission(p.role as never, P.IMPORT_RUN);
  return prisma.importBatch.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
}

export async function getBatch(id: string, p: Principal) {
  assertPermission(p.role as never, P.IMPORT_RUN);
  const batch = await prisma.importBatch.findUnique({ where: { id } });
  if (!batch) throw notFound('Пакет импорта');
  return {
    batch,
    issues: jparse<RowIssue[]>(batch.errors, []),
    rows: jparse<ImportBatchRow[]>(batch.rows, []),
    duplicateOf: batch.externalBatchId,
  };
}
