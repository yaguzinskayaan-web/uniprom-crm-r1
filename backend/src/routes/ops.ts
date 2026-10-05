import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctx, requireAuth } from './context.js';
import { listSlaInstances, listSlaRules, resumeSla, upsertSlaRule } from '../services/sla.js';
import {
  checkCloseReadiness,
  closeApplication,
  getFulfilment,
  listClosingDocuments,
  registerClosingDocument,
} from '../services/fulfillment.js';

const appParams = z.object({ number: z.string().min(1) });
const instanceParams = z.object({ instanceId: z.string().min(1) });

const closeBody = z.object({
  lockVersion: z.number().int().positive(),
  comment: z.string().max(2000).optional(),
});

const closingDocBody = z.object({
  docType: z.string().min(1),
  docNumber: z.string().max(120).optional(),
  extId: z.string().max(120).nullish(),
  extSystem: z.string().max(30).nullish(),
  status: z.enum(['PENDING', 'REGISTERED', 'SIGNED', 'CANCELLED']).optional(),
  fileId: z.string().nullish(),
  source: z.enum(['ONE_C', 'CRM']).optional(),
});

const ruleBody = z.object({
  id: z.string().optional(),
  code: z.string().optional(),
  name: z.string().optional(),
  stage: z.string().optional(),
  complexity: z.string().optional(),
  priority: z.string().optional(),
  usesBusinessHours: z.boolean().optional(),
  durationMinutes: z.number().int().nonnegative().optional(),
  remindBeforeMinutes: z.number().int().nonnegative().optional(),
  escalationUserId: z.string().nullish(),
  pauseOnCustomerWait: z.boolean().optional(),
});

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  // SLA
  app.get('/api/v1/sla/rules', auth, async () => listSlaRules());

  app.put('/api/v1/sla/rules', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const body = ruleBody.parse(req.body);
    return upsertSlaRule(body, principal, correlationId);
  });

  app.get('/api/v1/sla/instances', auth, async (req) => listSlaInstances(req.query as Record<string, unknown>));

  app.post('/api/v1/sla/instances/:instanceId/resume', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { instanceId } = instanceParams.parse(req.params);
    return resumeSla(instanceId, correlationId, principal);
  });

  // Исполнение
  app.get('/api/v1/applications/:number/fulfilment', auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appParams.parse(req.params);
    return getFulfilment(number, principal);
  });

  app.get('/api/v1/applications/:number/close-check', auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appParams.parse(req.params);
    return checkCloseReadiness(number, principal);
  });

  // CLOSE-02: закрытие заявки — отдельное действие с проверкой условий
  app.post('/api/v1/applications/:number/close', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = closeBody.parse(req.body);
    return closeApplication(number, { lockVersion: body.lockVersion, comment: body.comment, correlationId, actor: principal });
  });

  // Регистрация закрывающего документа
  app.post('/api/v1/applications/:number/closing-documents', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = closingDocBody.parse(req.body);
    return registerClosingDocument({ ...body, number, correlationId, actor: principal });
  });

  app.get('/api/v1/applications/:number/closing-documents', auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appParams.parse(req.params);
    return listClosingDocuments(number, principal);
  });
}
