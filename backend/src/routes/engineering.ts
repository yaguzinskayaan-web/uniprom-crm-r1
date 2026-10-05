import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctx, requireAuth } from './context.js';
import {
  approveEngineeringConclusion,
  assignEngineeringTask,
  cancelEngineeringTask,
  completeEngineeringTask,
  createEngineeringTask,
  getEngineeringTask,
  listEngineeringTasks,
  updateEngineeringTaskStatus,
} from '../services/engineering.js';

const appParams = z.object({ number: z.string().min(1) });
const taskParams = z.object({ taskId: z.string().min(1) });
const conclusionParams = z.object({ conclusionId: z.string().min(1) });

const createBody = z.object({
  kind: z.enum(['PREQUOTE', 'ORDER_DESIGN']),
  assigneeId: z.string().nullish(),
  priority: z.string().min(1),
  dueAt: z.string().optional(),
  questions: z.string().optional(),
});

const assignBody = z.object({ assigneeId: z.string().min(1) });

const statusBody = z.object({
  status: z.enum(['NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_INPUT', 'CANCELLED']),
  lockVersion: z.number().int().min(1),
});

const completeBody = z.object({
  decision: z.enum(['FEASIBLE', 'FEASIBLE_WITH_CONDITIONS', 'NOT_FEASIBLE', 'NEED_DATA']),
  conditions: z.string().optional(),
  technicalExecution: z.string().optional(),
  priceInputs: z.record(z.unknown()).optional(),
  leadTimeDays: z.number().int().nonnegative().optional(),
  fileIds: z.array(z.string()).optional(),
});

const cancelBody = z.object({ reason: z.string().min(1, 'Укажите причину отмены') });

const approveBody = z.object({ approve: z.boolean(), comment: z.string().optional() });

export async function engineeringRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  app.get('/api/v1/engineering/tasks', auth, async (req) => {
    const { principal } = ctx(req);
    return listEngineeringTasks(req.query as Record<string, unknown>, principal);
  });

  app.post('/api/v1/applications/:number/engineering-tasks', auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = createBody.parse(req.body);
    const task = await createEngineeringTask({ number, ...body, actor: principal, correlationId });
    return reply.status(201).send(task);
  });

  app.get('/api/v1/engineering/tasks/:taskId', auth, async (req) => {
    const { principal } = ctx(req);
    const { taskId } = taskParams.parse(req.params);
    return getEngineeringTask(taskId, principal);
  });

  app.post('/api/v1/engineering/tasks/:taskId/assign', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = taskParams.parse(req.params);
    const body = assignBody.parse(req.body);
    return assignEngineeringTask(taskId, body.assigneeId, correlationId, principal);
  });

  app.patch('/api/v1/engineering/tasks/:taskId/status', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = taskParams.parse(req.params);
    const body = statusBody.parse(req.body);
    return updateEngineeringTaskStatus(taskId, body.status, body.lockVersion, correlationId, principal);
  });

  app.post('/api/v1/engineering/tasks/:taskId/complete', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = taskParams.parse(req.params);
    const body = completeBody.parse(req.body);
    return completeEngineeringTask({ id: taskId, ...body, actor: principal, correlationId });
  });

  app.post('/api/v1/engineering/tasks/:taskId/cancel', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = taskParams.parse(req.params);
    const body = cancelBody.parse(req.body);
    return cancelEngineeringTask(taskId, body.reason, correlationId, principal);
  });

  app.post('/api/v1/engineering/conclusions/:conclusionId/approve', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { conclusionId } = conclusionParams.parse(req.params);
    const body = approveBody.parse(req.body);
    return approveEngineeringConclusion(conclusionId, body.approve, body.comment, correlationId, principal);
  });
}
