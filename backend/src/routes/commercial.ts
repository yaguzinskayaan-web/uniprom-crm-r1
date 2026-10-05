import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctx, requireAuth } from './context.js';
import {
  approveRelease,
  checkRelease,
  completeRelease,
  getCommercial,
  releaseToProduction,
  revokeRelease,
  signContract,
  updateCommercial,
  updateProductionStage,
} from '../services/commercial.js';

/**
 * Коммерческие условия, договор и выпуск в производство (GATE-01..04).
 * GET-проверка не меняет данные; изменяющий POST повторяет все проверки
 * в одной транзакции.
 */

const appParams = z.object({ number: z.string().min(1) });
const pathNumber = '/api/v1/applications/:number';

const termsBody = z.object({
  lockVersion: z.number().int().min(1, 'Передайте текущую версию условий'),
  contractNumber: z.string().nullish(),
  contractDate: z.string().nullish(),
  specificationRef: z.string().nullish(),
  basisQuoteId: z.string().nullish(),
  paymentTerms: z.string().nullish(),
  paymentSchedule: z
    .array(
      z.object({
        stage: z.string().min(1),
        pct: z.number().min(0).max(100),
        dueDays: z.number().int().nonnegative().nullish(),
      }),
    )
    .optional(),
  deliveryTerms: z.string().nullish(),
  criticalTermsChanged: z.boolean().optional(),
  comment: z.string().optional(),
});

const signBody = z.object({
  lockVersion: z.number().int().min(1, 'Передайте текущую версию условий'),
  contractNumber: z.string().min(1, 'Укажите номер договора'),
  contractDate: z.string().optional(),
  contractFileObjectKey: z.string().optional(),
});

const approvalBody = z.object({
  reason: z.string().min(10, 'Опишите основание ручного разрешения подробно (не менее 10 символов)'),
});

const revokeBody = z.object({
  reason: z.string().min(5, 'Укажите причину отзыва разрешения'),
});

const stageBody = z.object({
  to: z.string().min(1, 'Укажите этап производства'),
  comment: z.string().optional(),
});

export async function commercialRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  app.get(`${pathNumber}/commercial`, auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appParams.parse(req.params);
    return getCommercial(number, principal);
  });

  app.patch(`${pathNumber}/commercial`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = termsBody.parse(req.body);
    return updateCommercial({ number, ...body, correlationId, actor: principal });
  });

  app.post(`${pathNumber}/commercial/sign-contract`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = signBody.parse(req.body);
    return signContract({ number, ...body, correlationId, actor: principal });
  });

  /** GATE-01: проверка выпуска — только чтение, состояние не меняется. */
  app.get(`${pathNumber}/release-check`, auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appParams.parse(req.params);
    return checkRelease(number, principal);
  });

  /** GATE-02: повтор всех проверок перед изменением состояния. */
  app.post(`${pathNumber}/release-check`, auth, async (req, reply) => {
    const { principal } = ctx(req);
    const { number } = appParams.parse(req.params);
    const check = await checkRelease(number, principal);
    if (!check.can_release_to_production) return reply.status(422).send(check);
    return reply.status(200).send(check);
  });

  app.post(`${pathNumber}/release-production`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    return releaseToProduction({ number, correlationId, actor: principal });
  });

  app.post(`${pathNumber}/release-approval`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = approvalBody.parse(req.body);
    return approveRelease({ number, reason: body.reason, correlationId, actor: principal });
  });

  app.delete(`${pathNumber}/release-approval`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = revokeBody.parse(req.body ?? {});
    return revokeRelease({ number, reason: body.reason, correlationId, actor: principal });
  });

  app.post(`${pathNumber}/production-stage`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = stageBody.parse(req.body);
    return updateProductionStage({ number, to: body.to, comment: body.comment, correlationId, actor: principal });
  });

  app.post(`${pathNumber}/production-complete`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    return completeRelease({ number, correlationId, actor: principal });
  });
}
