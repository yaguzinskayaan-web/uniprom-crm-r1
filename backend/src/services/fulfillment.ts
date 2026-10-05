import { prisma } from '../lib/prisma.js';
import { AppError, ErrorCode, badRequest, forbidden, notFound, conflict } from '../errors.js';
import { P, assertPermission, permissionsFor } from '../domain/rbac.js';
import { assertCanReadApplicationInScope, type Principal } from '../domain/scope.js';
import { audit, AuditAction } from '../lib/audit.js';
import { notify, NotifyCode } from '../lib/notifications.js';

/**
 * Исполнение заказа: отгрузки, расчёты и закрывающие документы (§9.3, CLOSE-01..04).
 * Все проверки закрытия выполняются на сервере по фактическим данным 1С
 * и зарегистрированным документам, а не по введённым пользователем суммам.
 */

export interface LineFulfilment {
  lineId: string;
  name: string;
  unit: string;
  orderQty: number;
  shippedQty: number;
  remainingQty: number;
}

export interface FulfilmentDiscrepancy {
  kind: 'SHIPMENT_LINE_NOT_FOUND' | 'OVER_SHIPMENT' | 'CANCELLED_SHIPMENT';
  lineId: string;
  message: string;
  shipmentNumber?: string;
}

/**
 * Пересчитывает отгруженные количества по позициям заявки на основании
 * проведённых и неотменённых отгрузок. SHIP-02: строки отгрузки, не
 * сопоставленные с позициями заявки, не отбрасываются молча, а возвращаются
 * как расхождения для разбора.
 */
export async function recomputeLineFulfilment(applicationId: string): Promise<{
  lines: LineFulfilment[];
  discrepancies: FulfilmentDiscrepancy[];
}> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { lines: true },
  });
  if (!app) throw notFound('Заявка');

  const shipments = await prisma.shipment.findMany({
    where: { applicationId, isPosted: true, isCancelled: false, status: { not: 'CANCELLED' } },
    include: { lines: true },
    orderBy: { docDate: 'asc' },
  });

  const shipped = new Map<string, number>();
  const discrepancies: FulfilmentDiscrepancy[] = [];
  const byLineId = new Map(app.lines.map((l) => [l.lineId, l]));

  for (const sh of shipments) {
    for (const sl of sh.lines) {
      const target = byLineId.get(sl.lineId);
      if (!target) {
        discrepancies.push({
          kind: 'SHIPMENT_LINE_NOT_FOUND',
          lineId: sl.lineId,
          shipmentNumber: sh.number,
          message: `В отгрузке ${sh.number} есть позиция «${sl.lineId}», которой нет в заявке ${app.number}. Требуется разбор расхождения.`,
        });
        continue;
      }
      const next = (shipped.get(sl.lineId) ?? 0) + sl.quantity;
      if (next > target.orderQty + 1e-6) {
        discrepancies.push({
          kind: 'OVER_SHIPMENT',
          lineId: sl.lineId,
          shipmentNumber: sh.number,
          message: `Отгрузка ${sh.number} превышает заказанное количество по позиции «${target.name}»: ${next} > ${target.orderQty}.`,
        });
      }
      shipped.set(sl.lineId, next);
    }
  }

  const lines: LineFulfilment[] = app.lines.map((l) => {
    const shippedQty = shipped.get(l.lineId) ?? 0;
    return {
      lineId: l.lineId,
      name: l.name,
      unit: l.unit,
      orderQty: l.orderQty,
      shippedQty,
      remainingQty: Math.max(0, Math.round((l.orderQty - shippedQty) * 1000) / 1000),
    };
  });

  for (const l of lines) {
    const current = app.lines.find((x) => x.lineId === l.lineId);
    if (current && Math.abs(current.shippedQty - l.shippedQty) > 1e-9) {
      await prisma.applicationLine.update({ where: { id: current.id }, data: { shippedQty: l.shippedQty } });
    }
  }

  return { lines, discrepancies };
}

// ─────────────────────────── Сводка по исполнению

export interface FulfilmentSummary {
  application: { id: string; number: string; stage: string; amount: number | null; currency: string | null };
  lines: LineFulfilment[];
  discrepancies: FulfilmentDiscrepancy[];
  shipments: {
    id: string;
    number: string;
    docDate: Date | null;
    status: string;
    isCancelled: boolean;
    isPosted: boolean;
    carrier: string | null;
    lines: { lineId: string; quantity: number; actualDate: Date | null }[];
  }[];
  finance: {
    contractStatus: string;
    paymentTerms: string | null;
    basisAmount: number | null;
    invoicedTotal: number;
    paidTotal: number;
    openInvoices: { id: string; number: string; amount: number; status: string }[];
    paymentFreshnessMinutes: number | null;
  };
  closingDocuments: {
    id: string;
    docType: string;
    isRequired: boolean;
    requiresBothSignatures: boolean;
    status: string;
    number: string | null;
    registeredAt: Date | null;
  }[];
  isFullyShipped: boolean;
  isFullyPaid: boolean;
  closingDocumentsComplete: boolean;
}

export async function getFulfilment(number: string, p: Principal): Promise<FulfilmentSummary> {
  assertPermission(p.role as never, P.FULFILLMENT_READ);
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  const app = await prisma.application.findUnique({
    where: { number },
    include: {
      lines: true,
      commercial: {
        include: {
          invoices: { where: { isPosted: true }, orderBy: { docDate: 'desc' } },
        },
      },
      shipments: {
        orderBy: { docDate: 'desc' },
        include: { lines: true },
      },
      closingDocs: true,
    },
  });
  if (!app) throw notFound('Заявка');
  await assertCanReadApplicationInScope(app, p, canReadAny);

  const { lines, discrepancies } = await recomputeLineFulfilment(app.id);

  const allocations = await prisma.paymentAllocation.findMany({
    where: { applicationId: app.id, isCancelled: false },
    select: { amount: true, createdAt: true },
  });
  const paidTotal = round2(allocations.reduce((s, a) => s + a.amount, 0));
  const lastPaymentAt = allocations.reduce<Date | null>((acc, a) => (!acc || a.createdAt > acc ? a.createdAt : acc), null);

  const invoices = app.commercial?.invoices ?? [];
  const invoicedTotal = round2(invoices.filter((i) => i.status !== 'CANCELLED').reduce((s, i) => s + i.amount, 0));
  const openInvoices = invoices.filter((i) => i.status !== 'PAID' && i.status !== 'CANCELLED');

  return {
    application: { id: app.id, number: app.number, stage: app.stage, amount: app.amount, currency: app.currency },
    lines,
    discrepancies,
    shipments: app.shipments.map((s) => ({
      id: s.id,
      number: s.number,
      docDate: s.docDate,
      status: s.status,
      isCancelled: s.isCancelled,
      isPosted: s.isPosted,
      carrier: s.carrier,
      lines: s.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity, actualDate: l.actualDate })),
    })),
    finance: {
      contractStatus: app.commercial?.contractStatus ?? 'DRAFT',
      paymentTerms: app.commercial?.paymentTerms ?? null,
      basisAmount: app.commercial?.basisAmount ?? null,
      invoicedTotal,
      paidTotal,
      openInvoices: openInvoices.map((i) => ({ id: i.id, number: i.number, amount: i.amount, status: i.status })),
      paymentFreshnessMinutes: lastPaymentAt ? Math.round((Date.now() - lastPaymentAt.getTime()) / 60000) : null,
    },
    closingDocuments: app.closingDocs.map((d) => ({
      id: d.id,
      docType: d.docType,
      isRequired: d.isRequired,
      requiresBothSignatures: d.requiresBothSignatures,
      status: d.status,
      number: d.number,
      registeredAt: d.registeredAt,
    })),
    isFullyShipped: lines.length > 0 && lines.every((l) => l.remainingQty <= 1e-6),
    isFullyPaid: openInvoices.length === 0 && paidTotal + 1e-6 >= invoicedTotal,
    closingDocumentsComplete: app.closingDocs
      .filter((d) => d.isRequired && d.status !== 'CANCELLED')
      .every((d) => d.status === 'REGISTERED' || d.status === 'SIGNED'),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ─────────────────────────── Проверка закрытия (CLOSE-01..04, A30..A34)

export interface CloseCheckResult {
  canClose: boolean;
  blockers: { code: string; message: string }[];
  summary: FulfilmentSummary;
}

/**
 * A30: нельзя закрыть заявку, по которой не отгружено всё заказанное.
 * A31: нельзя закрыть заявку с неоплаченными счетами.
 * A32: нельзя закрыть заявку без всех требуемых закрывающих документов.
 * A33: нельзя закрыть заявку с неразобранным расхождением по исполнению.
 * A34: закрытие доступно только из этапов исполнения.
 */
export async function checkCloseReadiness(number: string, p: Principal): Promise<CloseCheckResult> {
  assertPermission(p.role as never, P.CLOSE_CHECK);
  const summary = await getFulfilment(number, p);
  const blockers: { code: string; message: string }[] = [];

  if (summary.application.stage !== 'FULFILLMENT' && summary.application.stage !== 'READY_TO_SHIP') {
    blockers.push({
      code: ErrorCode.APPLICATION_NOT_IN_FULFILLMENT,
      message: `Закрытие доступно из этапов исполнения. Действующий этап: ${summary.application.stage}.`,
    });
  }
  if (!summary.isFullyShipped) {
    const notShipped = summary.lines
      .filter((l) => l.remainingQty > 1e-6)
      .map((l) => `${l.name} — осталось ${l.remainingQty} ${l.unit}`)
      .join('; ');
    blockers.push({
      code: ErrorCode.SHIPMENT_INCOMPLETE,
      message: `Заказ отгружен не полностью: ${notShipped || 'нет данных по отгрузкам'}.`,
    });
  }
  if (!summary.isFullyPaid) {
    blockers.push({
      code: ErrorCode.PAYMENT_INCOMPLETE,
      message: `Есть неоплаченные счета: ${summary.finance.openInvoices.map((i) => `${i.number} (${i.amount})`).join(', ')}.`,
    });
  }
  if (!summary.closingDocumentsComplete) {
    const missing = summary.closingDocuments
      .filter((d) => d.isRequired && d.status !== 'CANCELLED' && d.status !== 'REGISTERED' && d.status !== 'SIGNED')
      .map((d) => d.docType);
    blockers.push({
      code: ErrorCode.CLOSING_DOCUMENTS_INCOMPLETE,
      message: `Не зарегистрированы закрывающие документы: ${missing.join(', ') || 'нет данных'}.`,
    });
  }
  if (summary.discrepancies.length) {
    blockers.push({
      code: ErrorCode.UNRESOLVED_DISCREPANCY,
      message: `Имеются неразобранные расхождения по исполнению: ${summary.discrepancies.length}.`,
    });
  }

  return { canClose: blockers.length === 0, blockers, summary };
}

/**
 * CLOSE-03: закрытие — отдельное действие пользователя, backend перепроверяет
 * условия в той же транзакции, где меняется состояние. Факт закрытия и его
 * автор сохраняются, поэтому последующее автоматическое возвращение в
 * исполнение не теряет историю.
 */
export async function closeApplication(
  number: string,
  input: { comment?: string; lockVersion: number; correlationId: string; actor: Principal },
) {
  assertPermission(input.actor.role as never, P.CLOSE_EXECUTE, 'Закрытие заявки доступно сотруднику продаж или руководителю продаж.');
  const app = await prisma.application.findUnique({ where: { number }, select: { id: true, lockVersion: true, isClosed: true, stage: true } });
  if (!app) throw notFound('Заявка');
  if (app.isClosed) {
    throw badRequest(ErrorCode.RESOURCE_LOCKED, 'Заявка уже закрыта');
  }
  if (app.lockVersion !== input.lockVersion) {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Заявка изменена другим пользователем. Обновите и повторите.', {
      details: { currentVersion: app.lockVersion, yourVersion: input.lockVersion },
    });
  }

  // Условия проверяются повторно внутри транзакции: оплата или отгрузка могли
  // измениться между предварительной проверкой и подтверждением (GATE-03).
  const check = await checkCloseReadiness(number, input.actor);
  if (!check.canClose) {
    throw new AppError(422, ErrorCode.CLOSING_DOCUMENTS_INCOMPLETE, 'Заявку нельзя закрыть: выполнены не все условия.', {
      fields: check.blockers.map((b) => ({ field: 'close', message: b.message })),
      details: { blockers: check.blockers },
    });
  }
  if (!check.summary.finance.paymentTerms) {
    throw forbidden('Условия оплаты не заданы — закрытие невозможно');
  }

  const closedAt = new Date();
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.application.findUnique({ where: { id: app.id }, select: { lockVersion: true, isClosed: true } });
    if (fresh?.isClosed) throw badRequest(ErrorCode.RESOURCE_LOCKED, 'Заявка уже закрыта');
    if (fresh?.lockVersion !== app.lockVersion) {
      throw conflict(ErrorCode.VERSION_CONFLICT, 'Заявка изменена другим пользователем. Обновите и повторите.');
    }

    const row = await tx.application.update({
      where: { id: app.id },
      data: {
        stage: 'CLOSED',
        isClosed: true,
        closedAt,
        closedById: input.actor.id,
        closeReopenedAt: null,
        closeReopenReason: null,
        lossReason: null,
        lossComment: null,
        nextActivityAt: null,
        lockVersion: { increment: 1 },
        versionNo: { increment: 1 },
      },
      select: { id: true, number: true, stage: true, closedAt: true, isClosed: true, lockVersion: true },
    });

    // Активные контрольные нормативы закрытой заявки останавливаются.
    await tx.slaInstance.updateMany({
      where: { applicationId: app.id, status: { in: ['ACTIVE', 'PAUSED'] } },
      data: { status: 'CANCELLED' },
    });

    await tx.crmActivity.create({
      data: {
        applicationId: app.id,
        type: 'SYSTEM',
        participants: JSON.stringify([input.actor.id]),
        occurredAt: closedAt,
        authorId: input.actor.id,
        subject: 'Заявка закрыта',
        content: input.comment ?? null,
        isCustomerFacing: false,
      },
    });

    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.APPLICATION_CLOSE,
      entityType: 'Application',
      entityId: app.id,
      applicationId: app.id,
      before: { stage: app.stage, isClosed: false },
      after: { stage: 'CLOSED', closedAt, comment: input.comment ?? null },
      correlationId: input.correlationId,
    });

    return row;
  });
}

/**
 * CLOSE-03: последующая корректировка оплаты, отгрузки или закрывающего
 * документа возвращает CLOSED в FULFILLMENT с указанием причины, сохраняя
 * факт первоначального закрытия и уведомляя ответственного.
 */
export async function reopenClosedApplication(input: {
  applicationId: string;
  reason: string;
  details?: Record<string, unknown>;
  correlationId: string;
}): Promise<{ reopened: boolean; number?: string }> {
  const app = await prisma.application.findUnique({
    where: { id: input.applicationId },
    select: { id: true, number: true, stage: true, isClosed: true, ownerId: true, closedAt: true },
  });
  if (!app || !app.isClosed || app.stage !== 'CLOSED') return { reopened: false };

  const reason = input.reason.trim() || 'Условия закрытия нарушены последующей корректировкой учётных данных';
  // Системное событие отражается в бизнес-хронологии от имени ответственного
  // сотрудника, а при его отсутствии — от имени администратора.
  const authorId =
    app.ownerId ??
    (await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true }, select: { id: true } }))?.id ??
    null;

  return prisma.$transaction(async (tx) => {
    const row = await tx.application.update({
      where: { id: app.id },
      data: {
        stage: 'FULFILLMENT',
        isClosed: false,
        // дата факта закрытия сохраняется, поле closedAt не очищается
        closeReopenedAt: new Date(),
        closeReopenReason: reason,
        nextActivityAt: new Date(),
        lockVersion: { increment: 1 },
        versionNo: { increment: 1 },
      },
      select: { id: true, number: true, stage: true, closedAt: true, isClosed: true },
    });

    if (authorId) {
      await tx.crmActivity.create({
        data: {
          applicationId: app.id,
          type: 'SYSTEM',
          participants: JSON.stringify([]),
          occurredAt: new Date(),
          authorId,
          subject: 'Заявка возвращена в исполнение',
          content: `${reason}${input.details ? ` ${JSON.stringify(input.details)}` : ''}`,
          isCustomerFacing: false,
        },
      });
    }

    await audit(tx, {
      serviceAccount: 'ONE_C_SYNC',
      actionCode: AuditAction.APPLICATION_CLOSE_REOPENED,
      entityType: 'Application',
      entityId: app.id,
      applicationId: app.id,
      before: { stage: 'CLOSED', isClosed: true, closedAt: app.closedAt },
      after: { stage: 'FULFILLMENT', isClosed: false, reason, ...(input.details ?? {}) },
      correlationId: input.correlationId,
    });

    if (app.ownerId) {
      await notify(tx, {
        userId: app.ownerId,
        code: NotifyCode.APPLICATION_CLOSE_REOPENED,
        title: `Заявка ${app.number} возвращена в исполнение`,
        body: reason,
        entityType: 'Application',
        entityId: app.id,
        dedupKey: `auto-reopen:${app.id}:${reason.slice(0, 40)}`,
      });
    }

    return { reopened: true, number: row.number };
  });
}

/** Закрывающие документы заявки с признаком полноты комплекта. */
export async function listClosingDocuments(
  number: string,
  p: Principal,
): Promise<{ required: string[]; registered: string[]; items: { id: string; docType: string; status: string; number: string | null; source: string; registeredAt: Date | null }[] }> {
  const app = await prisma.application.findUnique({
    where: { number },
    include: { closingDocs: { orderBy: { docType: 'asc' } } },
  });
  if (!app) throw notFound('Заявка');
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  await assertCanReadApplicationInScope(app, p, canReadAny);
  assertPermission(p.role as never, P.FULFILLMENT_READ);

  const required = app.closingDocs.filter((d) => d.isRequired).map((d) => d.docType);
  const registered = app.closingDocs
    .filter((d) => d.isRequired && (d.status === 'REGISTERED' || d.status === 'SIGNED'))
    .map((d) => d.docType);
  return {
    required,
    registered,
    items: app.closingDocs.map((d) => ({
      id: d.id,
      docType: d.docType,
      status: d.status,
      number: d.number,
      source: d.source,
      registeredAt: d.registeredAt,
    })),
  };
}

/**
 * Регистрация закрывающего документа (CLOSE-02). Документы приходят из 1С или
 * регистрируются сотрудником; закрытие заявки проверяет наличие обязательного
 * комплекта, поэтому регистрация доступна и изменяет статус конкретного типа.
 */
export async function registerClosingDocument(input: {
  number: string;
  docType: string;
  docNumber?: string | null;
  extId?: string | null;
  extSystem?: string | null;
  status?: 'PENDING' | 'REGISTERED' | 'SIGNED' | 'CANCELLED';
  fileId?: string | null;
  source?: 'ONE_C' | 'CRM';
  correlationId: string;
  actor: Principal;
}): Promise<{ id: string; docType: string; status: string }> {
  const docType = String(input.docType ?? '').trim().toUpperCase();
  if (!['UPD', 'NAKLADNAYA', 'SF', 'ACT'].includes(docType)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Неизвестный тип закрывающего документа', {
      fields: [{ field: 'docType', message: 'Допустимо: UPD, NAKLADNAYA, SF, ACT' }],
    });
  }
  const status = input.status ?? 'REGISTERED';

  const app = await prisma.application.findUnique({ where: { number: input.number } });
  if (!app) throw notFound('Заявка');
  const canReadAny = permissionsFor(input.actor.role as never).includes(P.APPLICATION_READ_ANY);
  await assertCanReadApplicationInScope(app, input.actor, canReadAny);
  assertPermission(input.actor.role as never, P.FULFILLMENT_WRITE);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.closingDocument.findFirst({
      where: { applicationId: app.id, docType, extId: input.extId ?? undefined },
    });
    const data = {
      number: input.docNumber ?? input.extId ?? null,
      status,
      fileId: input.fileId ?? null,
      extSystem: input.extSystem ?? (input.source === 'CRM' ? null : 'ONE_C'),
      extId: input.extId ?? null,
      source: input.source ?? 'CRM',
      registeredAt: status === 'PENDING' ? null : new Date(),
    };
    const row = existing
      ? await tx.closingDocument.update({ where: { id: existing.id }, data })
      : await tx.closingDocument.create({ data: { applicationId: app.id, docType, isRequired: true, ...data } });

    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.CLOSING_DOC_UPDATE,
      entityType: 'ClosingDocument',
      entityId: row.id,
      applicationId: app.id,
      before: existing ? { status: existing.status, number: existing.number } : null,
      after: { docType, status, number: row.number, source: row.source },
      correlationId: input.correlationId,
    });

    return { id: row.id, docType: row.docType, status: row.status };
  });
}
