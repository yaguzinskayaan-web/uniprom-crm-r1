import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctx, requireAuth } from './context.js';
import {
  checkCommercialBasisChange,
  confirmDispatch,
  createQuote,
  decideApproval,
  generateQuoteDocument,
  getQuote,
  listQuotes,
  markDispatchFailed,
  recordExternalSend,
  registerCustomerDecision,
  sendQuote,
  submitForApproval,
  updateQuote,
  uploadQuoteDocument,
} from '../services/quotes.js';
import { requireIdempotencyKey } from '../lib/query.js';

const appParams = z.object({ number: z.string().min(1) });
const quoteParams = z.object({ quoteId: z.string().min(1) });
const dispatchParams = z.object({ dispatchId: z.string().min(1) });

const createBody = z.object({
  validUntil: z.string().optional(),
  leadTimeDays: z.number().int().nonnegative().optional(),
  deliveryTerms: z.string().optional(),
  paymentTermsNote: z.string().optional(),
  discountPct: z.number().min(0).max(100).optional(),
  taxAttribute: z.string().optional(),
  technicalNotes: z.string().optional(),
  conditionsNote: z.string().optional(),
  lines: z
    .array(z.object({ lineId: z.string().min(1), quantity: z.number().positive().optional(), price: z.number().nonnegative() }))
    .optional(),
});

const updateBody = z.object({
  lockVersion: z.number().int().min(1, 'Передайте версию версии КП (lock_version)'),
  validUntil: z.string().nullish(),
  leadTimeDays: z.number().int().nonnegative().optional(),
  deliveryTerms: z.string().optional(),
  paymentTermsNote: z.string().optional(),
  discountPct: z.number().min(0).max(100).optional(),
  taxAttribute: z.string().optional(),
  technicalNotes: z.string().optional(),
  conditionsNote: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1),
        name: z.string().optional(),
        unit: z.string().optional(),
        quantity: z.number().positive(),
        price: z.number().nonnegative(),
      }),
    )
    .optional(),
});

const decisionBody = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  comment: z.string().optional(),
});

const sendBody = z.object({
  recipients: z.array(z.string().min(3)).min(1, 'Укажите хотя бы одного получателя'),
  subject: z.string().optional(),
  body: z.string().optional(),
});

const externalSendBody = z.object({
  recipients: z.array(z.string().min(3)).min(1, 'Укажите получателя'),
  actualDateTime: z.string().min(1, 'Укажите фактические дату и время отправки'),
  channel: z.string().default('EXTERNAL_MAIL'),
  note: z.string().optional(),
  fileId: z.string().optional(),
});

const customerDecisionBody = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  note: z.string().optional(),
  refMessageId: z.string().optional(),
});

export async function quoteRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  app.get('/api/v1/applications/:number/quotes', auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appParams.parse(req.params);
    return listQuotes(number, principal);
  });

  app.post('/api/v1/applications/:number/quotes', auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = createBody.parse(req.body);
    const quote = await createQuote({ number, ...body, actor: principal, correlationId });
    return reply.status(201).send(quote);
  });

  app.get('/api/v1/quotes/:quoteId', auth, async (req) => {
    const { principal } = ctx(req);
    const { quoteId } = quoteParams.parse(req.params);
    return getQuote(quoteId, principal);
  });

  app.patch('/api/v1/quotes/:quoteId', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = quoteParams.parse(req.params);
    const body = updateBody.parse(req.body);
    return updateQuote(quoteId, body, body.lockVersion, correlationId, principal);
  });

  app.post('/api/v1/quotes/:quoteId/generate', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = quoteParams.parse(req.params);
    return generateQuoteDocument(quoteId, correlationId, principal);
  });

  app.post('/api/v1/quotes/:quoteId/upload', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = quoteParams.parse(req.params);
    const file = await req.file();
    if (!file) {
      return { error: 'Файл не передан' } as never;
    }
    const buffer = await file.toBuffer();
    return uploadQuoteDocument(
      quoteId,
      { buffer, originalName: file.filename, contentType: file.mimetype },
      correlationId,
      principal,
    );
  });

  app.post('/api/v1/quotes/:quoteId/submit-approval', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = quoteParams.parse(req.params);
    return submitForApproval(quoteId, correlationId, principal);
  });

  app.post('/api/v1/quotes/:quoteId/approval-decision', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = quoteParams.parse(req.params);
    const body = decisionBody.parse(req.body);
    return decideApproval(quoteId, body.decision, body.comment, correlationId, principal);
  });

  app.post('/api/v1/quotes/:quoteId/send', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = quoteParams.parse(req.params);
    const body = sendBody.parse(req.body);
    // SEND-02: повторяющаяся отправка с тем же ключом не ставит второе письмо
    const key = requireIdempotencyKey(req.headers['idempotency-key'] as string | undefined, 'отправка КП');
    return sendQuote({ id: quoteId, ...body, idempotencyKey: key, actor: principal, correlationId });
  });

  app.post('/api/v1/quotes/:quoteId/external-send', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = quoteParams.parse(req.params);
    const body = externalSendBody.parse(req.body);
    return recordExternalSend({ id: quoteId, ...body, actor: principal, correlationId });
  });

  app.post('/api/v1/quotes/:quoteId/customer-decision', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = quoteParams.parse(req.params);
    const body = customerDecisionBody.parse(req.body);
    return registerCustomerDecision({ id: quoteId, ...body, actor: principal, correlationId });
  });

  app.get('/api/v1/applications/:number/commercial-basis-check', auth, async (req) => {
    const { number } = appParams.parse(req.params);
    return checkCommercialBasisChange(number);
  });

  // ── Служебные маршруты почтового воркера: подтверждение фактического результата
  app.post('/internal/dispatches/:dispatchId/confirm', auth, async (req) => {
    const { correlationId } = ctx(req);
    const { dispatchId } = dispatchParams.parse(req.params);
    return { dispatch: await confirmDispatch(dispatchId, correlationId) };
  });

  app.post('/internal/dispatches/:dispatchId/failure', auth, async (req) => {
    const { correlationId } = ctx(req);
    const { dispatchId } = dispatchParams.parse(req.params);
    const body = z
      .object({ state: z.enum(['FAILED', 'UNKNOWN']), errorText: z.string().default('') })
      .parse(req.body);
    return { dispatch: await markDispatchFailed(dispatchId, body.state, body.errorText, correlationId) };
  });
}
