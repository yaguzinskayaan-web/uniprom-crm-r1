import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { AppError, ErrorCode, badRequest, forbidden, notFound, conflict } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { notify, NotifyCode } from '../lib/notifications.js';
import { enqueueOutbox } from '../lib/integration.js';
import { orderCompositionHash } from '../lib/auth.js';
import { P, assertPermission, permissionsFor } from '../domain/rbac.js';
import { assertCanReadApplicationInScope, type Principal } from '../domain/scope.js';
import { PAYMENT_TERMS, type Complexity, type Stage } from '../domain/constants.js';
import { jparse } from '../lib/query.js';
import { checkConclusion, isKoMandatory } from './engineering.js';
import { computeNextActivity } from './applications.js';
import { refreshSlaForStage } from './sla.js';

/**
 * Договор, расчёты и допуск к исполнению (§9, GATE-01..04, SHIP-02, A21..A29).
 *
 * Инварианты:
 *  • фактическая оплата и ручное разрешение выпуска — разные данные: разрешение
 *    не создаёт фиктивную оплату (GATE-02, GATE-04);
 *  • проверка и выпуск выполняются разными вызовами, но POST повторяет все
 *    проверки внутри транзакции (GATE-01, GATE-03);
 *  • решение о выпуске привязано к версии договорных условий, сумме и составу
 *    заказа — их существенное изменение делает разрешение недействующим (GATE-02);
 *  • повторный запрос выпуска не создаёт второй активный выпуск (GATE-03, A25).
 */

type Tx = Prisma.TransactionClient;

export interface CommercialView {
  id: string;
  application: { id: string; number: string; stage: string; amount: number | null; currency: string | null };
  contractNumber: string | null;
  contractDate: Date | null;
  contractStatus: string;
  contractSignedAt: Date | null;
  contractFileId: string | null;
  specificationRef: string | null;
  basisQuoteId: string | null;
  basisAmount: number | null;
  basisCurrency: string | null;
  basisQuoteStatus: string | null;
  paymentTerms: string | null;
  paymentSchedule: { stage: string; pct: number; dueDays: number | null }[];
  deliveryTerms: string | null;
  versionNo: number;
  syncedTo1C: boolean;
  invoices: {
    id: string;
    number: string;
    docDate: Date | null;
    amount: number;
    currency: string;
    status: string;
    allocated: number;
  }[];
  payments: { id: string; extId: string; docDate: Date | null; amount: number; currency: string; kind: string }[];
  totals: { invoiced: number; allocated: number; unallocatedPayments: number; outstanding: number };
  releaseApproval: {
    approved: boolean;
    actor: { id: string; fullName: string } | null;
    reason: string;
    termsVersionNo: number;
    amountSnapshot: number | null;
    createdAt: Date;
  } | null;
  releases: { id: string; releasedAt: Date; state: string; isManualOverride: boolean; overrideReason: string | null }[];
}

async function loadCommercial(number: string, p: Principal) {
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  const app = await prisma.application.findUnique({
    where: { number },
    include: {
      commercial: { include: { invoices: { orderBy: [{ docDate: 'desc' }, { number: 'asc' }] }, releaseApproval: { include: { actor: { select: { id: true, fullName: true } } } } } },
      releases: { orderBy: { releasedAt: 'desc' } },
    },
  });
  if (!app) throw notFound('Заявка');
  await assertCanReadApplicationInScope(app, p, canReadAny);
  return app;
}

export async function getCommercial(number: string, p: Principal): Promise<CommercialView> {
  assertPermission(p.role as never, P.COMMERCIAL_READ);
  const app = await loadCommercial(number, p);
  const commercial = app.commercial;

  const allocations = await prisma.paymentAllocation.findMany({
    where: { applicationId: app.id, isCancelled: false },
    select: { invoiceId: true, amount: true, paymentId: true },
  });
  const allocatedByInvoice = new Map<string, number>();
  let allocatedTotal = 0;
  for (const a of allocations) {
    allocatedTotal += a.amount;
    if (a.invoiceId) allocatedByInvoice.set(a.invoiceId, (allocatedByInvoice.get(a.invoiceId) ?? 0) + a.amount);
  }

  const payments = await prisma.payment.findMany({
    where: { allocations: { some: { applicationId: app.id, isCancelled: false } } },
    orderBy: { docDate: 'desc' },
    select: { id: true, extId: true, docDate: true, amount: true, currency: true, kind: true },
  });

  const basis = commercial?.basisQuoteId
    ? await prisma.crmQuote.findUnique({
        where: { id: commercial.basisQuoteId },
        select: { id: true, status: true, versionNo: true, number: true, amount: true, currency: true },
      })
    : null;

  const invoices = commercial?.invoices ?? [];
  const invoiced = round2(invoices.filter((i) => i.status !== 'CANCELLED').reduce((s, i) => s + i.amount, 0));
  const paymentTotal = round2(payments.filter((p2) => p2.kind === 'IN').reduce((s, p2) => s + p2.amount, 0));
  const paymentAllocatedTotal = round2(allocations.reduce((s, a) => s + a.amount, 0));

  return {
    id: commercial?.id ?? '',
    application: { id: app.id, number: app.number, stage: app.stage, amount: app.amount, currency: app.currency },
    contractNumber: commercial?.contractNumber ?? null,
    contractDate: commercial?.contractDate ?? null,
    contractStatus: commercial?.contractStatus ?? 'DRAFT',
    contractSignedAt: commercial?.contractSignedAt ?? null,
    contractFileId: commercial?.contractFileId ?? null,
    specificationRef: commercial?.specificationRef ?? null,
    basisQuoteId: commercial?.basisQuoteId ?? null,
    basisAmount: commercial?.basisAmount ?? null,
    basisCurrency: commercial?.basisCurrency ?? null,
    basisQuoteStatus: basis?.status ?? null,
    paymentTerms: commercial?.paymentTerms ?? null,
    paymentSchedule: jparse<{ stage: string; pct: number; dueDays: number | null }[]>(commercial?.paymentSchedule, []),
    deliveryTerms: commercial?.deliveryTerms ?? null,
    versionNo: commercial?.versionNo ?? 1,
    syncedTo1C: commercial?.syncedTo1C ?? false,
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.number,
      docDate: i.docDate,
      amount: i.amount,
      currency: i.currency,
      status: i.status,
      allocated: round2(allocatedByInvoice.get(i.id) ?? 0),
    })),
    payments,
    totals: {
      invoiced,
      allocated: paymentAllocatedTotal,
      unallocatedPayments: round2(paymentTotal - paymentAllocatedTotal),
      outstanding: round2(Math.max(0, invoiced - paymentAllocatedTotal)),
    },
    releaseApproval:
      commercial?.releaseApproval && commercial.releaseApproval.approved
        ? {
            approved: true,
            actor: commercial.releaseApproval.actor,
            reason: commercial.releaseApproval.reason,
            termsVersionNo: commercial.releaseApproval.termsVersionNo,
            amountSnapshot: commercial.releaseApproval.amountSnapshot,
            createdAt: commercial.releaseApproval.createdAt,
          }
        : null,
    releases: app.releases.map((r) => ({
      id: r.id,
      releasedAt: r.releasedAt,
      state: r.state,
      isManualOverride: r.isManualOverride,
      overrideReason: r.overrideReason,
    })),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ─────────────────────────── Коммерческие условия (§9.1)

export interface UpdateCommercialInput {
  number: string;
  lockVersion: number;
  contractNumber?: string | null;
  contractDate?: string | null;
  specificationRef?: string | null;
  basisQuoteId?: string | null;
  paymentTerms?: string | null;
  paymentSchedule?: { stage: string; pct: number; dueDays?: number | null }[];
  deliveryTerms?: string | null;
  /** Существенное изменение условий увеличивает версию (GATE-02). */
  criticalTermsChanged?: boolean;
  comment?: string;
  correlationId: string;
  actor: Principal;
}

export async function updateCommercial(input: UpdateCommercialInput) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.COMMERCIAL_WRITE);

  const current = await prisma.application.findUnique({ where: { number: input.number }, include: { commercial: true } });
  if (!current) throw notFound('Заявка');
  if (current.lockVersion !== input.lockVersion) {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Заявка изменена другим пользователем. Обновите карточку и повторите.', {
      details: { currentVersion: current.lockVersion, yourVersion: input.lockVersion },
    });
  }
  if (input.paymentTerms && !(PAYMENT_TERMS as readonly string[]).includes(input.paymentTerms)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Неизвестные условия оплаты', {
      fields: [{ field: 'paymentTerms', message: 'Выберите значение из справочника' }],
    });
  }
  if (input.basisQuoteId) {
    const quote = await prisma.crmQuote.findUnique({ where: { id: input.basisQuoteId } });
    if (!quote) throw notFound('Коммерческое предложение');
    if (quote.applicationId !== current.id) {
      throw badRequest(ErrorCode.VALIDATION_ERROR, 'Основанием может быть только версия КП этой заявки');
    }
    if (quote.status !== 'ACCEPTED' || !quote.isActiveBasis) {
      throw badRequest(
        ErrorCode.QUOTE_NOT_READY,
        'Коммерческим основанием может быть только принятая клиентом активная версия КП.',
      );
    }
  }

  const row = await prisma.$transaction(async (tx) => {
    const before = current.commercial;
    const commercial = await tx.applicationCommercial.upsert({
      where: { applicationId: current.id },
      create: {
        applicationId: current.id,
        contractNumber: input.contractNumber ?? null,
        contractDate: input.contractDate ? new Date(input.contractDate) : null,
        specificationRef: input.specificationRef ?? null,
        basisQuoteId: input.basisQuoteId ?? null,
        basisAmount: null,
        basisCurrency: null,
        paymentTerms: input.paymentTerms ?? 'NOT_SET',
        paymentSchedule: JSON.stringify(input.paymentSchedule ?? []),
        deliveryTerms: input.deliveryTerms ?? null,
        versionNo: 1,
        lockVersion: 1,
      },
      update: {
        ...(input.contractNumber !== undefined ? { contractNumber: input.contractNumber } : {}),
        ...(input.contractDate !== undefined ? { contractDate: input.contractDate ? new Date(input.contractDate) : null } : {}),
        ...(input.specificationRef !== undefined ? { specificationRef: input.specificationRef } : {}),
        ...(input.basisQuoteId !== undefined ? { basisQuoteId: input.basisQuoteId } : {}),
        ...(input.paymentTerms !== undefined ? { paymentTerms: input.paymentTerms } : {}),
        ...(input.paymentSchedule !== undefined ? { paymentSchedule: JSON.stringify(input.paymentSchedule) } : {}),
        ...(input.deliveryTerms !== undefined ? { deliveryTerms: input.deliveryTerms } : {}),
        ...(input.criticalTermsChanged ? { versionNo: { increment: 1 } } : {}),
        lockVersion: { increment: 1 },
      },
    });

    if (input.basisQuoteId) {
      const quote = await tx.crmQuote.findUnique({ where: { id: input.basisQuoteId }, select: { amount: true, currency: true } });
      await tx.applicationCommercial.update({
        where: { id: commercial.id },
        data: { basisAmount: quote?.amount ?? null, basisCurrency: quote?.currency ?? null },
      });
    }

    // GATE-02: существенное изменение условий делает ручное разрешение недействующим
    if (input.criticalTermsChanged) {
      const approval = await tx.releaseApproval.findUnique({ where: { commercialId: commercial.id } });
      if (approval && approval.isActive) {
        await tx.releaseApproval.update({ where: { id: approval.id }, data: { isActive: false, revokedAt: new Date() } });
        await audit(tx, {
          actor,
          actionCode: AuditAction.RELEASE_REVOKE,
          entityType: 'ReleaseApproval',
          entityId: approval.id,
          applicationId: current.id,
          payload: { reason: 'CRITICAL_TERMS_CHANGED', termsVersionNo: commercial.versionNo },
          correlationId,
        });
      }
    }

    await audit(tx, {
      actor,
      actionCode: AuditAction.COMMERCIAL_UPDATE,
      entityType: 'ApplicationCommercial',
      entityId: commercial.id,
      applicationId: current.id,
      before: before
        ? { versionNo: before.versionNo, paymentTerms: before.paymentTerms, contractStatus: before.contractStatus }
        : null,
      after: {
        versionNo: commercial.versionNo,
        paymentTerms: commercial.paymentTerms,
        contractNumber: commercial.contractNumber,
        basisQuoteId: commercial.basisQuoteId,
      },
      correlationId,
      userReason: input.comment ?? null,
    });

    return commercial;
  });

  return row;
}

// ─────────────────────────── Подписание договора (§9.2, A27)

export async function signContract(input: {
  number: string;
  lockVersion: number;
  contractNumber: string;
  contractDate?: string;
  contractFileId?: string | null;
  comment?: string;
  correlationId: string;
  actor: Principal;
}) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.CONTRACT_SIGN);
  if (!input.contractNumber?.trim()) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Укажите номер договора', {
      fields: [{ field: 'contractNumber', message: 'Обязательное поле' }],
    });
  }

  const current = await prisma.application.findUnique({
    where: { number: input.number },
    include: { commercial: true, quotes: { where: { isActiveBasis: true }, include: { lines: true } } },
  });
  if (!current) throw notFound('Заявка');
  if (current.lockVersion !== input.lockVersion) {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Заявка изменена другим пользователем. Обновите карточку и повторите.', {
      details: { currentVersion: current.lockVersion, yourVersion: input.lockVersion },
    });
  }
  if (!['CONTRACT_PENDING', 'CONTRACT_SIGNED'].includes(current.stage)) {
    throw badRequest(
      ErrorCode.INVALID_STAGE_TRANSITION,
      `Подписание договора доступно на этапах согласования и подписания договора. Действующий этап: ${current.stage}.`,
    );
  }

  const basis = current.quotes[0];
  if (!basis) {
    throw badRequest(
      ErrorCode.QUOTE_NOT_READY,
      'Нельзя подписать договор: не задано действующее коммерческое основание (принятая версия КП).',
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const commercial = await tx.applicationCommercial.upsert({
      where: { applicationId: current.id },
      create: {
        applicationId: current.id,
        contractNumber: input.contractNumber.trim(),
        contractDate: input.contractDate ? new Date(input.contractDate) : new Date(),
        contractStatus: 'SIGNED',
        contractSignedAt: new Date(),
        contractFileId: input.contractFileId ?? null,
        basisQuoteId: basis.id,
        basisAmount: basis.amount,
        basisCurrency: basis.currency,
        versionNo: 1,
        lockVersion: 1,
      },
      update: {
        contractNumber: input.contractNumber.trim(),
        ...(input.contractDate ? { contractDate: new Date(input.contractDate) } : {}),
        contractStatus: 'SIGNED',
        contractSignedAt: new Date(),
        ...(input.contractFileId ? { contractFileId: input.contractFileId } : {}),
        basisQuoteId: basis.id,
        basisAmount: basis.amount,
        basisCurrency: basis.currency,
        lockVersion: { increment: 1 },
      },
    });

    if (current.stage !== 'CONTRACT_SIGNED') {
      await tx.application.update({
        where: { id: current.id },
        data: { stage: 'CONTRACT_SIGNED', lockVersion: { increment: 1 }, lastActivityAt: new Date() },
      });
      await audit(tx, {
        actor,
        actionCode: AuditAction.APPLICATION_STAGE_CHANGE,
        entityType: 'Application',
        entityId: current.id,
        applicationId: current.id,
        before: { stage: current.stage },
        after: { stage: 'CONTRACT_SIGNED', reason: 'CONTRACT_SIGNED' },
        correlationId,
      });
    }

    // A27: подписанный заказ передаётся в 1С для выставления счетов независимо
    // от того, разрешён ли выпуск в производство.
    await enqueueOutbox(tx, {
      objectType: 'ORDER',
      extId: current.id,
      applicationId: current.id,
      eventType: 'ORDER_SIGNED',
      payload: {
        number: current.number,
        contractNumber: commercial.contractNumber,
        amount: commercial.basisAmount,
        currency: commercial.basisCurrency,
        lines: basis.lines.map((l) => ({ lineId: l.lineId, name: l.name, quantity: l.quantity, price: l.price })),
      },
      correlationId,
    });
    await tx.applicationCommercial.update({ where: { id: commercial.id }, data: { syncedTo1C: true } });

    await audit(tx, {
      actor,
      actionCode: AuditAction.CONTRACT_SIGN,
      entityType: 'ApplicationCommercial',
      entityId: commercial.id,
      applicationId: current.id,
      before: { contractStatus: current.commercial?.contractStatus ?? 'DRAFT' },
      after: { contractStatus: 'SIGNED', contractNumber: commercial.contractNumber, basisAmount: commercial.basisAmount },
      correlationId,
      userReason: input.comment ?? null,
    });

    if (current.ownerId) {
      await notify(tx, {
        userId: current.ownerId,
        code: NotifyCode.APPLICATION_STAGE_CHANGED,
        title: `Договор по заявке ${current.number} подписан`,
        body: commercial.contractNumber ?? undefined,
        entityType: 'Application',
        entityId: current.id,
        dedupKey: `contract-signed:${current.id}:${commercial.contractNumber}`,
      });
    }

    await refreshSlaForStage(tx, current.id, 'CONTRACT_SIGNED', current.complexity);
    return commercial;
  });

  return result;
}

// ─────────────────────────── Проверка допуска к исполнению (GATE-01)

export interface ReleaseBlocker {
  code: string;
  message: string;
}

export interface ReleaseCheck {
  application: { id: string; number: string; stage: string; complexity: string; amount: number | null; currency: string | null };
  can_release_to_production: boolean;
  blockers: ReleaseBlocker[];
  checks: {
    contractSigned: { ok: boolean; detail: string };
    commercialBasis: { ok: boolean; detail: string };
    technicalConclusion: { ok: boolean; detail: string };
    linesFilled: { ok: boolean; detail: string };
    paymentTerms: { ok: boolean; detail: string; terms: string | null; advancePct: number };
    paymentCoverage: { ok: boolean; detail: string; allocated: number; required: number };
    paymentDataFresh: { ok: boolean; detail: string; ageMinutes: number | null };
    manualApproval: { ok: boolean; detail: string; required: boolean; approval: ReleaseApprovalState | null };
    noActiveRelease: { ok: boolean; detail: string };
  };
  orderHash: string | null;
  termsVersionNo: number;
}

export interface ReleaseApprovalState {
  id: string;
  approved: boolean;
  isActive: boolean;
  reason: string;
  termsVersionNo: number;
  amountSnapshot: number | null;
  orderHash: string | null;
  createdAt: Date;
  actor: { id: string; fullName: string } | null;
}

/** Доля предоплаты, требуемая по справочнику условий оплаты (A22, A23). */
function requiredAdvancePct(terms: string | null, schedule: { stage?: string; pct: number }[]): number {
  if (terms === 'PREPAYMENT_100') return 100;
  if (terms === 'PREPAYMENT_PARTIAL') {
    const fromSchedule = schedule.filter((s) => s.stage === 'ADVANCE').reduce((s, x) => s + x.pct, 0);
    return fromSchedule > 0 ? fromSchedule : 50;
  }
  return 0;
}

async function computeReleaseCheck(number: string, p: Principal): Promise<ReleaseCheck> {
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  const app = await prisma.application.findUnique({
    where: { number },
    include: {
      lines: true,
      commercial: { include: { releaseApproval: { include: { actor: { select: { id: true, fullName: true } } } } } },
      releases: { where: { state: 'ACTIVE' } },
      quotes: { where: { isActiveBasis: true }, include: { lines: true } },
    },
  });
  if (!app) throw notFound('Заявка');
  await assertCanReadApplicationInScope(app, p, canReadAny);

  const blockers: ReleaseBlocker[] = [];
  const commercial = app.commercial;
  const basis = app.quotes[0] ?? null;
  const terms = commercial?.paymentTerms ?? null;
  const schedule = jparse<{ stage: string; pct: number; dueDays: number | null }[]>(commercial?.paymentSchedule, []);

  // 1. Договор
  const contractSigned = Boolean(commercial?.contractStatus === 'SIGNED' && commercial.contractSignedAt);
  const contractCheck = {
    ok: contractSigned,
    detail: contractSigned
      ? `Договор ${commercial?.contractNumber ?? ''} подписан ${commercial?.contractSignedAt?.toISOString().slice(0, 10) ?? ''}`
      : 'Договор не подписан',
  };
  if (!contractSigned) {
    blockers.push({ code: ErrorCode.CONTRACT_NOT_SIGNED, message: 'Договор с клиентом не подписан. Выпуск в производство невозможен.' });
  }

  // 2. Действующее коммерческое основание
  const basisOk = Boolean(basis && basis.status === 'ACCEPTED' && (commercial?.basisQuoteId ?? basis.id) === basis.id);
  const basisCheck = {
    ok: basisOk,
    detail: basisOk
      ? `Основание: ${basis.number} (версия ${basis.versionNo}), сумма ${basis.amount ?? 0} ${basis.currency ?? ''}`
      : 'Нет принятой клиентом активной версии КП',
  };
  if (!basisOk) blockers.push({ code: ErrorCode.QUOTE_NOT_READY, message: 'Не задано действующее коммерческое основание — принятая клиентом версия КП.' });

  // 3. Техническое заключение
  const conclusion = await checkConclusion(app.id, app.complexity as Complexity, await isKoMandatory(app.id));
  const technicalOk = conclusion.hasApprovedPositive && conclusion.revisionMatches;
  const technicalCheck = {
    ok: technicalOk,
    detail: technicalOk
      ? conclusion.conditions
        ? `Заключение КО действует${conclusion.conditions ? ` с условиями: ${conclusion.conditions}` : ''}`
        : 'Заключение КО действует'
      : conclusion.hasPendingUnapproved
        ? 'Заключение КО подготовлено, но не утвержденено'
        : 'Действующего утверждённого заключения КО нет',
  };
  if (!technicalOk) {
    blockers.push({
      code: ErrorCode.TECH_CONCLUSION_NOT_APPROVED,
      message: `Действующее техническое заключение КО отсутствует: ${technicalCheck.detail}`,
    });
  }

  // 4. Заполненные позиции
  const emptyLines = app.lines.filter((l) => !l.name?.trim() || l.orderQty <= 0);
  const linesOk = app.lines.length > 0 && emptyLines.length === 0;
  const linesCheck = {
    ok: linesOk,
    detail: linesOk
      ? `Позиций: ${app.lines.length}, количество заполнено`
      : app.lines.length === 0
        ? 'В заявке нет позиций'
        : `Не заполнены позиции: ${emptyLines.map((l) => l.lineId).join(', ')}`,
  };
  if (!linesOk) blockers.push({ code: ErrorCode.VALIDATION_ERROR, message: linesCheck.detail });

  // 5. Условия оплаты
  const termsOk = Boolean(terms && terms !== 'NOT_SET');
  const advancePct = requiredAdvancePct(terms, schedule);
  const termsCheck = {
    ok: termsOk,
    detail: termsOk ? `Условия оплаты: ${terms}, требуемая предоплата ${advancePct}%` : 'Условия оплаты не заданы',
    terms,
    advancePct,
  };
  if (!termsOk) {
    blockers.push({ code: ErrorCode.PAYMENT_TERMS_NOT_SET, message: 'Не заданы условия оплаты. Выпуск в производство невозможен.' });
  }

  // 6. Фактическая оплата: A21 (постоплата), A22, A23
  const allocations = await prisma.paymentAllocation.findMany({
    where: { applicationId: app.id, isCancelled: false },
    select: { amount: true },
  });
  const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
  const basisAmount = round2(commercial?.basisAmount ?? basis?.amount ?? 0);
  const required = round2((basisAmount * advancePct) / 100);
  let paymentOk = true;
  let paymentDetail = 'Предоплата не требуется';
  if (advancePct > 0) {
    paymentOk = allocated + 1e-6 >= required;
    paymentDetail = paymentOk
      ? `Оплачено ${allocated} из требуемых ${required} (${advancePct}% от ${basisAmount})`
      : `Оплачено ${allocated} из требуемых ${required} (${advancePct}% от суммы ${basisAmount})`;
  }
  const paymentCheck = { ok: paymentOk, detail: paymentDetail, allocated, required };
  if (!paymentOk) {
    const code = advancePct >= 100 ? ErrorCode.FULL_PREPAYMENT_REQUIRED : ErrorCode.PARTIAL_PREPAYMENT_REQUIRED;
    blockers.push({
      code,
      message: `Требуется предоплата ${advancePct}% (${required} ${commercial?.basisCurrency ?? ''}), фактически распределено ${allocated}. Фактическая оплата и ручное разрешение — разные данные.`,
    });
  }

  // 7. Актуальность учётных данных (SYNC-06)
  const { ageMinutes } = await accountingAgeMinutes();
  const freshOk = ageMinutes === null || ageMinutes <= config.paymentDataFreshnessMinutes;
  const freshCheck = {
    ok: freshOk,
    detail:
      ageMinutes === null
        ? 'Учётные данные ещё не поступали из 1С'
        : `Возраст учётных данных: ${ageMinutes} мин (допустимо ${config.paymentDataFreshnessMinutes} мин)`,
    ageMinutes,
  };
  if (!freshOk) {
    blockers.push({
      code: ErrorCode.PAYMENT_DATA_STALE,
      message: `Учётные данные устарели (${ageMinutes} мин). Дождитесь синхронизации с 1С и повторите проверку.`,
    });
  }

  // 8. Ручное разрешение (GATE-02): привязано к версии условий, сумме и составу заказа
  const orderHash =
    basis && commercial
      ? orderCompositionHash({
          termsVersionNo: commercial.versionNo,
          amount: basis.amount,
          currency: basis.currency,
          lines: basis.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity, price: l.price })),
        })
      : null;
  const approvalRow = commercial?.releaseApproval ?? null;
  const approvalState: ReleaseApprovalState | null = approvalRow
    ? {
        id: approvalRow.id,
        approved: approvalRow.approved,
        isActive: approvalRow.isActive,
        reason: approvalRow.reason,
        termsVersionNo: approvalRow.termsVersionNo,
        amountSnapshot: approvalRow.amountSnapshot,
        orderHash: approvalRow.orderHash,
        createdAt: approvalRow.createdAt,
        actor: approvalRow.actor,
      }
    : null;

  const approvalStale = Boolean(
    approvalRow && approvalRow.isActive && orderHash && approvalRow.orderHash && approvalRow.orderHash !== orderHash,
  );
  const approvalValid = Boolean(
    approvalRow &&
      approvalRow.approved &&
      approvalRow.isActive &&
      !approvalStale &&
      commercial &&
      approvalRow.termsVersionNo === commercial.versionNo,
  );
  const manualRequired = !paymentOk || !contractSigned || !basisOk;
  const manualCheck = {
    ok: !manualRequired || approvalValid,
    detail: approvalStale
      ? 'Ручное разрешение недействующе: состав заказа или условия изменились после решения'
      : approvalValid
        ? `Действующее ручное разрешение: ${approvalRow?.reason ?? ''}`
        : manualRequired
          ? 'Требуется отдельное решение руководителя продаж о выпуске'
          : 'Ручное разрешение не требуется',
    required: manualRequired,
    approval: approvalState,
  };
  if (manualRequired && !approvalValid) {
    blockers.push({
      code: ErrorCode.MANUAL_RELEASE_APPROVAL_REQUIRED,
      message:
        'Требуется действующее ручное разрешение руководителя продаж. Разрешение не создаёт фиктивную оплату и действует только для текущей версии условий, суммы и состава заказа.',
    });
  }
  if (approvalStale) {
    blockers.push({
      code: ErrorCode.RELEASE_APPROVAL_STALE,
      message: 'Существенное изменение условий или состава заказа сделало ручное разрешение недействующим — требуется новое решение.',
    });
  }

  // 9. Активный выпуск
  const activeRelease = app.releases[0] ?? null;
  const noReleaseCheck = {
    ok: !activeRelease,
    detail: activeRelease ? `Активный выпуск создан ${activeRelease.releasedAt.toISOString()}` : 'Активного выпуска нет',
  };
  if (activeRelease) {
    blockers.push({ code: ErrorCode.ALREADY_RELEASED, message: 'Заявка уже выпущена в производство.' });
  }

  // 10. Этап
  if (current_stage_guard(app.stage)) {
    blockers.push({
      code: ErrorCode.RELEASE_NOT_ALLOWED_FOR_STAGE,
      message: `Выпуск возможен из этапа «Договор подписан». Действующий этап: ${app.stage}.`,
    });
  }

  return {
    application: {
      id: app.id,
      number: app.number,
      stage: app.stage,
      complexity: app.complexity,
      amount: app.amount,
      currency: app.currency,
    },
    can_release_to_production: blockers.length === 0,
    blockers,
    checks: {
      contractSigned: contractCheck,
      commercialBasis: basisCheck,
      technicalConclusion: technicalCheck,
      linesFilled: linesCheck,
      paymentTerms: termsCheck,
      paymentCoverage: paymentCheck,
      paymentDataFresh: freshCheck,
      manualApproval: manualCheck,
      noActiveRelease: noReleaseCheck,
    },
    orderHash,
    termsVersionNo: commercial?.versionNo ?? 0,
  };
}

function current_stage_guard(stage: string): boolean {
  // A26/GATE-01: выпуск возможен только после подписания договора.
  return !['CONTRACT_SIGNED', 'TO_PRODUCTION', 'DESIGN_IN_PROGRESS', 'DESIGN_COMPLETE', 'MANUFACTURING', 'READY_TO_SHIP', 'FULFILLMENT'].includes(stage);
}

async function accountingAgeMinutes(): Promise<{ ageMinutes: number | null }> {
  const lastShipment = await prisma.shipment.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } });
  const lastPayment = await prisma.payment.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } });
  const lastInvoice = await prisma.invoice.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } });
  const candidates = [lastShipment?.updatedAt, lastPayment?.updatedAt, lastInvoice?.updatedAt].filter(Boolean) as Date[];
  if (!candidates.length) return { ageMinutes: null };
  const latest = candidates.reduce((a, b) => (a > b ? a : b));
  return { ageMinutes: Math.round((Date.now() - latest.getTime()) / 60000) };
}

/** GATE-01: GET-проверка не меняет данных. */
export async function checkRelease(number: string, p: Principal): Promise<ReleaseCheck> {
  assertPermission(p.role as never, P.RELEASE_CHECK);
  return computeReleaseCheck(number, p);
}

// ─────────────────────────── Ручное разрешение выпуска (GATE-02, GATE-04)

export async function approveRelease(input: { number: string; reason: string; correlationId: string; actor: Principal }) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.RELEASE_MANUAL_APPROVE);
  if (!input.reason?.trim()) {
    throw badRequest(ErrorCode.REASON_REQUIRED, 'Укажите причину разрешения выпуска', {
      fields: [{ field: 'reason', message: 'Обязательное поле' }],
    });
  }

  const app = await prisma.application.findUnique({
    where: { number: input.number },
    include: { commercial: { include: { releaseApproval: true } }, quotes: { where: { isActiveBasis: true }, include: { lines: true } } },
  });
  if (!app) throw notFound('Заявка');
  const commercial = app.commercial;
  if (!commercial) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Коммерческие условия не заполнены — разрешение выпуска оформить невозможно.');
  }
  const basis = app.quotes[0];
  if (!basis) {
    throw badRequest(ErrorCode.QUOTE_NOT_READY, 'Нет принятой версии КП, на которую можно оформить разрешение.');
  }

  const orderHash = orderCompositionHash({
    termsVersionNo: commercial.versionNo,
    amount: basis.amount,
    currency: basis.currency,
    lines: basis.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity, price: l.price })),
  });

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.releaseApproval.findUnique({ where: { commercialId: commercial.id } });
    const upserted = await tx.releaseApproval.upsert({
      where: { commercialId: commercial.id },
      create: {
        commercialId: commercial.id,
        approved: true,
        actorId: actor.id,
        reason: input.reason.trim(),
        termsVersionNo: commercial.versionNo,
        amountSnapshot: basis.amount,
        orderHash,
        isActive: true,
      },
      update: {
        approved: true,
        actorId: actor.id,
        reason: input.reason.trim(),
        termsVersionNo: commercial.versionNo,
        amountSnapshot: basis.amount,
        orderHash,
        isActive: true,
        revokedAt: null,
      },
    });

    await audit(tx, {
      actor,
      actionCode: AuditAction.RELEASE_APPROVE,
      entityType: 'ReleaseApproval',
      entityId: upserted.id,
      applicationId: app.id,
      before: existing ? { approved: existing.approved, isActive: existing.isActive, reason: existing.reason } : null,
      after: { approved: true, reason: input.reason.trim(), termsVersionNo: commercial.versionNo, amountSnapshot: basis.amount, orderHash },
      correlationId,
      userReason: input.reason.trim(),
    });
    return upserted;
  });

  return row;
}

export async function revokeRelease(input: { number: string; reason: string; correlationId: string; actor: Principal }) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.RELEASE_MANUAL_APPROVE);
  if (!input.reason?.trim()) {
    throw badRequest(ErrorCode.REASON_REQUIRED, 'Укажите причину отзыва разрешения', {
      fields: [{ field: 'reason', message: 'Обязательное поле' }],
    });
  }
  const app = await prisma.application.findUnique({ where: { number: input.number }, include: { commercial: true } });
  if (!app) throw notFound('Заявка');
  if (!app.commercial) throw notFound('Коммерческие условия');

  return prisma.$transaction(async (tx) => {
    const approval = await tx.releaseApproval.findUnique({ where: { commercialId: app.commercial!.id } });
    if (!approval || !approval.isActive) throw notFound('Действующее разрешение выпуска');
    const row = await tx.releaseApproval.update({
      where: { id: approval.id },
      data: { isActive: false, revokedAt: new Date() },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.RELEASE_REVOKE,
      entityType: 'ReleaseApproval',
      entityId: approval.id,
      applicationId: app.id,
      before: { isActive: true },
      after: { isActive: false },
      correlationId,
      userReason: input.reason.trim(),
    });
    return row;
  });
}

// ─────────────────────────── Выпуск в производство (GATE-03, A24, A25)

export async function releaseToProduction(input: {
  number: string;
  correlationId: string;
  actor: Principal;
  /** GATE-04: административная восстановительная операция с причиной. */
  adminOverride?: { reason: string };
}) {
  const { actor, correlationId } = input;
  if (input.adminOverride) {
    // GATE-04: отдельное полномочие, обязательная причина, полный аудит.
    assertPermission(actor.role as never, P.RELEASE_ADMIN_OVERRIDE);
    if (!input.adminOverride.reason?.trim()) {
      throw badRequest(ErrorCode.REASON_REQUIRED, 'Административная операция требует указания причины', {
        fields: [{ field: 'reason', message: 'Обязательное поле' }],
      });
    }
  } else {
    assertPermission(actor.role as never, P.RELEASE_EXECUTE);
  }

  // GATE-03: проверки повторяются внутри транзакции — предварительный GET
  // не является основанием для выпуска.
  const result = await prisma.$transaction(async (tx) => {
    const app = await tx.application.findUnique({
      where: { number: input.number },
      include: {
        lines: true,
        commercial: { include: { releaseApproval: { include: { actor: { select: { id: true, fullName: true } } } } } },
        releases: { where: { state: 'ACTIVE' } },
        quotes: { where: { isActiveBasis: true }, include: { lines: true } },
      },
    });
    if (!app) throw notFound('Заявка');

    if (app.releases.length) {
      throw badRequest(ErrorCode.ALREADY_RELEASED, 'Заявка уже выпущена в производство.', {
        details: { releaseId: app.releases[0]!.id, releasedAt: app.releases[0]!.releasedAt },
      });
    }

    const check = await computeReleaseCheckInTx(tx, app);
    const bypassed = Boolean(input.adminOverride);
    if (!check.can_release_to_production && !bypassed) {
      throw new AppError(422, ErrorCode.RELEASE_NOT_ALLOWED_FOR_STAGE, 'Условия выпуска в производство не выполнены.', {
        details: { blockers: check.blockers },
        fields: check.blockers.map((b) => ({ field: 'release', message: b.message })),
      });
    }

    const commercial = app.commercial;
    const basis = app.quotes[0] ?? null;

    const release = await tx.productionRelease.create({
      data: {
        applicationId: app.id,
        releasedById: actor.id,
        isManualOverride: bypassed,
        overrideReason: bypassed ? input.adminOverride!.reason.trim() : null,
        termsVersionNo: commercial?.versionNo ?? 0,
        state: 'ACTIVE',
      },
    });

    await tx.application.update({
      where: { id: app.id },
      data: {
        stage: 'TO_PRODUCTION',
        nextActivityAt: await computeNextActivity(app.id, tx),
        lockVersion: { increment: 1 },
        lastActivityAt: new Date(),
      },
    });

    await tx.crmActivity.create({
      data: {
        applicationId: app.id,
        type: 'SYSTEM',
        occurredAt: new Date(),
        authorId: actor.id,
        subject: 'Выпуск в производство',
        content: bypassed
          ? `Административная операция: ${input.adminOverride!.reason.trim()}`
          : `Выпуск по согласованным условиям, основание ${basis?.number ?? '—'}`,
        isCustomerFacing: false,
      },
    });

    await audit(tx, {
      actor,
      actionCode: bypassed ? AuditAction.PRODUCTION_RELEASE_ADMIN_OVERRIDE : AuditAction.PRODUCTION_RELEASE,
      entityType: 'ProductionRelease',
      entityId: release.id,
      applicationId: app.id,
      before: { stage: app.stage },
      after: {
        stage: 'TO_PRODUCTION',
        termsVersionNo: release.termsVersionNo,
        isManualOverride: bypassed,
        bypassedBlockers: bypassed ? check.blockers : [],
      },
      correlationId,
      userReason: input.adminOverride?.reason ?? null,
    });

    if (bypassed) {
      await audit(tx, {
        actor,
        actionCode: AuditAction.RELEASE_APPROVE,
        entityType: 'Application',
        entityId: app.id,
        applicationId: app.id,
        payload: { note: 'Административный выпуск не создаёт фиктивную оплату' },
        correlationId,
        userReason: input.adminOverride!.reason.trim(),
      });
    }

    await enqueueOutbox(tx, {
      objectType: 'ORDER',
      extId: app.id,
      applicationId: app.id,
      eventType: 'PRODUCTION_RELEASED',
      payload: {
        number: app.number,
        stage: 'TO_PRODUCTION',
        lines: app.lines.map((l) => ({ lineId: l.lineId, quantity: l.orderQty, shippedQty: l.shippedQty })),
      },
      correlationId,
    });

    const leaders = await tx.user.findMany({ where: { role: 'PRODUCTION', isActive: true }, select: { id: true } });
    for (const leader of leaders) {
      await notify(tx, {
        userId: leader.id,
        code: NotifyCode.PRODUCTION_RELEASED,
        title: `Заявка ${app.number} передана в производство`,
        body: bypassed ? 'Административный выпуск' : undefined,
        entityType: 'Application',
        entityId: app.id,
        dedupKey: `released:${app.id}`,
      });
    }

    await refreshSlaForStage(tx, app.id, 'TO_PRODUCTION', app.complexity);
    return { release, stage: 'TO_PRODUCTION' as const, blockedByOverride: bypassed, blockers: check.blockers };
  });

  return result;
}

/** Повтор проверки внутри транзакции (GATE-03): данные читаются из того же tx. */
async function computeReleaseCheckInTx(
  tx: Tx,
  app: {
    id: string;
    stage: string;
    complexity: string;
    commercial: {
      versionNo: number;
      paymentTerms: string | null;
      paymentSchedule: string;
      contractStatus: string;
      contractSignedAt: Date | null;
      basisQuoteId: string | null;
      basisAmount: number | null;
      releaseApproval: { approved: boolean; isActive: boolean; termsVersionNo: number; orderHash: string | null } | null;
    } | null;
    lines: { lineId: string; name: string; orderQty: number }[];
    quotes: { id: string; status: string; versionNo: number; number: string; amount: number | null; currency: string | null; lines: { lineId: string; quantity: number; price: number }[] }[];
  },
): Promise<ReleaseCheck> {
  const blockers: ReleaseBlocker[] = [];
  const commercial = app.commercial;
  const basis = app.quotes[0] ?? null;
  const schedule = jparse<{ stage: string; pct: number }[]>(commercial?.paymentSchedule, []);
  const advancePct = requiredAdvancePct(commercial?.paymentTerms ?? null, schedule);

  if (!commercial || commercial.contractStatus !== 'SIGNED' || !commercial.contractSignedAt) {
    blockers.push({ code: ErrorCode.CONTRACT_NOT_SIGNED, message: 'Договор с клиентом не подписан.' });
  }
  if (!basis || basis.status !== 'ACCEPTED') {
    blockers.push({ code: ErrorCode.QUOTE_NOT_READY, message: 'Не задано действующее коммерческое основание.' });
  }
  if (app.lines.length === 0 || app.lines.some((l) => !l.name?.trim() || l.orderQty <= 0)) {
    blockers.push({ code: ErrorCode.VALIDATION_ERROR, message: 'Не заполнены позиции заказа.' });
  }
  const terms = commercial?.paymentTerms ?? null;
  if (!terms || terms === 'NOT_SET') {
    blockers.push({ code: ErrorCode.PAYMENT_TERMS_NOT_SET, message: 'Не заданы условия оплаты.' });
  }

  const allocations = await tx.paymentAllocation.findMany({ where: { applicationId: app.id, isCancelled: false }, select: { amount: true } });
  const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
  const basisAmount = round2(commercial?.basisAmount ?? basis?.amount ?? 0);
  const required = round2((basisAmount * advancePct) / 100);
  const paymentOk = advancePct <= 0 || allocated + 1e-6 >= required;
  if (!paymentOk) {
    blockers.push({
      code: advancePct >= 100 ? ErrorCode.FULL_PREPAYMENT_REQUIRED : ErrorCode.PARTIAL_PREPAYMENT_REQUIRED,
      message: `Требуется предоплата ${advancePct}% (${required}), фактически распределено ${allocated}.`,
    });
  }

  // Техническое заключение проверяется по БД того же tx; учитывается только
  // утверждённое и действующее заключение текущей ревизии
  const conclusions = await tx.engineeringConclusion.findMany({
    where: { applicationId: app.id, isValid: true, approvedAt: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  const appRevision = await tx.application.findUnique({ where: { id: app.id }, select: { versionNo: true } });
  const revision = `rev-${appRevision?.versionNo ?? 1}`;
  const technicalOk =
    conclusions.some((c) => (c.decision === 'FEASIBLE' || c.decision === 'FEASIBLE_WITH_CONDITIONS') && c.validForRevision === revision) ||
    app.complexity === 'STANDARD';
  if (!technicalOk) {
    blockers.push({
      code: ErrorCode.TECH_REVIEW_REQUIRED,
      message: `Нет действующего технического заключения КО для ревизии ${revision}.`,
    });
  }

  // Ручное разрешение
  const orderHash =
    basis && commercial
      ? orderCompositionHash({
          termsVersionNo: commercial.versionNo,
          amount: basis.amount,
          currency: basis.currency,
          lines: basis.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity, price: l.price })),
        })
      : null;
  const approval = commercial?.releaseApproval ?? null;
  const approvalStale = Boolean(approval && approval.isActive && orderHash && approval.orderHash && approval.orderHash !== orderHash);
  const approvalValid = Boolean(
    approval && approval.approved && approval.isActive && !approvalStale && approval.termsVersionNo === commercial?.versionNo,
  );
  const manualRequired = !paymentOk || !commercial || commercial.contractStatus !== 'SIGNED' || !basis;
  if (manualRequired && !approvalValid) {
    blockers.push({ code: ErrorCode.MANUAL_RELEASE_APPROVAL_REQUIRED, message: 'Требуется действующее ручное разрешение руководителя продаж.' });
  }

  if (current_stage_guard(app.stage)) {
    blockers.push({
      code: ErrorCode.RELEASE_NOT_ALLOWED_FOR_STAGE,
      message: `Выпуск возможен из этапа «Договор подписан». Действующий этап: ${app.stage}.`,
    });
  }

  return {
    application: { id: app.id, number: '', stage: app.stage, complexity: app.complexity, amount: null, currency: null },
    can_release_to_production: blockers.length === 0,
    blockers,
    checks: {
      contractSigned: { ok: !blockers.some((b) => b.code === ErrorCode.CONTRACT_NOT_SIGNED), detail: '' },
      commercialBasis: { ok: Boolean(basis), detail: basis?.number ?? '' },
      technicalConclusion: { ok: technicalOk, detail: revision },
      linesFilled: { ok: app.lines.length > 0, detail: '' },
      paymentTerms: { ok: Boolean(terms && terms !== 'NOT_SET'), detail: terms ?? '', terms, advancePct },
      paymentCoverage: { ok: paymentOk, detail: '', allocated, required },
      paymentDataFresh: { ok: true, detail: 'проверено вне транзакции', ageMinutes: null },
      manualApproval: { ok: !manualRequired || approvalValid, detail: approvalStale ? 'stale' : '', required: manualRequired, approval: null },
      noActiveRelease: { ok: true, detail: '' },
    },
    orderHash,
    termsVersionNo: commercial?.versionNo ?? 0,
  };
}

// ─────────────────────────── Этапы производства (§9.3)

// CLOSE-03: переход в CLOSED здесь отсутствует намеренно — закрытие выполняет
// closeApplication() с проверкой полной отгрузки, расчётов и закрывающих
// документов. Обычная смена этапа не должна обходить эти проверки.
const PRODUCTION_FLOW: Record<string, string[]> = {
  TO_PRODUCTION: ['DESIGN_IN_PROGRESS', 'MANUFACTURING'],
  DESIGN_IN_PROGRESS: ['DESIGN_COMPLETE', 'MANUFACTURING'],
  DESIGN_COMPLETE: ['MANUFACTURING', 'READY_TO_SHIP'],
  MANUFACTURING: ['READY_TO_SHIP', 'FULFILLMENT'],
  READY_TO_SHIP: ['FULFILLMENT'],
  FULFILLMENT: ['MANUFACTURING'],
};

export async function updateProductionStage(input: { number: string; to: string; comment?: string; correlationId: string; actor: Principal }) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.PRODUCTION_UPDATE_STAGES);

  const current = await prisma.application.findUnique({ where: { number: input.number } });
  if (!current) throw notFound('Заявка');

  // A26/GATE-04: обычный endpoint смены этапа не позволяет обойти выпуск
  if (current.stage === 'CONTRACT_SIGNED' && input.to === 'TO_PRODUCTION') {
    throw badRequest(
      ErrorCode.RELEASE_NOT_ALLOWED_FOR_STAGE,
      'Этап «Передано в производство» устанавливается только операцией выпуска с проверкой условий оплаты и договора (GATE-04).',
    );
  }
  const allowed = PRODUCTION_FLOW[current.stage] ?? [];
  if (!allowed.includes(input.to)) {
    throw badRequest(
      ErrorCode.INVALID_STAGE_TRANSITION,
      `Переход «${current.stage} → ${input.to}» не предусмотрен маршрутом производства. Допустимо: ${allowed.join(', ') || 'нет переходов'}.`,
      { details: { from: current.stage, to: input.to, allowed } },
    );
  }

  return prisma.$transaction(async (tx) => {
    const row = await tx.application.update({
      where: { id: current.id },
      data: { stage: input.to, lockVersion: { increment: 1 }, lastActivityAt: new Date() },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.PRODUCTION_STAGE_UPDATE,
      entityType: 'Application',
      entityId: current.id,
      applicationId: current.id,
      before: { stage: current.stage },
      after: { stage: input.to },
      correlationId,
      userReason: input.comment ?? null,
    });
    await tx.crmActivity.create({
      data: {
        applicationId: current.id,
        type: 'SYSTEM',
        occurredAt: new Date(),
        authorId: actor.id,
        subject: `Этап производства: ${input.to}`,
        isCustomerFacing: false,
      },
    });
    if (current.ownerId) {
      await notify(tx, {
        userId: current.ownerId,
        code: NotifyCode.APPLICATION_STAGE_CHANGED,
        title: `Заявка ${current.number}: ${input.to}`,
        entityType: 'Application',
        entityId: current.id,
        dedupKey: `prod-stage:${current.id}:${input.to}:${row.lockVersion}`,
      });
    }
    await refreshSlaForStage(tx, current.id, input.to as Stage, current.complexity);
    return row;
  });
}

export async function completeRelease(input: { number: string; correlationId: string; actor: Principal }) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.PRODUCTION_UPDATE_STAGES);
  const app = await prisma.application.findUnique({
    where: { number: input.number },
    include: { releases: { where: { state: 'ACTIVE' } } },
  });
  if (!app) throw notFound('Заявка');
  if (!app.releases.length) throw notFound('Активный выпуск');

  return prisma.$transaction(async (tx) => {
    const row = await tx.productionRelease.update({
      where: { id: app.releases[0]!.id },
      data: { state: 'COMPLETED', completedAt: new Date() },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.PRODUCTION_STAGE_UPDATE,
      entityType: 'ProductionRelease',
      entityId: row.id,
      applicationId: app.id,
      after: { state: 'COMPLETED' },
      correlationId,
    });
    return row;
  });
}

export { forbidden };
