import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctx, requireAuth } from './context.js';
import {
  createUser,
  downloadFile,
  listAssignableUsers,
  listAuditEvents,
  listCalendars,
  listFiles,
  listReferences,
  listUsers,
  resetUserPassword,
  setUserBlocked,
  updateUser,
  uploadFile,
  upsertCalendar,
  upsertReference,
} from '../services/admin.js';

/** Администрирование, справочники, календарь, файлы и технический аудит. */

const userParams = z.object({ userId: z.string().min(1) });
const fileParams = z.object({ fileId: z.string().min(1) });

const createUserBody = z.object({
  login: z.string().min(3, 'Логин не короче 3 символов'),
  email: z.string().email('Укажите корректный email').optional(),
  fullName: z.string().min(1, 'Укажите ФИО'),
  role: z.string().min(1, 'Выберите роль'),
  password: z.string().min(8, 'Пароль не короче 8 символов'),
});

const updateUserBody = z.object({
  lockVersion: z.number().int().min(1, 'Передайте текущую версию пользователя'),
  fullName: z.string().optional(),
  email: z.string().email().nullish(),
  role: z.string().optional(),
});

const blockBody = z.object({ blocked: z.boolean(), reason: z.string().min(1, 'Укажите причину') });
const resetBody = z.object({ newPassword: z.string().min(8, 'Пароль не короче 8 символов') });

const referenceBody = z.object({
  kind: z.string().min(1),
  code: z.string().min(1),
  label: z.string().min(1),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const calendarBody = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  timezone: z.string().min(1),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1, 'Выберите рабочие дни'),
  workStart: z.string().regex(/^\d{2}:\d{2}$/, 'Формат ЧЧ:ММ'),
  workEnd: z.string().regex(/^\d{2}:\d{2}$/, 'Формат ЧЧ:ММ'),
  holidays: z.array(z.string()).default([]),
  isDefault: z.boolean().default(false),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  // Пользователи
  app.get('/api/v1/users', auth, async (req) => listUsers(req.query as Record<string, unknown>, ctx(req).principal));
  app.get('/api/v1/users/assignable', auth, async (req) => {
    const { principal } = ctx(req);
    return listAssignableUsers(principal);
  });
  app.post('/api/v1/users', auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const body = createUserBody.parse(req.body);
    const user = await createUser({ ...body, correlationId, actor: principal });
    return reply.status(201).send(user);
  });
  app.patch('/api/v1/users/:userId', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { userId } = userParams.parse(req.params);
    const body = updateUserBody.parse(req.body);
    return updateUser({ id: userId, ...body, correlationId, actor: principal });
  });
  app.post('/api/v1/users/:userId/block', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { userId } = userParams.parse(req.params);
    const body = blockBody.parse(req.body);
    return setUserBlocked({ id: userId, blocked: body.blocked, reason: body.reason, correlationId, actor: principal });
  });
  app.post('/api/v1/users/:userId/reset-password', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { userId } = userParams.parse(req.params);
    const body = resetBody.parse(req.body);
    return resetUserPassword({ id: userId, newPassword: body.newPassword, correlationId, actor: principal });
  });

  // Справочники
  app.get('/api/v1/references', auth, async (req) => {
    const { principal } = ctx(req);
    return listReferences(req.query as Record<string, unknown>, principal);
  });
  app.put('/api/v1/references', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const body = referenceBody.parse(req.body);
    return upsertReference({ ...body, correlationId, actor: principal });
  });

  // Рабочий календарь
  app.get('/api/v1/calendars', auth, async (req) => {
    const { principal } = ctx(req);
    return listCalendars(principal);
  });
  app.put('/api/v1/calendars', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const body = calendarBody.parse(req.body);
    return upsertCalendar({ ...body, correlationId, actor: principal });
  });

  // Файлы
  app.get('/api/v1/files', auth, async (req) => {
    const { principal } = ctx(req);
    return listFiles(req.query as Record<string, unknown>, principal);
  });
  app.post('/api/v1/files', auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const parts = req.parts();
    const fields: Record<string, string> = {};
    let buffer: Buffer | null = null;
    let originalName = '';
    let contentType = '';
    for await (const part of parts) {
      if (part.type === 'file') {
        buffer = await part.toBuffer();
        originalName = part.filename;
        contentType = part.mimetype;
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (!buffer) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Файл не передан' } });
    }
    const file = await uploadFile({
      buffer,
      originalName,
      contentType,
      applicationNumber: fields.applicationNumber,
      correlationId,
      actor: principal,
    });
    return reply.status(201).send(file);
  });
  app.get('/api/v1/files/:fileId', auth, async (req, reply) => {
    const { principal } = ctx(req);
    const { fileId } = fileParams.parse(req.params);
    const { file, buffer } = await downloadFile(fileId, principal);
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`)
      .send(buffer);
  });

  // Технический аудит
  app.get('/api/v1/audit-events', auth, async (req) => {
    const { principal } = ctx(req);
    return listAuditEvents(req.query as Record<string, unknown>, principal);
  });
}
