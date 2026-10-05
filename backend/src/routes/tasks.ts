import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctx, requireAuth } from './context.js';
import {
  cancelTask,
  completeTask,
  correctActivity,
  createTask,
  getMyWork,
  listActivities,
  listTasks,
  parseTaskListQuery,
  registerActivity,
  updateTask,
} from '../services/tasks.js';

/** Задачи и бизнес-хронология (§10.1). */

const appParams = z.object({ number: z.string().min(1) });
const taskParams = z.object({ taskId: z.string().min(1) });
const activityParams = z.object({ activityId: z.string().min(1) });

const createBody = z.object({
  type: z.string().min(1, 'Выберите тип задачи'),
  subject: z.string().min(1, 'Укажите тему задачи'),
  description: z.string().optional(),
  assigneeId: z.string().min(1, 'Выберите исполнителя'),
  dueAt: z.string().min(4, 'Укажите срок исполнения в формате ISO 8601'),
  priority: z.string().optional(),
  contactId: z.string().nullish(),
  reminderAt: z.string().nullish(),
});

const updateBody = z.object({
  lockVersion: z.number().int().min(1, 'Передайте текущую версию задачи'),
  subject: z.string().optional(),
  description: z.string().nullish(),
  assigneeId: z.string().optional(),
  dueAt: z.string().optional(),
  priority: z.string().optional(),
  reminderAt: z.string().nullish(),
});

const completeBody = z.object({ result: z.string().optional() });
const cancelBody = z.object({ reason: z.string().min(1, 'Укажите причину отмены') });

const activityBody = z.object({
  type: z.string().min(1, 'Выберите тип активности'),
  direction: z.enum(['IN', 'OUT']).nullish(),
  participants: z.array(z.string()).optional(),
  occurredAt: z.string().optional(),
  subject: z.string().optional(),
  content: z.string().optional(),
  result: z.string().optional(),
  isCustomerFacing: z.boolean().optional(),
});

const correctBody = z.object({
  content: z.string().min(1, 'Укажите исправленный текст'),
  result: z.string().nullish(),
});

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  app.get('/api/v1/tasks', auth, async (req) => {
    const { principal } = ctx(req);
    return listTasks(parseTaskListQuery(req.query as Record<string, unknown>), principal);
  });

  app.post('/api/v1/applications/:number/tasks', auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = createBody.parse(req.body);
    const task = await createTask({ applicationNumber: number, ...body, correlationId, actor: principal });
    return reply.status(201).send(task);
  });

  app.patch('/api/v1/tasks/:taskId', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = taskParams.parse(req.params);
    const body = updateBody.parse(req.body);
    return updateTask({ id: taskId, ...body, correlationId, actor: principal });
  });

  app.post('/api/v1/tasks/:taskId/complete', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = taskParams.parse(req.params);
    const body = completeBody.parse(req.body ?? {});
    return completeTask({ id: taskId, result: body.result, correlationId, actor: principal });
  });

  app.post('/api/v1/tasks/:taskId/cancel', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = taskParams.parse(req.params);
    const body = cancelBody.parse(req.body);
    return cancelTask({ id: taskId, reason: body.reason, correlationId, actor: principal });
  });

  app.get('/api/v1/applications/:number/activities', auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appParams.parse(req.params);
    return listActivities(number, req.query as Record<string, unknown>, principal);
  });

  app.post('/api/v1/applications/:number/activities', auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appParams.parse(req.params);
    const body = activityBody.parse(req.body);
    const activity = await registerActivity({ applicationNumber: number, ...body, correlationId, actor: principal });
    return reply.status(201).send(activity);
  });

  app.patch('/api/v1/activities/:activityId', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { activityId } = activityParams.parse(req.params);
    const body = correctBody.parse(req.body);
    return correctActivity({ id: activityId, ...body, correlationId, actor: principal });
  });

  /** Мобильный сценарий «Моя работа» (§3.3). */
  app.get('/api/v1/my-work', auth, async (req) => {
    const { principal } = ctx(req);
    return getMyWork(principal);
  });
}
