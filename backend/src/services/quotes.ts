import { prisma } from '../lib/prisma.js';
import { AppError, ErrorCode, badRequest, forbidden, notFound, conflict } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { notify, NotifyCode } from '../lib/notifications.js';
import { fingerprint, orderCompositionHash } from '../lib/auth.js';
import { storeFile } from '../lib/storage.js';
import { P, assertPermission, permissionsFor } from '../domain/rbac.js';
import type { Principal } from '../domain/scope.js';
import { checkConclusion, assertConclusionAllowsQuote, isKoMandatory } from './engineering.js';
import { refreshApplicationAmount, refreshApplicationStageForQuote } from './applications.js';
import { completeSla, SlaCode } from './sla.js';
import { renderQuoteDocument } from '../lib/quoteDoc.js';
import type { Complexity } from '../domain/constants.js';

// ─────────────────────────── Чтение

export async function listQuotes(number: string, p: Principal) {
  assertPermission(p.role as never, P.QUOTE_READ);
  const app = await prisma.application.findUnique({ where: { number }, select: { id: true, ownerId: true } });
  if (!app) throw notFound('Заявка');
  const canAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  if (!canAny && app.ownerId !== p.id) throw notFound('Заявка');

  return prisma.crmQuote.findMany({
    where: { applicationId: app.id },
    orderBy: { versionNo: 'desc' },
    include: {
      author: { select: { id: true, fullName: true, role: true } },
      lines: true,
      approvals: {
        orderBy: { requestedAt: 'desc' },
        include: {
          requestedBy: { select: { id: true, fullName: true, role: true } },
          decidedBy: { select: { id: true, fullName: true, role: true } },
        },
      },
      dispatches: {
        orderBy: { createdAt: 'desc' },
        include: { initiatedBy: { select: { id: true, fullName: true } } },
      },
    },
  });
}

export async function getQuote(id: string, p: Principal) {
  const quote = await prisma.crmQuote.findUnique({
    where: { id },
    include: {
      application: {
        include: { organization: true, contact: true, lines: true, owner: { select: { id: true, fullName: true } } },
      },
      author: { select: { id: true, fullName: true, role: true } },
      lines: true,
      approvals: {
        orderBy: { requestedAt: 'desc' },
        include: {
          requestedBy: { select: { id: true, fullName: true, role: true } },
          decidedBy: { select: { id: true, fullName: true, role: true } },
        },
      },
      dispatches: {
        orderBy: { createdAt: 'desc' },
        include: { initiatedBy: { select: { id: true, fullName: true } } },
      },
    },
  });
  if (!quote) throw notFound('Версия КП');
  const canAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  if (!canAny && quote.application.ownerId !== p.id && quote.author.id !== p.id) throw notFound('Версия КП');
  return quote;
}

// ─────────────────────────── Создание версии (QUOTE-04)

export interface CreateQuoteInput {
  number: string;
  validUntil?: string;
  leadTimeDays?: number;
  deliveryTerms?: string;
  paymentTermsNote?: string;
  discountPct?: number;
  taxAttribute?: string;
  technicalNotes?: string;
  conditionsNote?: string;
  lines?: { lineId: string; quantity?: number; price: number }[];
  correlationId: string;
  actor: Principal;
}

function nextQuoteNumber(applicationNumber: string, versionNo: number): string {
  return `${applicationNumber}/КП-${versionNo}`;
}

export async function createQuote(input: CreateQuoteInput) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.QUOTE_CREATE);

  const app = await prisma.application.findUnique({
    where: { number: input.number },
    include: { lines: true, organization: true, contact: true, commercial: true },
  });
  if (!app) throw notFound('Заявка');
  if (!app.lines.length) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Нельзя создать КП без позиций заявки', {
      fields: [{ field: 'lines', message: 'Сначала добавьте позиции в заявку' }],
    });
  }

  const last = await prisma.crmQuote.findFirst({
    where: { applicationId: app.id },
    orderBy: { versionNo: 'desc' },
    select: { versionNo: true },
  });
  const versionNo = (last?.versionNo ?? 0) + 1;

  const quoteLines = (input.lines ?? []).length
    ? input.lines!.map((l) => {
        const src = app.lines.find((x) => x.lineId === l.lineId);
        if (!src) throw badRequest(ErrorCode.VALIDATION_ERROR, `Позиция ${l.lineId} не найдена в заявке`);
        const qty = l.quantity ?? src.quantity;
        return {
          lineId: src.lineId,
          name: src.name,
          quantity: qty,
          unit: src.unit,
          price: l.price,
          amount: Math.round(l.price * qty * 100) / 100,
          params: src.params,
        };
      })
    : app.lines.map((l) => ({
        lineId: l.lineId,
        name: l.name,
        quantity: l.quantity,
        unit: l.unit,
        price: l.price ?? 0,
        amount: Math.round((l.price ?? 0) * l.quantity * 100) / 100,
        params: l.params,
      }));

  const amount = Math.round(quoteLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const currency = app.commercial?.basisCurrency ?? 'RUB';

  const quote = await prisma.$transaction(async (tx) => {
    const created = await tx.crmQuote.create({
      data: {
        applicationId: app.id,
        versionNo,
        number: nextQuoteNumber(app.number, versionNo),
        status: 'DRAFT',
        approvalStatus: 'NOT_REQUESTED',
        source: 'GENERATED',
        authorId: actor.id,
        amount,
        currency,
        discountPct: input.discountPct ?? 0,
        taxAttribute: input.taxAttribute ?? 'NDS_20',
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        leadTimeDays: input.leadTimeDays ?? null,
        deliveryTerms: input.deliveryTerms ?? null,
        paymentTermsNote: input.paymentTermsNote ?? null,
        technicalNotes: input.technicalNotes ?? null,
        conditionsNote: input.conditionsNote ?? null,
        calculationRevision: app.lines[0]?.calculationRevision ?? null,
        templateVersion: 'v1',
        lockVersion: 1,
        lines: { create: quoteLines },
      },
      include: { lines: true },
    });

    await audit(tx, {
      actor,
      actionCode: AuditAction.QUOTE_CREATE,
      entityType: 'CrmQuote',
      entityId: created.id,
      applicationId: app.id,
      after: { versionNo, amount, currency, lines: quoteLines.length },
      correlationId,
    });
    return created;
  });

  return quote;
}

// ─────────────────────────── Обновление черновика (QUOTE-03)

export async function updateQuote(
  id: string,
  input: Partial<{
    validUntil: string | null;
    leadTimeDays: number;
    deliveryTerms: string;
    paymentTermsNote: string;
    discountPct: number;
    taxAttribute: string;
    technicalNotes: string;
    conditionsNote: string;
    amount: number;
    lines: { lineId: string; name?: string; unit?: string; quantity: number; price: number }[];
  }>,
  lockVersion: number,
  correlationId: string,
  actor: Principal,
) {
  assertPermission(actor.role as never, P.QUOTE_UPDATE_DRAFT);
  const quote = await prisma.crmQuote.findUnique({ where: { id }, include: { application: true } });
  if (!quote) throw notFound('Версия КП');
  if (quote.authorId !== actor.id) throw forbidden('Изменять черновик может только его автор');
  // QUOTE-03: подмена файла/содержания уже согласованной версии запрещена
  if (quote.status !== 'DRAFT') {
    throw badRequest(ErrorCode.QUOTE_SENT_IMMUTABLE, 'Версия КП уже не является черновиком. Создайте новую версию.', {
      details: { status: quote.status },
    });
  }
  if (quote.approvalStatus === 'PENDING') {
    throw badRequest(ErrorCode.QUOTE_VERSION_CHANGED, 'Версия находится на согласовании. Отзовите согласование перед изменением.');
  }
  if (quote.lockVersion !== lockVersion) {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Версия КП изменена другим пользователем. Обновите и повторите.', {
      details: { currentVersion: quote.lockVersion, yourVersion: lockVersion },
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (input.lines) {
      await tx.crmQuoteLine.deleteMany({ where: { quoteId: id } });
      await tx.crmQuoteLine.createMany({
        data: input.lines.map((l) => ({
          quoteId: id,
          lineId: l.lineId,
          name: l.name ?? l.lineId,
          quantity: l.quantity,
          unit: l.unit ?? 'шт.',
          price: l.price,
          amount: Math.round(l.price * l.quantity * 100) / 100,
        })),
      });
    }
    const lines = input.lines
      ? input.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity, price: l.price, amount: l.price * l.quantity }))
      : null;    const newAmount = input.amount ?? (lines ? Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100 : quote.amount);

    const row = await tx.crmQuote.update({
      where: { id },
      data: {
        ...(input.validUntil !== undefined ? { validUntil: input.validUntil ? new Date(input.validUntil) : null } : {}),
        ...(input.leadTimeDays !== undefined ? { leadTimeDays: input.leadTimeDays } : {}),
        ...(input.deliveryTerms !== undefined ? { deliveryTerms: input.deliveryTerms } : {}),
        ...(input.paymentTermsNote !== undefined ? { paymentTermsNote: input.paymentTermsNote } : {}),
        ...(input.discountPct !== undefined ? { discountPct: input.discountPct } : {}),
        ...(input.taxAttribute !== undefined ? { taxAttribute: input.taxAttribute } : {}),
        ...(input.technicalNotes !== undefined ? { technicalNotes: input.technicalNotes } : {}),
        ...(input.conditionsNote !== undefined ? { conditionsNote: input.conditionsNote } : {}),
        amount: newAmount,
        contentHash: null,
        lockVersion: { increment: 1 },
      },
    });

    await audit(tx, {
      actor,
      actionCode: AuditAction.QUOTE_UPDATE,
      entityType: 'CrmQuote',
      entityId: id,
      applicationId: quote.applicationId,
      before: { amount: quote.amount, lockVersion: quote.lockVersion },
      after: { amount: newAmount },
      correlationId,
    });
    return row;
  });

  return updated;
}

// ─────────────────────────── Генерация документа (QUOTE-01)

export async function generateQuoteDocument(id: string, correlationId: string, actor: Principal) {
  assertPermission(actor.role as never, P.QUOTE_UPDATE_DRAFT);
  const quote = await prisma.crmQuote.findUnique({
    where: { id },
    include: {
      application: { include: { organization: true, contact: true, lines: true } },
      lines: true,
    },
  });
  if (!quote) throw notFound('Версия КП');
  if (quote.authorId !== actor.id) throw forbidden('Формировать документ может автор версии');
  if (['SENT', 'ACCEPTED', 'REJECTED', 'SUPERSEDED'].includes(quote.status)) {
    throw badRequest(ErrorCode.QUOTE_SENT_IMMUTABLE, 'Отправленная версия КП сохраняется неизменяемой (ТЗ QUOTE-03).');
  }

  const koMandatory = await isKoMandatory(quote.applicationId);
  const conclusion = await checkConclusion(quote.applicationId, quote.application.complexity as Complexity, koMandatory);

  const doc = await renderQuoteDocument({
    quote: {
      number: quote.number,
      versionNo: quote.versionNo,
      amount: quote.amount ?? 0,
      currency: quote.currency ?? 'RUB',
      discountPct: quote.discountPct,
      taxAttribute: quote.taxAttribute,
      validUntil: quote.validUntil,
      leadTimeDays: quote.leadTimeDays,
      deliveryTerms: quote.deliveryTerms,
      paymentTermsNote: quote.paymentTermsNote,
      technicalNotes: quote.technicalNotes,
      conditionsNote: quote.conditionsNote,
    },
    application: {
      number: quote.application.number,
      complexity: quote.application.complexity,
      organization: {
        name: quote.application.organization.name,
        fullName: quote.application.organization.fullName,
        inn: quote.application.organization.inn,
        kpp: quote.application.organization.kpp,
        address: quote.application.organization.address,
      },
      contact: quote.application.contact
        ? { fullName: quote.application.contact.fullName, position: quote.application.contact.position, phone: quote.application.contact.phone, email: quote.application.contact.email }
        : null,
    },
    lines: quote.lines.map((l) => ({ name: l.name, quantity: l.quantity, unit: l.unit, price: l.price, amount: l.amount })),
    // ENG-06: условия заключения должны быть учтены в КП
    conclusionConditions: conclusion.conditions,
    author: actor.fullName,
  });

  const stored = await storeFile({
    buffer: doc.pdf,
    originalName: `${quote.application.number}_${quote.number}.pdf`,
    contentType: 'application/pdf',
    uploadedById: actor.id,
  });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.applicationFile.create({
      data: { applicationId: quote.applicationId, fileId: stored.id, purpose: 'QUOTE', refId: quote.id },
    });
    const row = await tx.crmQuote.update({
      where: { id },
      data: {
        fileId: stored.id,
        fileName: stored.originalName,
        fileChecksum: stored.checksum,
        source: 'GENERATED',
        status: quote.status === 'DRAFT' ? 'READY' : quote.status,
        lockVersion: { increment: 1 },
      },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.QUOTE_GENERATE,
      entityType: 'CrmQuote',
      entityId: id,
      applicationId: quote.applicationId,
      after: { fileId: stored.id, checksum: stored.checksum, size: stored.sizeBytes },
      correlationId,
    });
    return row;
  });

  return updated;
}

// ─────────────────────────── Загрузка готового файла (QUOTE-02, QUOTE-03)

export async function uploadQuoteDocument(
  id: string,
  file: { buffer: Buffer; originalName: string; contentType: string },
  correlationId: string,
  actor: Principal,
) {
  assertPermission(actor.role as never, P.QUOTE_UPLOAD);
  const quote = await prisma.crmQuote.findUnique({ where: { id }, include: { application: true } });
  if (!quote) throw notFound('Версия КП');
  if (quote.authorId !== actor.id) throw forbidden('Загрузить документ может автор версии');
  if (['SENT', 'ACCEPTED', 'REJECTED', 'SUPERSEDED'].includes(quote.status)) {
    throw badRequest(
      ErrorCode.QUOTE_SENT_IMMUTABLE,
      'Подмена файла уже согласованной или отправленной версии запрещена. Загрузите файл как новую версию (ТЗ QUOTE-03).',
    );
  }

  const stored = await storeFile({
    buffer: file.buffer,
    originalName: file.originalName,
    contentType: file.contentType,
    uploadedById: actor.id,
  });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.applicationFile.create({
      data: { applicationId: quote.applicationId, fileId: stored.id, purpose: 'QUOTE', refId: quote.id },
    });
    const row = await tx.crmQuote.update({
      where: { id },
      data: {
        fileId: stored.id,
        fileName: stored.originalName,
        fileChecksum: stored.checksum,
        source: 'UPLOADED',
        status: 'READY',
        contentHash: null,
        lockVersion: { increment: 1 },
      },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.QUOTE_UPLOAD,
      entityType: 'CrmQuote',
      entityId: id,
      applicationId: quote.applicationId,
      after: { fileId: stored.id, checksum: stored.checksum, source: 'UPLOADED' },
      correlationId,
    });
    return row;
  });

  return updated;
}

// ─────────────────────────── Согласование (QUOTE-05..07, RBAC-04)

/** Отпечаток содержания версии: файл, состав, цены, условия и связанные технические данные. */
export function approvalFingerprint(quote: {
  fileChecksum: string | null;
  amount: number | null;
  currency: string | null;
  validUntil: Date | null;
  discountPct: number;
  taxAttribute: string;
  lines: { lineId: string; quantity: number; price: number }[];
  calculationRevision: string | null;
  conditionsNote: string | null;
}): string {
  return fingerprint({
    file: quote.fileChecksum,
    amount: quote.amount,
    currency: quote.currency,
    validUntil: quote.validUntil?.toISOString() ?? null,
    discountPct: quote.discountPct,
    taxAttribute: quote.taxAttribute,
    conditionsNote: quote.conditionsNote,
    calculationRevision: quote.calculationRevision,
    lines: [...quote.lines]
      .map((l) => ({ lineId: l.lineId, quantity: l.quantity, price: l.price }))
      .sort((a, b) => (a.lineId < b.lineId ? -1 : 1)),
  });
}

export async function submitForApproval(id: string, correlationId: string, actor: Principal) {
  assertPermission(actor.role as never, P.QUOTE_SUBMIT_APPROVAL);
  const quote = await prisma.crmQuote.findUnique({
    where: { id },
    include: { lines: true, application: { include: { commercial: true } } },
  });
  if (!quote) throw notFound('Версия КП');
  if (quote.authorId !== actor.id) throw forbidden('На согласование направляет автор версии');
  if (quote.status === 'DRAFT') {
    throw badRequest(ErrorCode.QUOTE_NOT_READY, 'Сформируйте или загрузите документ версии перед согласованием');
  }
  if (!quote.fileId) {
    throw badRequest(ErrorCode.QUOTE_FILE_REQUIRED, 'К отправке на согласование требуется файл документа');
  }
  if (!quote.amount || quote.amount <= 0) {
    throw badRequest(ErrorCode.QUOTE_NOT_READY, 'Укажите сумму версии КП', {
      fields: [{ field: 'amount', message: 'Сумма должна быть больше нуля' }],
    });
  }
  if (quote.approvalStatus === 'APPROVED') {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Версия уже согласована');
  }
  if (quote.approvalStatus === 'PENDING') {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Версия уже находится на согласовании');
  }

  // Сервер проверяет обязательные поля и заключение КО (QUOTE-06)
  const koMandatory = await isKoMandatory(quote.applicationId);
  const conclusion = await checkConclusion(quote.applicationId, quote.application.complexity as Complexity, koMandatory);
  assertConclusionAllowsQuote(conclusion, quote.application.complexity as Complexity, koMandatory);

  const fp = approvalFingerprint(quote);

  const updated = await prisma.$transaction(async (tx) => {
    // READY не означает автоматически APPROVED (QUOTE-05)
    const row = await tx.crmQuote.update({
      where: { id },
      data: {
        status: 'READY',
        approvalStatus: 'PENDING',
        contentHash: fp,
        approvalSnapshot: JSON.stringify({ fingerprint: fp, amount: quote.amount, currency: quote.currency, fileChecksum: quote.fileChecksum }),
        lockVersion: { increment: 1 },
      },
    });
    const approval = await tx.crmQuoteApproval.create({
      data: { quoteId: id, requestedById: actor.id, versionFingerprint: fp },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.QUOTE_SUBMIT_APPROVAL,
      entityType: 'CrmQuote',
      entityId: id,
      applicationId: quote.applicationId,
      after: { fingerprint: fp, amount: quote.amount, fileChecksum: quote.fileChecksum },
      correlationId,
    });
    const leaders = await tx.user.findMany({ where: { role: 'SALES_MANAGER', isActive: true }, select: { id: true } });
    for (const l of leaders) {
      await notify(tx, {
        userId: l.id,
        code: NotifyCode.QUOTE_APPROVAL_REQUESTED,
        title: `КП ${quote.number} по заявке ${quote.application.number} ожидает согласования`,
        body: `Сумма ${quote.amount} ${quote.currency ?? 'RUB'}`,
        entityType: 'CrmQuote',
        entityId: id,
        dedupKey: `quote-approval:${approval.id}:${l.id}`,
      });
    }
    await completeSla(tx, quote.applicationId, [SlaCode.QUOTE_APPROVAL]);
    return row;
  });

  return updated;
}

export async function decideApproval(
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  comment: string | undefined,
  correlationId: string,
  actor: Principal,
) {
  // RBAC-04: согласовать коммерческую версию может пользователь с полномочием
  // SALES_MANAGER. Подготовка КП руководителем не заменяет отдельное действие.
  if (!permissionsFor(actor.role as never).includes(P.QUOTE_APPROVE)) {
    throw forbidden(
      `Решение по коммерческой версии КП принимает пользователь с полномочием SALES_MANAGER. Роль «${actor.role}» не имеет права согласования (ТЗ RBAC-04).`,
    );
  }
  if (decision === 'REJECTED' && !comment) {
    throw badRequest(ErrorCode.QUOTE_APPROVAL_COMMENT_REQUIRED, 'Возврат на доработку требует обязательного комментария (А15)', {
      fields: [{ field: 'comment', message: 'Обязательное поле' }],
    });
  }

  const quote = await prisma.crmQuote.findUnique({
    where: { id },
    include: { approvals: { where: { decidedAt: null }, orderBy: { requestedAt: 'desc' } }, lines: true },
  });
  if (!quote) throw notFound('Версия КП');
  if (quote.approvalStatus !== 'PENDING') {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Версия КП не находится на согласовании', {
      details: { approvalStatus: quote.approvalStatus },
    });
  }

  const pending = quote.approvals[0];
  if (!pending) throw conflict(ErrorCode.VERSION_CONFLICT, 'Не найдено действующее обращение на согласование');

  // QUOTE-07: при изменении файла, состава, цены, условий или связанных
  // технических данных согласование не переносится автоматически
  const currentFp = approvalFingerprint(quote);
  if (pending.versionFingerprint && pending.versionFingerprint !== currentFp) {
    throw new AppError(
      409,
      ErrorCode.QUOTE_VERSION_CHANGED,
      'Содержание версии КП изменилось после отправки на согласование. Создайте новую версию КП (ТЗ QUOTE-07, A16).',
      { details: { expected: pending.versionFingerprint, actual: currentFp } },
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.crmQuoteApproval.update({
      where: { id: pending.id },
      data: { decision, decidedById: actor.id, decidedAt: new Date(), comment: comment ?? null, versionFingerprint: currentFp },
    });
    const row = await tx.crmQuote.update({
      where: { id },
      data: {
        approvalStatus: decision,
        // READY не означает автоматически APPROVED; при отклонении возвращаемся в DRAFT-набор
        status: decision === 'APPROVED' ? 'READY' : 'DRAFT',
        lockVersion: { increment: 1 },
      },
    });
    await audit(tx, {
      actor,
      actionCode: decision === 'APPROVED' ? AuditAction.QUOTE_APPROVE : AuditAction.QUOTE_REJECT,
      entityType: 'CrmQuote',
      entityId: id,
      applicationId: quote.applicationId,
      after: { decision, comment: comment ?? null, fingerprint: currentFp },
      correlationId,
    });
    await notify(tx, {
      userId: quote.authorId,
      code: decision === 'APPROVED' ? NotifyCode.QUOTE_APPROVED : NotifyCode.QUOTE_REJECTED,
      title: decision === 'APPROVED' ? `КП ${quote.number} согласовано` : `КП ${quote.number} возвращено на доработку`,
      body: comment ?? null,
      entityType: 'CrmQuote',
      entityId: id,
      dedupKey: `quote-decision:${pending.id}:${decision}`,
    });
    return row;
  });

  return updated;
}

// ─────────────────────────── Отправка (SEND-01..06)

async function assertSendable(quoteId: string) {
  const quote = await prisma.crmQuote.findUnique({
    where: { id: quoteId },
    include: {
      lines: true,
      application: { include: { contact: true, organization: true, commercial: true } },
    },
  });
  if (!quote) throw notFound('Версия КП');

  // SEND-01: действующее коммерческое согласование
  if (quote.approvalStatus !== 'APPROVED') {
    throw new AppError(
      422,
      ErrorCode.QUOTE_APPROVAL_REQUIRED,
      'Отправка КП без действующего решения руководителя продаж не допускается (ТЗ SEND-01, A14).',
    );
  }
  // Отпечаток содержания должен совпадать с одобренным
  const currentFp = approvalFingerprint(quote);
  const approved = await prisma.crmQuoteApproval.findFirst({
    where: { quoteId, decision: 'APPROVED', decidedAt: { not: null } },
    orderBy: { decidedAt: 'desc' },
  });
  if (approved?.versionFingerprint && approved.versionFingerprint !== currentFp) {
    throw new AppError(
      409,
      ErrorCode.QUOTE_VERSION_CHANGED,
      'После согласования изменены файл, состав, цена или условия. Старое согласование не разрешает новую отправку (ТЗ QUOTE-07, A16).',
    );
  }
  // Требуемое заключение КО
  const koMandatory = await isKoMandatory(quote.applicationId);
  const conclusion = await checkConclusion(quote.applicationId, quote.application.complexity as Complexity, koMandatory);
  assertConclusionAllowsQuote(conclusion, quote.application.complexity as Complexity, koMandatory);
  // Файл
  if (!quote.fileId) {
    throw badRequest(ErrorCode.QUOTE_FILE_REQUIRED, 'К отправке требуется файл документа КП');
  }
  // Неистёкший срок действия
  if (quote.validUntil && quote.validUntil.getTime() < Date.now()) {
    throw new AppError(
      422,
      ErrorCode.QUOTE_VALIDITY_EXPIRED,
      'Срок действия КП истёк. Укажите новый срок в новой версии коммерческого предложения.',
    );
  }
  return quote;
}

export interface SendQuoteInput {
  id: string;
  recipients: string[];
  subject?: string;
  body?: string;
  idempotencyKey: string;
  correlationId: string;
  actor: Principal;
}

export async function sendQuote(input: SendQuoteInput) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.QUOTE_SEND);

  const quote = await assertSendable(input.id);
  if (!input.recipients.length) {
    throw badRequest(ErrorCode.QUOTE_RECIPIENT_REQUIRED, 'Укажите хотя бы одного получателя', {
      fields: [{ field: 'recipients', message: 'Обязательное поле' }],
    });
  }

  // SEND-02: действие с тем же ключом не ставит второе письмо в очередь
  const existing = await prisma.crmQuoteDispatch.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { dispatch: existing, deduplicated: true };

  const dispatch = await prisma.$transaction(async (tx) => {
    const d = await tx.crmQuoteDispatch.create({
      data: {
        quoteId: quote.id,
        channel: 'CRM_MAIL',
        recipients: JSON.stringify(input.recipients),
        subject: input.subject ?? `Коммерческое предложение ${quote.number} по заявке ${quote.application.number}`,
        body: input.body ?? null,
        initiatedById: actor.id,
        queueState: 'QUEUED',
        isManual: false,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.QUOTE_SEND,
      entityType: 'CrmQuoteDispatch',
      entityId: d.id,
      applicationId: quote.applicationId,
      after: { recipients: input.recipients, queueState: 'QUEUED', versionNo: quote.versionNo },
      correlationId,
    });
    return d;
  });

  return { dispatch, deduplicated: false };
}

/**
 * SEND-06: после подтверждения почтовым сервером либо ручной регистрации сервер
 * атомарно записывает факт отправки, sent_at, активность и изменение этапа.
 * Постановка в очередь сама по себе не переводит КП в SENT.
 */
export async function confirmDispatch(dispatchId: string, correlationId: string, serviceAccount = 'MAIL_WORKER') {
  const dispatch = await prisma.crmQuoteDispatch.findUnique({
    where: { id: dispatchId },
    include: { quote: { include: { application: true } } },
  });
  if (!dispatch) return null;
  if (dispatch.queueState === 'SENT') return dispatch;

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.crmQuoteDispatch.update({
      where: { id: dispatchId },
      data: { queueState: 'SENT', sentAt: new Date() },
    });
    // Повторная отправка той же версии создаёт отдельное событие, но не новую версию КП
    await tx.crmQuote.update({
      where: { id: dispatch.quoteId },
      data: {
        status: dispatch.quote.status === 'ACCEPTED' ? 'ACCEPTED' : 'SENT',
        sentAt: new Date(),
      },
    });
    await tx.crmActivity.create({
      data: {
        applicationId: dispatch.quote.applicationId,
        type: 'EMAIL',
        direction: 'OUT',
        participants: JSON.stringify(JSON.parse(dispatch.recipients) as string[]),
        occurredAt: new Date(),
        authorId: dispatch.initiatedById,
        subject: dispatch.subject,
        content: dispatch.body,
        isCustomerFacing: true,
      },
    });
    await tx.application.update({
      where: { id: dispatch.quote.applicationId },
      data: { lastActivityAt: new Date(), lastCustomerContactAt: new Date() },
    });
    await audit(tx, {
      serviceAccount,
      actionCode: AuditAction.QUOTE_MAIL_RESULT,
      entityType: 'CrmQuoteDispatch',
      entityId: dispatchId,
      applicationId: dispatch.quote.applicationId,
      after: { queueState: 'SENT', sentAt: updated.sentAt?.toISOString() },
      correlationId,
    });
    return updated;
  });

  // SEND-06: повторная отправка по уже исполняемому заказу не возвращает его из производства
  await refreshApplicationStageForQuote(dispatch.quote.applicationId, 'SENT', correlationId);
  return result;
}

export async function markDispatchFailed(
  dispatchId: string,
  state: 'FAILED' | 'UNKNOWN',
  errorText: string,
  correlationId: string,
) {
  // SEND-03: при неопределённом результате система не выполняет слепую повторную отправку
  const dispatch = await prisma.crmQuoteDispatch.findUnique({ where: { id: dispatchId } });
  if (!dispatch) return null;
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.crmQuoteDispatch.update({
      where: { id: dispatchId },
      data: { queueState: state, errorText },
    });
    await audit(tx, {
      serviceAccount: 'MAIL_WORKER',
      actionCode: AuditAction.QUOTE_MAIL_RESULT,
      entityType: 'CrmQuoteDispatch',
      entityId: dispatchId,
      applicationId: null,
      after: { queueState: state, errorText },
      correlationId,
    });
    const quote = await tx.crmQuote.findUnique({ where: { id: dispatch.quoteId }, select: { authorId: true } });
    if (quote) {
      await notify(tx, {
        userId: quote.authorId,
        code: NotifyCode.QUOTE_SEND_FAILED,
        title:
          state === 'UNKNOWN'
            ? 'Результат отправки КП не определён — требуется проверка по журналу почтового провайдера'
            : 'Не удалось отправить КП',
        body: errorText,
        entityType: 'CrmQuote',
        entityId: dispatch.quoteId,
        dedupKey: `quote-send-fail:${dispatchId}:${state}`,
      });
    }
    return row;
  });
  return updated;
}

/** SEND-04: фиксация внешней отправки с явной пометкой «зафиксировано вручную». */
export async function recordExternalSend(input: {
  id: string;
  recipients: string[];
  actualDateTime: string;
  channel: string;
  note?: string;
  fileId?: string;
  correlationId: string;
  actor: Principal;
}) {
  assertPermission(input.actor.role as never, P.QUOTE_RECORD_EXTERNAL_SEND);
  // Проверки выполняются и при штатной ручной фиксации внешней отправки
  const quote = await assertSendable(input.id);
  if (!input.recipients.length) {
    throw badRequest(ErrorCode.QUOTE_RECIPIENT_REQUIRED, 'Укажите получателя', {
      fields: [{ field: 'recipients', message: 'Обязательное поле' }],
    });
  }
  if (!input.actualDateTime) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Укажите фактические дату и время отправки', {
      fields: [{ field: 'actualDateTime', message: 'Обязательное поле' }],
    });
  }

  const dispatch = await prisma.$transaction(async (tx) => {
    const d = await tx.crmQuoteDispatch.create({
      data: {
        quoteId: quote.id,
        channel: input.channel || 'EXTERNAL_MAIL',
        recipients: JSON.stringify(input.recipients),
        subject: `Внешняя отправка КП ${quote.number} (зафиксировано вручную)`,
        body: input.note ?? null,
        initiatedById: input.actor.id,
        queueState: 'SENT',
        isManual: true,
        actualDateTime: new Date(input.actualDateTime),
        sentAt: new Date(input.actualDateTime),
      },
    });
    await tx.crmQuote.update({
      where: { id: quote.id },
      data: { status: quote.status === 'ACCEPTED' ? 'ACCEPTED' : 'SENT', sentAt: new Date(input.actualDateTime) },
    });
    await tx.crmActivity.create({
      data: {
        applicationId: quote.applicationId,
        type: 'EMAIL',
        direction: 'OUT',
        participants: JSON.stringify(input.recipients),
        occurredAt: new Date(input.actualDateTime),
        authorId: input.actor.id,
        subject: `Отправка КП ${quote.number} (внешняя почта, зафиксировано вручную)`,
        content: input.note ?? null,
        isCustomerFacing: true,
      },
    });
    await tx.application.update({
      where: { id: quote.applicationId },
      data: { lastActivityAt: new Date(), lastCustomerContactAt: new Date() },
    });
    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.QUOTE_EXTERNAL_SEND,
      entityType: 'CrmQuoteDispatch',
      entityId: d.id,
      applicationId: quote.applicationId,
      after: {
        isManual: true,
        recipients: input.recipients,
        actualDateTime: input.actualDateTime,
        channel: input.channel,
      },
      correlationId: input.correlationId,
    });
    return d;
  });

  await refreshApplicationStageForQuote(quote.applicationId, 'SENT', input.correlationId);
  return dispatch;
}

// ─────────────────────────── Решение клиента (SEND-05)

/**
 * Любой входящий ответ не переводит КП автоматически в ACCEPTED.
 * Решение фиксируется вручную со ссылкой на письмо или документ.
 */
export async function registerCustomerDecision(input: {
  id: string;
  decision: 'ACCEPTED' | 'REJECTED';
  note?: string;
  refMessageId?: string;
  correlationId: string;
  actor: Principal;
}) {
  assertPermission(input.actor.role as never, P.QUOTE_ACCEPT);
  const quote = await prisma.crmQuote.findUnique({
    where: { id: input.id },
    include: { application: true },
  });
  if (!quote) throw notFound('Версия КП');
  if (!['SENT', 'REJECTED', 'ACCEPTED'].includes(quote.status)) {
    throw badRequest(ErrorCode.QUOTE_NOT_READY, 'Решение клиента фиксируется для отправленной версии КП');
  }

  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.crmQuote.update({
      where: { id: input.id },
      data: {
        status: input.decision,
        customerDecision: input.decision,
        customerDecisionAt: new Date(),
        customerDecisionNote: input.note ?? null,
      },
    });

    if (input.decision === 'ACCEPTED') {
      // QUOTE-08: для заявки может быть одна выбранная действующая принятая версия
      await tx.crmQuote.updateMany({
        where: { applicationId: quote.applicationId, id: { not: input.id }, isActiveBasis: true },
        data: { isActiveBasis: false },
      });
      await tx.crmQuote.updateMany({
        where: { applicationId: quote.applicationId, id: { not: input.id }, status: 'SENT' },
        data: { status: 'SUPERSEDED' },
      });
      await tx.crmQuote.update({ where: { id: input.id }, data: { isActiveBasis: true } });
      await tx.crmQuoteDispatch.create({
        data: {
          quoteId: input.id,
          channel: 'MANUAL_RECORD',
          recipients: JSON.stringify([]),
          subject: 'Решение клиента зафиксировано вручную',
          body: input.note ?? null,
          initiatedById: input.actor.id,
          queueState: 'SENT',
          isManual: true,
        },
      });
    }

    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.QUOTE_CUSTOMER_DECISION,
      entityType: 'CrmQuote',
      entityId: input.id,
      applicationId: quote.applicationId,
      after: { decision: input.decision, note: input.note ?? null, refMessageId: input.refMessageId ?? null },
      correlationId: input.correlationId,
    });
    return row;
  });

  await refreshApplicationAmount(quote.applicationId);
  await refreshApplicationStageForQuote(quote.applicationId, result.status, input.correlationId);
  return result;
}

/**
 * QUOTE-08: замена коммерческого основания после договора требует явно
 * оформленного изменения договора/спецификации и синхронизации с 1С.
 */
export async function checkCommercialBasisChange(number: string) {
  const app = await prisma.application.findUnique({
    where: { number },
    include: { commercial: { include: { releaseApproval: true } } },
  });
  if (!app) throw notFound('Заявка');
  const basis = await prisma.crmQuote.findFirst({
    where: { applicationId: app.id, isActiveBasis: true },
    include: { lines: true },
  });
  if (!basis) return { requiresAmendment: false, reason: 'Действующее коммерческое основание не задано' };
  if (!app.commercial || app.commercial.contractStatus !== 'SIGNED') {
    return { requiresAmendment: false, reason: 'Договор ещё не подписан' };
  }
  const hash = orderCompositionHash({
    termsVersionNo: app.commercial.versionNo,
    amount: basis.amount,
    currency: basis.currency,
    lines: basis.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity, price: l.price })),
  });
  const approval = app.commercial.releaseApproval;
  return {
    requiresAmendment: Boolean(approval && approval.orderHash && approval.orderHash !== hash),
    reason: 'Изменение состава заказа после подписания договора оформляется дополнительным соглашением и синхронизируется с 1С',
    currentHash: hash,
    approvedHash: approval?.orderHash ?? null,
  };
}
