import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctx, requireAuth } from './context.js';
import {
  assignApplication,
  changeStage,
  createApplication,
  getApplicationByNumber,
  getAuditTrail,
  getTimeline,
  listApplications,
  parseListQuery,
  setApplicationComplexity,
  updateApplication,
  type CreateApplicationInput,
  type UpdateApplicationInput,
} from '../services/applications.js';
import { STAGES } from '../domain/constants.js';

const paramsNumber = z.object({ number: z.string().min(1) });

const lineSchema = z.object({
  lineId: z.string().optional(),
  name: z.string().min(1, 'Укажите наименование позиции'),
  quantity: z.number().positive('Количество должно быть больше нуля'),
  unit: z.string().optional(),
  catalogRef: z.string().optional(),
  price: z.number().nonnegative().optional(),
  complexity: z.enum(['NEEDS_CLASSIFICATION', 'STANDARD', 'MODIFIED', 'CUSTOM']).optional(),
  params: z.record(z.unknown()).optional(),
  calculationRevision: z.string().optional(),
});

const createBody = z.object({
  organizationId: z.string().optional(),
  organizationName: z.string().min(1, 'Укажите организацию').optional(),
  inn: z.string().optional(),
  kpp: z.string().optional(),
  contactId: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().optional(),
  source: z.string().min(1, 'Укажите источник'),
  sourceRef: z.string().optional(),
  priority: z.string().min(1),
  externalNumber: z.string().optional(),
  expectedDecisionDate: z.string().optional(),
  successProbability: z.number().min(0).max(100).optional(),
  tags: z.array(z.string()).optional(),
  crmComment: z.string().optional(),
  engineQuestions: z.record(z.unknown()).optional(),
  lines: z.array(lineSchema).optional(),
  ownerId: z.string().nullish(),
  leaveInQueue: z.boolean().optional(),
  isDraft: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
});

const updateBody = z.object({
  lockVersion: z.number().int().min(1, 'Передайте версию записи (lock_version)'),
  contactId: z.string().nullish(),
  ownerId: z.string().nullish(),
  priority: z.string().optional(),
  successProbability: z.number().min(0).max(100).nullish(),
  expectedDecisionDate: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  crmComment: z.string().nullish(),
  engineQuestions: z.record(z.unknown()).optional(),
  isDraft: z.boolean().optional(),
  lines: z
    .array(
      lineSchema.partial().extend({
        lineId: z.string().min(1),
        quantity: z.number().positive().optional(),
        complexity: z.enum(['NEEDS_CLASSIFICATION', 'STANDARD', 'MODIFIED', 'CUSTOM']).nullish(),
        params: z.record(z.unknown()).optional(),
      }),
    )
    .optional(),
});

const stageBody = z.object({
  to: z.enum(STAGES as unknown as [string, ...string[]]),
  lossReason: z.string().optional(),
  lossComment: z.string().optional(),
  comment: z.string().optional(),
});

const assignBody = z.object({
  ownerId: z.string().nullable(),
  moveOpenTasks: z.boolean().default(false),
  comment: z.string().optional(),
});

const complexityBody = z.object({
  complexity: z.enum(['NEEDS_CLASSIFICATION', 'STANDARD', 'MODIFIED', 'CUSTOM']),
  comment: z.string().optional(),
});

export async function applicationRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  app.get('/api/v1/applications', auth, async (req) => {
    const { principal } = ctx(req);
    const params = parseListQuery(req.query as Record<string, unknown>);
    return listApplications(params, principal);
  });

  app.post('/api/v1/applications', auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const body = createBody.parse(req.body) as CreateApplicationInput;
    const result = await createApplication({ ...body, actor: principal, correlationId });
    // IN-03: повтор с тем же ключом возвращает существующую заявку, а не создаёт новую
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });

  app.get('/api/v1/applications/:number', auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = paramsNumber.parse(req.params);
    return getApplicationByNumber(number, principal);
  });

  app.patch('/api/v1/applications/:number', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = paramsNumber.parse(req.params);
    const body = updateBody.parse(req.body);
    const input: UpdateApplicationInput = { number, lockVersion: body.lockVersion, actor: principal, correlationId };
    if (body.contactId !== undefined) input.contactId = body.contactId;
    if (body.ownerId !== undefined) input.ownerId = body.ownerId;
    if (body.priority !== undefined) input.priority = body.priority;
    if (body.successProbability !== undefined) input.successProbability = body.successProbability;
    if (body.expectedDecisionDate !== undefined) input.expectedDecisionDate = body.expectedDecisionDate;
    if (body.tags !== undefined) input.tags = body.tags;
    if (body.crmComment !== undefined) input.crmComment = body.crmComment;
    if (body.engineQuestions !== undefined) input.engineQuestions = body.engineQuestions;
    if (body.isDraft !== undefined) input.isDraft = body.isDraft;
    if (body.lines !== undefined) input.lines = body.lines as UpdateApplicationInput['lines'];
    return updateApplication(input);
  });

  app.post('/api/v1/applications/:number/stage', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = paramsNumber.parse(req.params);
    const body = stageBody.parse(req.body);
    return changeStage({
      number,
      to: body.to as never,
      ...(body.lossReason !== undefined ? { lossReason: body.lossReason } : {}),
      ...(body.lossComment !== undefined ? { lossComment: body.lossComment } : {}),
      ...(body.comment !== undefined ? { comment: body.comment } : {}),
      actor: principal,
      correlationId,
    });
  });

  app.post('/api/v1/applications/:number/assign', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = paramsNumber.parse(req.params);
    const body = assignBody.parse(req.body);
    return assignApplication({ number, ownerId: body.ownerId, moveOpenTasks: body.moveOpenTasks, actor: principal, correlationId });
  });

  app.post('/api/v1/applications/:number/complexity', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = paramsNumber.parse(req.params);
    const body = complexityBody.parse(req.body);
    return setApplicationComplexity({ number, complexity: body.complexity, actor: principal, correlationId });
  });

  app.get('/api/v1/applications/:number/timeline', auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = paramsNumber.parse(req.params);
    return getTimeline(number, principal);
  });

  app.get('/api/v1/applications/:number/audit', auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = paramsNumber.parse(req.params);
    return getAuditTrail(number, principal);
  });
}
