import { prisma } from '../lib/prisma.js';
import { ErrorCode, badRequest } from '../errors.js';
import { P, assertPermission, permissionsFor, ROLE_SCOPE, SCOPE } from '../domain/rbac.js';
import { applyScope, type Principal } from '../domain/scope.js';
import { PIPELINE_STAGES, STAGE_LABELS, type Stage } from '../domain/constants.js';
import { dateParam, numParam } from '../lib/query.js';

/**
 * Рабочий стол и аналитика (§10.3, A39).
 *
 * Агрегаты считаются по той же области видимости, что и списки: у сотрудника
 * продаж не возникает ни одного показателя, раскрывающего чужие данные.
 * Суммы разных валют не складываются (§10.3). Рейтинги сотрудников не
 * формируются. Отменённые и архивные записи исключаются из воронки.
 */

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function period(query: Record<string, unknown>): { from: Date; to: Date } {
  const from = dateParam(query, 'from') ?? new Date(Date.now() - 90 * 86400_000);
  const to = dateParam(query, 'to') ?? new Date();
  if (from > to) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Начало периода позже его окончания', {
      fields: [{ field: 'from', message: 'Некорректный период' }],
    });
  }
  return { from, to };
}

/** Суммы группируются по валюте: складывать RUB и USD нельзя (§10.3). */
function sumByCurrency<T extends { currency: string | null; amount: number | null }>(rows: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const cur = r.currency ?? 'RUB';
    out[cur] = round2((out[cur] ?? 0) + (r.amount ?? 0));
  }
  return out;
}

export async function getPipeline(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.ANALYTICS_READ);
  const { from, to } = period(query);
  const ownerId = query.ownerId ? String(query.ownerId) : undefined;

  const base = applyScope(
    {
      createdAt: { gte: from, lte: to },
      ...(ownerId ? { ownerId } : {}),
    },
    p,
  );

  const rows = await prisma.application.findMany({
    where: base,
    select: {
      id: true,
      stage: true,
      amount: true,
      currency: true,
      complexity: true,
      lossReason: true,
      isClosed: true,
      createdAt: true,
      updatedAt: true,
      owner: { select: { id: true, fullName: true } },
    },
  });

  const active = rows.filter((r) => !['CANCELLED', 'ARCHIVED'].includes(r.stage));

  const byStage = PIPELINE_STAGES.map((stage) => {
    const inStage = active.filter((r) => r.stage === stage);
    return {
      stage,
      label: STAGE_LABELS[stage as Stage],
      count: inStage.length,
      amountByCurrency: sumByCurrency(inStage),
    };
  });

  const lost = rows.filter((r) => r.stage === 'CANCELLED');
  const lossReasons = new Map<string, number>();
  for (const r of lost) {
    const key = r.lossReason ?? 'NOT_SPECIFIED';
    lossReasons.set(key, (lossReasons.get(key) ?? 0) + 1);
  }

  const won = rows.filter((r) => r.stage === 'CLOSED');

  // Конверсия по этапам: из предыдущего этапа в следующий
  const stageHistory = await prisma.auditEvent.findMany({
    where: {
      applicationId: { in: rows.map((r) => r.id) },
      actionCode: { in: ['APPLICATION_STAGE_CHANGE', 'PRODUCTION_RELEASE', 'APPLICATION_CLOSE', 'APPLICATION_CANCEL'] },
    },
    select: { applicationId: true, actionCode: true, createdAt: true, beforeJson: true, afterJson: true },
    orderBy: { createdAt: 'asc' },
  });

  // Длительность этапа: интервал между двумя соседними событиями смены этапа
  // одной заявки относится к этапу, в котором она находилась в этом интервале.
  const byApplication = new Map<string, { at: Date; to: string }[]>();
  for (const ev of stageHistory) {
    const after = safeJson<{ stage?: string }>(ev.afterJson);
    if (!ev.applicationId || !after?.stage) continue;
    const arr = byApplication.get(ev.applicationId) ?? [];
    arr.push({ at: ev.createdAt, to: after.stage });
    byApplication.set(ev.applicationId, arr);
  }
  const durations = new Map<string, number[]>();
  for (const events of byApplication.values()) {
    for (let i = 0; i < events.length - 1; i += 1) {
      const stage = events[i]!.to;
      const hours = (events[i + 1]!.at.getTime() - events[i]!.at.getTime()) / 3600_000;
      if (!Number.isFinite(hours) || hours < 0) continue;
      const arr = durations.get(stage) ?? [];
      arr.push(hours);
      durations.set(stage, arr);
    }
  }
  const stageDurations = [...durations.entries()].map(([stage, hours]) => {
    const sorted = [...hours].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
    return {
      stage,
      label: STAGE_LABELS[stage as Stage] ?? stage,
      samples: sorted.length,
      medianHours: round2(median),
      maxHours: round2(sorted[sorted.length - 1] ?? 0),
    };
  });

  return {
    period: { from, to },
    scope: ROLE_SCOPE[p.role as keyof typeof ROLE_SCOPE] ?? SCOPE.NONE,
    totals: {
      created: rows.length,
      active: active.length,
      won: won.length,
      lost: lost.length,
      amountByCurrency: sumByCurrency(active),
      conversionToContract: denominator(rows.length) ? round2((rows.filter((r) => ['CONTRACT_PENDING', 'CONTRACT_SIGNED', 'TO_PRODUCTION', 'DESIGN_IN_PROGRESS', 'DESIGN_COMPLETE', 'MANUFACTURING', 'READY_TO_SHIP', 'FULFILLMENT', 'CLOSED'].includes(r.stage)).length / rows.length) * 100) : 0,
      conversionToWon: denominator(rows.length) ? round2((won.length / rows.length) * 100) : 0,
    },
    byStage,
    stageDurations,
    byComplexity: ['STANDARD', 'MODIFIED', 'CUSTOM', 'NEEDS_CLASSIFICATION'].map((complexity) => ({
      complexity,
      count: active.filter((r) => r.complexity === complexity).length,
    })),
    lossReasons: [...lossReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    openQuotes: await openQuoteTotals(base),
  };
}

function denominator(n: number): boolean {
  return n > 0;
}

function safeJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Сумма открытых КП считается по одной выбранной актуальной версии (QUOTE-08). */
async function openQuoteTotals(where: ReturnType<typeof applyScope>) {
  const quotes = await prisma.crmQuote.findMany({
    where: { application: where, status: { in: ['DRAFT', 'READY', 'SENT'] } },
    select: { amount: true, currency: true, applicationId: true },
  });
  const byApplication = new Map<string, { amount: number | null; currency: string | null; versionNo: number }>();
  const rows = await prisma.crmQuote.findMany({
    where: { applicationId: { in: [...new Set(quotes.map((q) => q.applicationId))] }, status: { in: ['DRAFT', 'READY', 'SENT'] } },
    select: { applicationId: true, versionNo: true, amount: true, currency: true },
    orderBy: { versionNo: 'desc' },
  });
  for (const r of rows) {
    if (byApplication.has(r.applicationId)) continue;
    byApplication.set(r.applicationId, { amount: r.amount, currency: r.currency, versionNo: r.versionNo });
  }
  return sumByCurrency([...byApplication.values()]);
}

export interface Dashboard {
  role: string;
  period: { from: Date; to: Date };
  counters: Record<string, number>;
  amountsByCurrency: Record<string, number>;
  tasks: { today: number; overdue: number };
  quotes: { pendingApproval: number; sentAwaitingDecision: number; acceptedAmountByCurrency: Record<string, number> };
  payments: { expected: { number: string; amount: number; currency: string; dueAt: Date }[]; outstandingByCurrency: Record<string, number> };
  shipments: { openLines: number; remainingByLine: { lineId: string; name: string; remaining: number; unit: string; applicationNumber: string }[] };
  unassigned?: number;
  approvalOverdue?: number;
  stale?: { applications: number; tasks: number };
  accountingDataAgeMinutes: number | null;
}

export async function getDashboard(query: Record<string, unknown>, p: Principal): Promise<Dashboard> {
  assertPermission(p.role as never, P.ANALYTICS_READ);
  const { from, to } = period(query);
  const scopeWhere = applyScope({ NOT: { stage: { in: ['ARCHIVED'] } } }, p);
  const staleDays = numParam(query, 'staleDays') ?? 7;
  const staleBefore = new Date(Date.now() - staleDays * 86400_000);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date(todayStart.getTime() + 86400_000);

  const [
    activeApplications,
    unassigned,
    todayTasks,
    overdueTasks,
    pendingApprovals,
    pendingApprovalOld,
    sentQuotes,
    acceptedQuotes,
    myTasksScope,
    staleApps,
    shipments,
    lastAccounting,
  ] = await Promise.all([
    prisma.application.findMany({
      where: scopeWhere,
      select: {
        id: true,
        number: true,
        stage: true,
        amount: true,
        currency: true,
        nextActivityAt: true,
        lastCustomerContactAt: true,
        isClosed: true,
        owner: { select: { id: true, fullName: true } },
      },
    }),
    prisma.application.count({ where: { ownerId: null, stage: { in: ['NEW', 'SALES_REVIEW'] }, isClosed: false } }),
    prisma.crmTask.count({ where: { assigneeId: p.id, status: 'OPEN', dueAt: { gte: todayStart, lt: tomorrow } } }),
    prisma.crmTask.count({ where: { assigneeId: p.id, status: 'OPEN', dueAt: { lt: todayStart } } }),
    prisma.crmQuote.count({ where: { approvalStatus: 'PENDING', application: scopeWhere } }),
    prisma.crmQuote.count({
      where: {
        approvalStatus: 'PENDING',
        application: scopeWhere,
        approvals: { some: { decision: null, requestedAt: { lt: new Date(Date.now() - 24 * 3600_000) } } },
      },
    }),
    prisma.crmQuote.count({ where: { status: 'SENT', application: scopeWhere } }),
    prisma.crmQuote.findMany({
      where: { status: 'ACCEPTED', isActiveBasis: true, application: scopeWhere },
      select: { amount: true, currency: true },
    }),
    p.role === 'SALES'
      ? prisma.crmTask.count({ where: { assigneeId: p.id, status: 'OPEN' } })
      : prisma.crmTask.count({ where: { status: 'OPEN', application: scopeWhere } }),
    prisma.application.count({
      where: { ...scopeWhere, isClosed: false, OR: [{ lastCustomerContactAt: null }, { lastCustomerContactAt: { lt: staleBefore } }] },
    }),
    prisma.shipment.findMany({
      where: { application: scopeWhere, isPosted: true, isCancelled: false, status: { not: 'CANCELLED' } },
      select: { applicationId: true, lines: { select: { lineId: true, quantity: true } }, application: { select: { number: true } } },
    }),
    prisma.shipment.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
  ]);

  const lines = await prisma.applicationLine.findMany({
    where: { applicationId: { in: activeApplications.map((a) => a.id) } },
    select: { lineId: true, name: true, unit: true, orderQty: true, shippedQty: true, application: { select: { number: true } } },
  });
  const shipped = new Map<string, number>();
  for (const s of shipments) {
    for (const l of s.lines) shipped.set(l.lineId, (shipped.get(l.lineId) ?? 0) + l.quantity);
  }
  const remainingByLine = lines
    .map((l) => ({ lineId: l.lineId, name: l.name, unit: l.unit, remaining: round2(l.orderQty - (shipped.get(l.lineId) ?? 0)), applicationNumber: l.application.number }))
    .filter((l) => l.remaining > 1e-6)
    .sort((a, b) => b.remaining - a.remaining)
    .slice(0, 50);

  const openInvoices = await prisma.invoice.findMany({
    where: { status: { in: ['NEW', 'PARTIAL'] }, commercial: { application: scopeWhere } },
    select: {
      id: true,
      number: true,
      amount: true,
      currency: true,
      docDate: true,
      commercial: { select: { application: { select: { number: true, expectedDecisionDate: true } } } },
    },
    orderBy: { docDate: 'asc' },
    take: 50,
  });
  const allocations = await prisma.paymentAllocation.findMany({
    where: { applicationId: { in: activeApplications.map((a) => a.id) }, isCancelled: false },
    select: { invoiceId: true, amount: true },
  });
  const allocatedByInvoice = new Map<string, number>();
  for (const a of allocations) {
    if (a.invoiceId) allocatedByInvoice.set(a.invoiceId, (allocatedByInvoice.get(a.invoiceId) ?? 0) + a.amount);
  }
  const outstandingByCurrency: Record<string, number> = {};
  for (const inv of openInvoices) {
    const rest = round2(inv.amount - (allocatedByInvoice.get(inv.id) ?? 0));
    outstandingByCurrency[inv.currency] = round2((outstandingByCurrency[inv.currency] ?? 0) + rest);
  }

  const byStage: Record<string, number> = {};
  for (const a of activeApplications) byStage[a.stage] = (byStage[a.stage] ?? 0) + 1;

  const isManager = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);

  return {
    role: p.role,
    period: { from, to },
    counters: {
      activeApplications: activeApplications.filter((a) => !a.isClosed).length,
      ...Object.fromEntries(Object.entries(byStage).map(([k, v]) => [`stage_${k}`, v])),
      myOpenTasks: myTasksScope,
      staleApplications: staleApps,
    },
    amountsByCurrency: sumByCurrency(activeApplications.filter((a) => !a.isClosed)),
    tasks: { today: todayTasks, overdue: overdueTasks },
    quotes: {
      pendingApproval: pendingApprovals,
      sentAwaitingDecision: sentQuotes,
      acceptedAmountByCurrency: sumByCurrency(acceptedQuotes),
    },
    payments: {
      expected: openInvoices.map((i) => ({
        number: i.number,
        amount: round2(i.amount - (allocatedByInvoice.get(i.id) ?? 0)),
        currency: i.currency,
        dueAt: i.docDate ?? i.commercial.application.expectedDecisionDate ?? new Date(),
      })),
      outstandingByCurrency,
    },
    shipments: {
      openLines: remainingByLine.length,
      remainingByLine,
    },
    ...(isManager
      ? {
          unassigned,
          approvalOverdue: pendingApprovalOld,
        }
      : {}),
    stale: { applications: staleApps, tasks: overdueTasks },
    accountingDataAgeMinutes: lastAccounting
      ? Math.round((Date.now() - lastAccounting.updatedAt.getTime()) / 60000)
      : null,
  };
}

/** План/факт по исполнению: отгрузки и оплаты (§10.3). */
export async function getPlanFact(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.FULFILLMENT_READ);
  const scopeWhere = applyScope({ NOT: { stage: 'ARCHIVED' } }, p);

  const lines = await prisma.applicationLine.findMany({
    where: { application: scopeWhere },
    select: {
      lineId: true,
      name: true,
      unit: true,
      orderQty: true,
      shippedQty: true,
      application: { select: { number: true, stage: true } },
    },
  });
  const totalOrdered = round2(lines.reduce((s, l) => s + l.orderQty, 0));
  const totalShipped = round2(lines.reduce((s, l) => s + l.shippedQty, 0));

  const invoices = await prisma.invoice.findMany({
    where: { commercial: { application: scopeWhere } },
    select: { amount: true, currency: true, status: true },
  });
  // Валюта берётся из связанного платежа: смешивать рубли и валюту в одной
  // сумме запрещено (MONEY-01), поэтому оплаты группируются по валютам.
  // Возврат (kind = RETURN) уменьшает фактически поступившее.
  const allocations = await prisma.paymentAllocation.findMany({
    where: { application: scopeWhere, isCancelled: false, payment: { isCancelled: false } },
    select: { amount: true, payment: { select: { currency: true, kind: true } } },
  });
  const invoicedByCurrency = sumByCurrency(invoices.filter((i) => i.status !== 'CANCELLED'));

  const paidByCurrency: Record<string, number> = {};
  let paidTotal = 0;
  for (const a of allocations) {
    const currency = a.payment.currency || 'RUB';
    const sign = a.payment.kind === 'RETURN' ? -1 : 1;
    paidByCurrency[currency] = round2((paidByCurrency[currency] ?? 0) + sign * a.amount);
    paidTotal = round2(paidTotal + sign * a.amount);
  }

  const byApplication: Record<string, { ordered: number; shipped: number; amount: number; currency: string | null }> = {};
  for (const l of lines) {
    const key = l.application.number;
    byApplication[key] ??= { ordered: 0, shipped: 0, amount: 0, currency: null };
    byApplication[key].ordered = round2(byApplication[key].ordered + l.orderQty);
    byApplication[key].shipped = round2(byApplication[key].shipped + l.shippedQty);
  }
  for (const a of await activeApplicationsForAmounts(scopeWhere)) {
    const entry = byApplication[a.number];
    if (!entry) continue;
    entry.amount = a.amount ?? 0;
    entry.currency = a.currency;
  }

  return {
    fulfilment: {
      totalOrdered,
      totalShipped,
      totalRemaining: round2(totalOrdered - totalShipped),
      completionPct: totalOrdered ? round2((totalShipped / totalOrdered) * 100) : 0,
    },
    finance: {
      invoicedByCurrency,
      paidByCurrency,
      /** Сумма по всем валютам — только для справки, не для сверки (MONEY-01). */
      paidTotal,
    },
    byApplication: Object.entries(byApplication)
      .map(([number, v]) => ({ number, ...v }))
      .sort((a, b) => b.ordered - a.ordered)
      .slice(0, 200),
  };
}

async function activeApplicationsForAmounts(scopeWhere: ReturnType<typeof applyScope>) {
  return prisma.application.findMany({
    where: scopeWhere,
    select: { number: true, amount: true, currency: true },
  });
}

/** A39: экспорт применяет ту же политику доступа, что и список (API-01). */
export async function exportApplications(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.ANALYTICS_EXPORT);
  const { from, to } = period(query);
  const rows = await prisma.application.findMany({
    where: applyScope({ createdAt: { gte: from, lte: to } }, p),
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: 20000,
    select: {
      number: true,
      stage: true,
      complexity: true,
      priority: true,
      amount: true,
      currency: true,
      isClosed: true,
      lossReason: true,
      createdAt: true,
      updatedAt: true,
      organization: { select: { name: true, inn: true } },
      owner: { select: { fullName: true } },
    },
  });
  return { period: { from, to }, count: rows.length, rows };
}
