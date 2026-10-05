import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { AppError, ErrorCode, badRequest, notFound, type Tx } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { notify } from '../lib/notifications.js';
import { registerInbound, SYSTEM, type InboundResult } from '../lib/integration.js';
import { recomputeLineFulfilment, reopenClosedApplication } from './fulfillment.js';

/**
 * Приём учётных данных из 1С (§9.1, §12, SYNC-01..06).
 *
 * Правила приёма:
 *  - идемпотентность по messageKey, старая версия не перезаписывает новую;
 *  - фактическая оплата фиксируется только здесь — ручное разрешение выпуска
 *    не создаёт фиктивную оплату (GATE-02);
 *  - отмена оплаты или отгрузки после закрытия возвращает заявку в исполнение
 *    с аудитом и уведомлением ответственного (A24);
 *  - каждая операция попадает в аудит от имени служебной учётной записи.
 */

export interface SyncInvoiceInput {
  extId: string;
  number: string;
  docDate?: string | null;
  amount: number;
  currency: string;
  status?: string;
  versionNo?: number;
}

export interface SyncPaymentSplit {
  /** Номер заявки, на которую зачисляется доля платежа. */
  applicationNumber: string;
  /** Сумма доли в валюте платежа. */
  amount: number;
}

export interface SyncPaymentInput {
  extId: string;
  docDate?: string | null;
  amount: number;
  currency: string;
  kind?: 'IN' | 'RETURN';
  isCancelled?: boolean;
  versionNo?: number;
  /**
   * A29: распределение одного платежа между несколькими заказами. Сумма долей не
   * должна превышать сумму платежа; нераспределённый остаток возвращается для
   * ручного зачёта. Если поле не задано, платёж зачитывается целиком в заявку
   * из заголовка запроса по счетам в порядке FIFO.
   */
  allocations?: SyncPaymentSplit[];
}

export interface SyncShipmentInput {
  extId: string;
  number: string;
  docDate?: string | null;
  status?: string;
  carrier?: string | null;
  waybill?: string | null;
  isCancelled?: boolean;
  versionNo?: number;
  lines?: { lineId: string; quantity: number; unit?: string; actualDate?: string | null }[];
}

export interface CommercialSyncInput {
  applicationNumber: string;
  invoices?: SyncInvoiceInput[];
  payments?: SyncPaymentInput[];
  shipments?: SyncShipmentInput[];
  correlationId: string;
}

export interface CommercialSyncResult {
  applicationNumber: string;
  invoices: { extId: string; created: boolean; status: string }[];
  payments: {
    extId: string;
    /**
     * Идентификатор платежа в CRM. Нужен для ручного зачёта
     * (`POST /api/v1/applications/:number/payments/allocate`): без него в ответе
     * этот маршрут был недостижим из API.
     */
    paymentId?: string;
    created: boolean;
    allocated: number;
    /**
     * A29: остаток платежа, который не удалось зачесть ни в один заказ
     * (например, у заявки в распределении ещё нет счетов). Раньше эти деньги
     * исчезали молча, и вызывающая сторона видела успешный ответ.
     */
    unallocated?: number;
    cancelled: boolean;
    /** A29: доля платежа по каждому заказу-получателю. */
    shares?: { applicationNumber: string; amount: number }[];
  }[];
  shipments: { extId: string; number: string; created: boolean; discrepancies: { lineId: string; message: string }[] }[];
  totals: { invoiced: number; allocated: number; outstanding: number };
  reopened: boolean;
  messages: InboundResult[];
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function money(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, `Поле ${field} должно быть числом`, {
      fields: [{ field, message: 'Ожидается число' }],
    });
  }
  return round2(n);
}

function currencyOf(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim().toUpperCase();
  return s || fallback;
}

/**
 * Распределение платежа по счетам заявки (FIFO по дате счёта). Распределённая
 * сумма — единственное основание для проверки предоплаты; нераспределённый
 * остаток возвращается для ручного зачёта.
 *
 * A29: `limit` ограничивает долю, которая может быть зачтена в конкретный заказ.
 * Так один платёж распределяется между несколькими заказами, и итог каждого
 * заказа учитывает только назначенную ему долю.
 */
async function allocatePayment(
  tx: Tx,
  applicationId: string,
  commercialId: string,
  payment: { id: string; amount: number; kind: string; isCancelled: boolean },
  currency: string,
  correlationId: string,
  limit?: number,
): Promise<number> {
  if (payment.kind === 'RETURN' || payment.isCancelled) {
    const released = await tx.paymentAllocation.updateMany({
      where: { paymentId: payment.id, isCancelled: false },
      data: { isCancelled: true },
    });
    if (released.count) {
      await audit(tx, {
        serviceAccount: SYSTEM,
        actionCode: AuditAction.PAYMENT_ALLOCATE,
        entityType: 'Payment',
        entityId: payment.id,
        applicationId,
        payload: { releasedAllocations: released.count, reason: 'payment cancelled' },
        correlationId,
      });
    }
    return 0;
  }

  const invoices = await tx.invoice.findMany({
    where: { commercialId, currency, status: { not: 'CANCELLED' } },
    orderBy: [{ docDate: 'asc' }, { number: 'asc' }],
  });

  let left = limit === undefined ? payment.amount : round2(limit);
  const created: { invoiceId: string; amount: number }[] = [];
  for (const inv of invoices) {
    if (left <= 1e-6) break;
    const alloc = await tx.paymentAllocation.aggregate({
      where: { invoiceId: inv.id, isCancelled: false },
      _sum: { amount: true },
    });
    const open = round2(inv.amount - (alloc._sum.amount ?? 0));
    if (open <= 1e-6) continue;
    const take = round2(Math.min(left, open));
    if (take <= 0) continue;
    created.push({ invoiceId: inv.id, amount: take });
    left = round2(left - take);
  }

  for (const c of created) {
    await tx.paymentAllocation.create({
      data: {
        paymentId: payment.id,
        invoiceId: c.invoiceId,
        applicationId,
        amount: c.amount,
        comment: 'Автоматический зачёт платежа 1С по счетам заявки',
      },
    });
  }

  const budget = limit === undefined ? payment.amount : round2(limit);
  const allocatedTotal = round2(budget - left);
  await audit(tx, {
    serviceAccount: SYSTEM,
    actionCode: AuditAction.PAYMENT_ALLOCATE,
    entityType: 'Payment',
    entityId: payment.id,
    applicationId,
    payload: {
      allocated: allocatedTotal,
      // Остаток считается от суммы всего платежа: при распределении (A29)
      // зачёт идёт долями, поэтому «бюджет» не равен сумме платежа.
      unallocated: round2(payment.amount - allocatedTotal),
      invoices: created.length,
      currency,
    },
    correlationId,
  });

  return round2((limit === undefined ? payment.amount : limit) - left);
}

/**
 * A29: распределение одного платежа между несколькими заказами.
 *
 * Контролируется, что сумма долей не превышает сумму платежа и что валюта доли
 * совпадает с валютой заказа-получателя. Каждая доля зачитывается по счетам
 * своего заказа по FIFO, поэтому итог заказа учитывает только назначенную ему
 * сумму, а не весь платёж.
 */
async function applyPaymentAllocations(
  tx: Tx,
  args: {
    payment: { id: string; extId: string; amount: number; kind: string; isCancelled: boolean };
    currency: string;
    defaultApplication: { id: string; number: string; commercialId: string };
    splits?: SyncPaymentSplit[];
    correlationId: string;
  },
): Promise<{ total: number; shares: { applicationNumber: string; amount: number }[] }> {
  const { payment, currency, defaultApplication, splits, correlationId } = args;

  if (!splits || splits.length === 0) {
    const total = await allocatePayment(tx, defaultApplication.id, defaultApplication.commercialId, payment, currency, correlationId);
    return { total, shares: [{ applicationNumber: defaultApplication.number, amount: total }] };
  }

  const seen = new Set<string>();
  const parsed: { applicationNumber: string; amount: number }[] = [];
  let planned = 0;
  for (const split of splits) {
    const number = String(split.applicationNumber ?? '').trim();
    if (!number) throw badRequest(ErrorCode.VALIDATION_ERROR, 'В распределении платежа указан заказ без номера');
    if (seen.has(number)) {
      throw badRequest(ErrorCode.VALIDATION_ERROR, `Заказ ${number} указан в распределении платежа дважды`, {
        details: { applicationNumber: number },
      });
    }
    seen.add(number);
    const amount = money(split.amount, `payments.${payment.extId}.allocations.${number}`);
    if (amount <= 0) {
      throw badRequest(ErrorCode.VALIDATION_ERROR, `Доля платежа для заказа ${number} должна быть положительной`, {
        details: { applicationNumber: number, amount },
      });
    }
    planned = round2(planned + amount);
    parsed.push({ applicationNumber: number, amount });
  }

  if (planned - payment.amount > 1e-6) {
    throw badRequest(
      ErrorCode.VALIDATION_ERROR,
      `Сумма долей платежа ${planned} ${currency} превышает сумму платежа ${payment.amount} ${currency}`,
      { details: { planned, paymentAmount: payment.amount, currency } },
    );
  }

  let total = 0;
  const shares: { applicationNumber: string; amount: number }[] = [];
  for (const split of parsed) {
    // Заявка читается через tx: обращение к глобальному prisma внутри
    // транзакции закрывает единственное соединение SQLite (тот же дефект,
    // что был исправлен в commercial.ts) и приводит к таймауту
    const target = await tx.application.findUnique({
      where: { number: split.applicationNumber },
      include: { commercial: true },
    });
    if (!target) throw notFound(`Заявка ${split.applicationNumber}`);
    if (!target.commercial) {
      throw badRequest(
        ErrorCode.VALIDATION_ERROR,
        `У заявки ${split.applicationNumber} не сформированы коммерческие условия — платёж распределить некуда`,
      );
    }
    const targetCurrency = currencyOf(target.commercial.basisCurrency ?? target.currency, 'RUB');
    if (targetCurrency !== currency) {
      throw badRequest(
        ErrorCode.VALIDATION_ERROR,
        `Валюта заказа ${split.applicationNumber} (${targetCurrency}) не совпадает с валютой платежа ${currency}`,
        { details: { applicationNumber: split.applicationNumber, orderCurrency: targetCurrency, paymentCurrency: currency } },
      );
    }
    const applied = await allocatePayment(
      tx,
      target.id,
      target.commercial.id,
      payment,
      currency,
      correlationId,
      split.amount,
    );
    total = round2(total + applied);
    shares.push({ applicationNumber: split.applicationNumber, amount: applied });
    await recomputeInvoiceStatuses(tx, target.commercial.id);
  }

  await audit(tx, {
    serviceAccount: SYSTEM,
    actionCode: AuditAction.PAYMENT_ALLOCATE,
    entityType: 'Payment',
    entityId: payment.id,
    applicationId: defaultApplication.id,
    payload: { shared: true, paymentAmount: payment.amount, allocated: total, unallocated: round2(payment.amount - total), shares },
    correlationId,
  });

  return { total, shares };
}

async function recomputeInvoiceStatuses(tx: Tx, commercialId: string): Promise<void> {
  const invoices = await tx.invoice.findMany({ where: { commercialId } });
  for (const inv of invoices) {
    if (inv.status === 'CANCELLED') continue;
    const alloc = await tx.paymentAllocation.aggregate({
      where: { invoiceId: inv.id, isCancelled: false },
      _sum: { amount: true },
    });
    const paid = round2(alloc._sum.amount ?? 0);
    const status = paid + 1e-6 >= inv.amount ? 'PAID' : paid > 0 ? 'PARTIAL' : 'NEW';
    if (status !== inv.status) {
      await tx.invoice.update({ where: { id: inv.id }, data: { status } });
    }
  }
}

export async function syncCommercial(input: CommercialSyncInput): Promise<CommercialSyncResult> {
  const invoicesIn = input.invoices ?? [];
  const paymentsIn = input.payments ?? [];
  const shipmentsIn = input.shipments ?? [];
  if (!invoicesIn.length && !paymentsIn.length && !shipmentsIn.length) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Пустой пакет синхронизации: передайте счета, платежи или отгрузки');
  }

  const app = await prisma.application.findUnique({
    where: { number: input.applicationNumber },
    include: { commercial: true },
  });
  if (!app) throw notFound('Заявка');
  if (!app.commercial) {
    throw badRequest(
      ErrorCode.VALIDATION_ERROR,
      'Коммерческие условия не сформированы: счёт или платёж 1С нельзя привязать к заявке без них',
    );
  }
  const commercial = app.commercial;
  const currency = currencyOf(commercial.basisCurrency ?? app.currency, 'RUB');

  const messages: InboundResult[] = [];
  const invoiceResult: CommercialSyncResult['invoices'] = [];
  const paymentResult: CommercialSyncResult['payments'] = [];
  const shipmentResult: CommercialSyncResult['shipments'] = [];
  /** Причины для возврата закрытой заявки в исполнение (A24). */
  const reopenReasons = new Set<string>();

  await prisma.$transaction(async (tx) => {
    for (const inv of invoicesIn) {
      const extId = String(inv.extId ?? '').trim();
      if (!extId) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Счёт 1С передан без extId');
      const message = await registerInbound(tx, {
        objectType: 'INVOICE',
        extId,
        versionNo: inv.versionNo ?? 1,
        eventType: inv.status === 'CANCELLED' ? 'INVOICE_CANCELLED' : 'INVOICE_UPSERT',
        payload: { applicationId: app.id, ...inv },
        correlationId: input.correlationId,
      });
      messages.push(message);
      if (message.state === 'SKIPPED_STALE') {
        invoiceResult.push({ extId, created: false, status: 'SKIPPED_STALE' });
        continue;
      }
      const amount = money(inv.amount, `invoices.${extId}.amount`);
      const invCurrency = currencyOf(inv.currency, currency);
      const existing = await tx.invoice.findUnique({ where: { extSystem_extId: { extSystem: SYSTEM, extId } } });
      if (existing && existing.commercialId !== commercial.id) {
        throw badRequest(ErrorCode.VALIDATION_ERROR, `Счёт ${extId} уже привязан к другой заявке`, {
          details: { extId },
        });
      }
      const saved = await tx.invoice.upsert({
        where: { extSystem_extId: { extSystem: SYSTEM, extId } },
        create: {
          commercialId: commercial.id,
          extSystem: SYSTEM,
          extId,
          number: String(inv.number ?? extId),
          docDate: inv.docDate ? new Date(inv.docDate) : null,
          amount,
          currency: invCurrency,
          status: inv.status ?? 'NEW',
          versionNo: inv.versionNo ?? 1,
        },
        update: {
          number: String(inv.number ?? extId),
          ...(inv.docDate ? { docDate: new Date(inv.docDate) } : {}),
          amount,
          currency: invCurrency,
          ...(inv.status ? { status: inv.status } : {}),
          ...(inv.versionNo ? { versionNo: inv.versionNo } : {}),
        },
      });
      await audit(tx, {
        serviceAccount: SYSTEM,
        actionCode: AuditAction.INVOICE_IMPORT,
        entityType: 'Invoice',
        entityId: saved.id,
        applicationId: app.id,
        after: { extId, number: saved.number, amount, currency: invCurrency, status: saved.status },
        correlationId: input.correlationId,
      });
      invoiceResult.push({ extId, created: !existing, status: saved.status });
    }

    for (const pay of paymentsIn) {
      const extId = String(pay.extId ?? '').trim();
      if (!extId) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Платёж 1С передан без extId');
      const cancelled = pay.isCancelled === true || pay.kind === 'RETURN';
      const message = await registerInbound(tx, {
        objectType: 'PAYMENT',
        extId,
        versionNo: pay.versionNo ?? 1,
        eventType: cancelled ? 'PAYMENT_CANCELLED' : 'PAYMENT_UPSERT',
        payload: { applicationId: app.id, ...pay },
        correlationId: input.correlationId,
      });
      messages.push(message);
      if (message.state === 'SKIPPED_STALE') {
        paymentResult.push({ extId, created: false, allocated: 0, cancelled: false });
        continue;
      }
      const amount = money(pay.amount, `payments.${extId}.amount`);
      const payCurrency = currencyOf(pay.currency, currency);
      if (payCurrency !== currency) {
        throw badRequest(
          ErrorCode.VALIDATION_ERROR,
          `Валюта платежа ${payCurrency} не совпадает с валютой заказа ${currency}`,
          { details: { extId, paymentCurrency: payCurrency, orderCurrency: currency } },
        );
      }
      const existing = await tx.payment.findUnique({ where: { extSystem_extId: { extSystem: SYSTEM, extId } } });
      const saved = await tx.payment.upsert({
        where: { extSystem_extId: { extSystem: SYSTEM, extId } },
        create: {
          extSystem: SYSTEM,
          extId,
          docDate: pay.docDate ? new Date(pay.docDate) : null,
          amount,
          currency: payCurrency,
          kind: pay.kind ?? 'IN',
          isCancelled: pay.isCancelled ?? false,
          versionNo: pay.versionNo ?? 1,
        },
        update: {
          ...(pay.docDate ? { docDate: new Date(pay.docDate) } : {}),
          amount,
          ...(pay.kind ? { kind: pay.kind } : {}),
          ...(pay.isCancelled === undefined ? {} : { isCancelled: pay.isCancelled }),
          ...(pay.versionNo ? { versionNo: pay.versionNo } : {}),
        },
      });
      const allocated = await applyPaymentAllocations(tx, {
        payment: saved,
        currency: payCurrency,
        defaultApplication: { id: app.id, number: app.number, commercialId: commercial.id },
        splits: pay.allocations,
        correlationId: input.correlationId,
      });
      if (cancelled) {
        reopenReasons.add(
          `отмена или возврат платежа ${extId} на ${amount} ${payCurrency}`,
        );
      }
      paymentResult.push({
        extId,
        paymentId: saved.id,
        created: !existing,
        allocated: allocated.total,
        unallocated: round2(amount - allocated.total),
        cancelled: saved.isCancelled,
        shares: allocated.shares,
      });
    }

    for (const sh of shipmentsIn) {
      const extId = String(sh.extId ?? '').trim();
      if (!extId) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Отгрузка 1С передана без extId');
      const message = await registerInbound(tx, {
        objectType: 'SHIPMENT',
        extId,
        versionNo: sh.versionNo ?? 1,
        eventType: sh.isCancelled ? 'SHIPMENT_CANCELLED' : 'SHIPMENT_UPSERT',
        payload: { applicationId: app.id, ...sh },
        correlationId: input.correlationId,
      });
      messages.push(message);
      if (message.state === 'SKIPPED_STALE') {
        shipmentResult.push({ extId, number: String(sh.number ?? extId), created: false, discrepancies: [] });
        continue;
      }
      const existing = await tx.shipment.findUnique({
        where: { extSystem_extId: { extSystem: SYSTEM, extId } },
        select: { id: true, applicationId: true },
      });
      if (existing && existing.applicationId !== app.id) {
        throw badRequest(ErrorCode.VALIDATION_ERROR, `Отгрузка ${extId} уже привязана к другой заявке`, {
          details: { extId },
        });
      }
      const saved = await tx.shipment.upsert({
        where: { extSystem_extId: { extSystem: SYSTEM, extId } },
        create: {
          applicationId: app.id,
          extSystem: SYSTEM,
          extId,
          number: String(sh.number ?? extId),
          docDate: sh.docDate ? new Date(sh.docDate) : null,
          status: sh.status ?? 'NEW',
          carrier: sh.carrier ?? null,
          waybill: sh.waybill ?? null,
          isCancelled: sh.isCancelled ?? false,
          versionNo: sh.versionNo ?? 1,
        },
        update: {
          number: String(sh.number ?? extId),
          ...(sh.docDate ? { docDate: new Date(sh.docDate) } : {}),
          ...(sh.status ? { status: sh.status } : {}),
          ...(sh.carrier === undefined ? {} : { carrier: sh.carrier }),
          ...(sh.waybill === undefined ? {} : { waybill: sh.waybill }),
          ...(sh.isCancelled === undefined ? {} : { isCancelled: sh.isCancelled }),
          ...(sh.versionNo ? { versionNo: sh.versionNo } : {}),
        },
      });
      // Позиции отгрузки заменяются целиком: 1С присылает полный состав документа.
      await tx.shipmentLine.deleteMany({ where: { shipmentId: saved.id } });
      for (const l of sh.lines ?? []) {
        await tx.shipmentLine.create({
          data: {
            shipmentId: saved.id,
            lineId: String(l.lineId),
            quantity: money(l.quantity, `shipments.${extId}.lines.${l.lineId}.quantity`),
            unit: l.unit ?? 'шт',
            actualDate: l.actualDate ? new Date(l.actualDate) : null,
          },
        });
      }
      await audit(tx, {
        serviceAccount: SYSTEM,
        actionCode: AuditAction.SHIPMENT_IMPORT,
        entityType: 'Shipment',
        entityId: saved.id,
        applicationId: app.id,
        after: {
          extId,
          number: saved.number,
          status: saved.status,
          isCancelled: saved.isCancelled,
          lines: (sh.lines ?? []).length,
        },
        correlationId: input.correlationId,
      });
      if (saved.isCancelled) {
        reopenReasons.add(`отмена отгрузки ${saved.number} после закрытия заявки`);
      }
      shipmentResult.push({
        extId,
        number: saved.number,
        created: !existing,
        discrepancies: [],
      });
    }

    await recomputeInvoiceStatuses(tx, commercial.id);
    await tx.applicationCommercial.update({
      where: { id: commercial.id },
      data: { syncedTo1C: true },
    });
  });

  // SHIP-02: позиции отгрузки, не сопоставленные с заявкой, возвращаются как
  // расхождения для разбора, а не отбрасываются.
  const fulfilment = shipmentsIn.length ? await recomputeLineFulfilment(app.id) : null;
  for (const s of shipmentResult) {
    s.discrepancies = (fulfilment?.discrepancies ?? []).map((d) => ({ lineId: d.lineId, message: d.message }));
  }

  // A24: отмена учётных данных после закрытия возвращает заявку в исполнение.
  let reopened = false;
  if (reopenReasons.size) {
    const reason = `Корректировка учётных данных 1С: ${[...reopenReasons].join('; ')}`;
    const result = await reopenClosedApplication({ applicationId: app.id, reason, correlationId: input.correlationId });
    reopened = result.reopened;
    if (reopened && app.ownerId) {
      await notify(prisma, {
        userId: app.ownerId,
        code: 'APPLICATION_CLOSE_REOPENED',
        title: 'Заявка возвращена в исполнение',
        body: reason,
        entityType: 'Application',
        entityId: app.id,
        dedupKey: `CLOSE_REOPENED:${app.id}:${Date.now()}`,
      });
    }
  }

  const [invoiced, allocated, cancelledAllocs] = await Promise.all([
    prisma.invoice.aggregate({ where: { commercialId: commercial.id, status: { not: 'CANCELLED' } }, _sum: { amount: true } }),
    prisma.paymentAllocation.aggregate({ where: { applicationId: app.id, isCancelled: false }, _sum: { amount: true } }),
    prisma.paymentAllocation.aggregate({ where: { applicationId: app.id, isCancelled: true }, _sum: { amount: true } }),
  ]);
  const allocatedTotal = round2((allocated._sum.amount ?? 0) - (cancelledAllocs._sum.amount ?? 0));

  return {
    applicationNumber: app.number,
    invoices: invoiceResult,
    payments: paymentResult,
    shipments: shipmentResult,
    totals: {
      invoiced: round2(invoiced._sum.amount ?? 0),
      allocated: allocatedTotal,
      outstanding: round2(Math.max(0, (invoiced._sum.amount ?? 0) - allocatedTotal)),
    },
    reopened,
    messages,
  };
}

/**
 * Ручной зачёт платежа сотрудником продаж: применяется, когда поступивший
 * платёж не удалось распределить автоматически. Ошибка ручного зачёта не
 * создаёт оплату — она лишь связывает уже зафиксированный платёж 1С со счётом
 * заявки, названной в URL. Счёт обязателен и проверяется на принадлежность этой
 * заявке, а валюта платежа — на совпадение с валютой заказа, как в автопути.
 */
export async function allocatePaymentManually(input: {
  applicationNumber: string;
  paymentId: string;
  invoiceId: string;
  amount: number;
  comment?: string;
  correlationId: string;
  actor: { id: string; login: string; fullName: string; role: string; scope: string };
}): Promise<{ allocated: number }> {
  const app = await prisma.application.findUnique({
    where: { number: input.applicationNumber },
    include: { commercial: true },
  });
  if (!app) throw notFound('Заявка');
  if (!app.commercial) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Коммерческие условия не сформированы');
  const amount = money(input.amount, 'amount');
  if (amount <= 0) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Сумма распределения должна быть больше нуля');
  // Валюта заявки считается так же, как в автопути (A29), иначе ручной зачёт
  // обошёл бы проверку «валюта доли сверяется с валютой заказа».
  const orderCurrency = currencyOf(app.commercial.basisCurrency ?? app.currency, 'RUB');

  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
    if (!payment) throw notFound('Платёж');
    if (payment.isCancelled) {
      throw badRequest(ErrorCode.RESOURCE_LOCKED, 'Платёж отменён в учётной системе и не может быть распределён');
    }
    const paymentCurrency = currencyOf(payment.currency, orderCurrency);
    if (paymentCurrency !== orderCurrency) {
      throw badRequest(
        ErrorCode.VALIDATION_ERROR,
        `Валюта платежа ${paymentCurrency} не совпадает с валютой заказа ${input.applicationNumber} (${orderCurrency})`,
        { details: { applicationNumber: input.applicationNumber, orderCurrency, paymentCurrency } },
      );
    }
    // Счёт обязан принадлежать заявке из URL: иначе платёж одной заявки
    // зачислялся бы на счёт другой (allocation.applicationId и invoiceId
    // хранятся независимо, поэтому проверка обязательна).
    const invoice = await tx.invoice.findUnique({ where: { id: input.invoiceId } });
    if (!invoice || invoice.commercialId !== app.commercial!.id) throw notFound('Счёт заявки');
    if (invoice.status === 'CANCELLED') {
      throw badRequest(ErrorCode.RESOURCE_LOCKED, 'Счёт отменён и не может быть оплачен');
    }
    if (invoice.currency !== payment.currency) {
      throw badRequest(ErrorCode.VALIDATION_ERROR, 'Валюта счёта и платежа не совпадает');
    }
    const existing = await tx.paymentAllocation.findFirst({
      where: { paymentId: payment.id, invoiceId: input.invoiceId, isCancelled: false },
    });
    if (existing) {
      throw badRequest(ErrorCode.RESOURCE_LOCKED, 'Этот платёж уже распределён по данному счёту');
    }
    // Сумма всех распределений платежа не должна превышать сам платёж.
    // Автоматический путь (A29) такую переплату отклоняет, и ручной зачёт
    // не должен обходить эту проверку через другой счёт того же платежа.
    const already = await tx.paymentAllocation.aggregate({
      where: { paymentId: payment.id, isCancelled: false },
      _sum: { amount: true },
    });
    const allocatedBefore = round2(already._sum.amount ?? 0);
    if (allocatedBefore + amount - payment.amount > 1e-6) {
      throw badRequest(
        ErrorCode.VALIDATION_ERROR,
        `Сумма распределений платежа превысит его сумму: уже распределено ${allocatedBefore} ${payment.currency}, добавляется ${amount} при сумме платежа ${payment.amount} ${payment.currency}`,
        { details: { allocatedBefore, amount, paymentAmount: payment.amount, currency: payment.currency } },
      );
    }
    const row = await tx.paymentAllocation.create({
      data: {
        paymentId: payment.id,
        invoiceId: input.invoiceId,
        applicationId: app.id,
        amount,
        comment: input.comment ?? 'Ручной зачёт платежа',
      },
    });
    await audit(tx, {
      actor: input.actor as never,
      actionCode: AuditAction.PAYMENT_ALLOCATE,
      entityType: 'PaymentAllocation',
      entityId: row.id,
      applicationId: app.id,
      after: { paymentId: payment.id, invoiceId: input.invoiceId, amount, comment: row.comment },
      correlationId: input.correlationId,
      userReason: input.comment ?? null,
    });
    await recomputeInvoiceStatuses(tx, app.commercial!.id);
    return { allocated: amount };
  });
}

/** Просмотр очереди исходящих сообщений (SYNC-05). */
export async function listOutbox(query: Record<string, unknown>): Promise<{
  items: {
    id: string;
    eventType: string;
    objectType: string;
    extId: string;
    applicationId: string | null;
    state: string;
    attempts: number;
    createdAt: Date;
    deliveredAt: Date | null;
    lastError: string | null;
  }[];
  total: number;
}> {
  const state = query.state ? String(query.state) : undefined;
  const take = Math.min(Number(query.limit ?? 50) || 50, 200);
  const where = state ? { state } : {};
  const [items, total] = await Promise.all([
    prisma.outboxMessage.findMany({ where, orderBy: { createdAt: 'asc' }, take }),
    prisma.outboxMessage.count({ where }),
  ]);
  return { items, total };
}

export async function markOutboxDelivered(ids: string[], correlationId: string, error?: string): Promise<number> {
  if (!ids.length) return 0;
  const updated = await prisma.outboxMessage.updateMany({
    where: { id: { in: ids }, state: { in: ['PENDING', 'FAILED'] } },
    data: error
      ? { state: 'FAILED', attempts: { increment: 1 }, lastError: error.slice(0, 500) }
      : { state: 'DELIVERED', deliveredAt: new Date(), attempts: { increment: 1 }, lastError: null },
  });
  return updated.count;
}

/**
 * Токен интеграции: отсутствие заголовка не должно раскрывать существование
 * метода, неверное значение возвращается как ошибка авторизации.
 */
export function assertIntegrationToken(token: unknown): string {
  if (typeof token !== 'string' || !token.trim()) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Не найдено');
  }
  if (token !== config.integrationToken) {
    throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Недействительный токен интеграции');
  }
  return token;
}
