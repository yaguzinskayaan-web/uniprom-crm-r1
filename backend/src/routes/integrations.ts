import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { correlationOf, ctx, requireAuth } from './context.js';
import {
  allocatePaymentManually,
  assertIntegrationToken,
  listOutbox,
  markOutboxDelivered,
  syncCommercial,
} from '../services/integrations.js';
import { getIntegrationStatus } from '../services/directory.js';
import { P, assertPermission } from '../domain/rbac.js';

/**
 * Интеграционный контур 1С (§12): приём учётных данных по токену, просмотр
 * очереди исходящих сообщений и ручной зачёт платежа сотрудником продаж.
 */

const invoiceSchema = z.object({
  extId: z.string().min(1),
  number: z.string().min(1),
  docDate: z.string().optional(),
  amount: z.number(),
  currency: z.string().min(3).max(3),
  status: z.string().optional(),
  versionNo: z.number().int().positive().optional(),
});

/**
 * A29: один платёж может быть распределён между несколькими заказами.
 * Доли перечисляются явно, их сумма проверяется на стороне сервиса —
 * без этого поле молча отбрасывалось бы валидатором.
 */
const paymentSplitSchema = z.object({
  applicationNumber: z.string().min(1),
  amount: z.number().positive(),
});

const paymentSchema = z.object({
  extId: z.string().min(1),
  docDate: z.string().optional(),
  amount: z.number(),
  currency: z.string().min(3).max(3),
  kind: z.enum(['IN', 'RETURN']).optional(),
  isCancelled: z.boolean().optional(),
  versionNo: z.number().int().positive().optional(),
  allocations: z.array(paymentSplitSchema).min(1).optional(),
});

const shipmentSchema = z.object({
  extId: z.string().min(1),
  number: z.string().min(1),
  docDate: z.string().optional(),
  status: z.string().optional(),
  carrier: z.string().nullish(),
  waybill: z.string().nullish(),
  isCancelled: z.boolean().optional(),
  versionNo: z.number().int().positive().optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1),
        quantity: z.number(),
        unit: z.string().optional(),
        actualDate: z.string().optional(),
      }),
    )
    .optional(),
});

const syncBody = z.object({
  applicationNumber: z.string().min(1),
  invoices: z.array(invoiceSchema).optional(),
  payments: z.array(paymentSchema).optional(),
  shipments: z.array(shipmentSchema).optional(),
});

const allocationBody = z.object({
  applicationNumber: z.string().min(1),
  paymentId: z.string().min(1),
  /**
   * Счёт заявки обязателен: ручной зачёт связывает платёж 1С с конкретным счётом
   * этой заявки. Без счёта привязка неоднозначна — платёж не к чему привязать.
   */
  invoiceId: z.string().min(1),
  amount: z.number().positive(),
  comment: z.string().max(500).optional(),
});

const ackBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  error: z.string().max(500).nullish(),
});

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  /** Приём счетов, платежей и отгрузок 1С по токену интеграции. */
  app.post('/api/v1/integrations/commercial/sync', async (req, reply) => {
    assertIntegrationToken(req.headers['x-integration-token']);
    const correlationId = correlationOf(req);
    const body = syncBody.parse(req.body);
    const result = await syncCommercial({ ...body, correlationId });
    return reply.status(200).send(result);
  });

  /** Очередь исходящих сообщений (SYNC-05). */
  app.get('/api/v1/integrations/outbox', auth, async (req) => {
    const { principal } = ctx(req);
    assertPermission(principal.role as never, P.ADMIN_INTEGRATIONS);
    return listOutbox(req.query as Record<string, unknown>);
  });

  // Подтверждение доставки — служебная операция 1С, доступна только администратору
  // (SYNC-05, RBAC-01). Раньше здесь не было проверки прав.
  app.post('/api/v1/integrations/outbox/delivered', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    assertPermission(principal.role as never, P.ADMIN_INTEGRATIONS, 'Подтверждение доставки сообщений 1С доступно только администратору.');
    const { ids, error } = ackBody.parse(req.body);
    return { updated: await markOutboxDelivered(ids, correlationId, error ?? undefined) };
  });

  /** Состояние интеграций для экрана администрирования (§12). */
  app.get('/api/v1/integrations/status', auth, async (req) => {
    const { principal } = ctx(req);
    assertPermission(principal.role as never, P.ADMIN_INTEGRATIONS);
    return getIntegrationStatus();
  });

  /** Ручной зачёт платежа 1С по счёту заявки. */
  app.post('/api/v1/applications/:number/payments/allocate', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = z.object({ number: z.string().min(1) }).parse(req.params);
    const body = allocationBody.parse({ ...(req.body as Record<string, unknown>), applicationNumber: number });
    return allocatePaymentManually({ ...body, correlationId, actor: principal });
  });
}