import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { correlationOf, ctx, requireAuth } from './context.js';
import {
  createApplicationFromMail,
  ignoreMail,
  linkMailToApplication,
  listInbox,
  receiveMail,
} from '../services/mail.js';
import { config } from '../config.js';

/**
 * Входящая почта (§5.2). Приём выполняется интеграцией по токену, разбор и
 * привязка — только сотрудником с соответствующими полномочиями.
 */

const mailParams = z.object({ mailId: z.string().min(1) });
const appParams = z.object({ number: z.string().min(1) });

const incomingBody = z.object({
  mailbox: z.string().min(1),
  messageId: z.string().min(1),
  inReplyTo: z.string().nullish(),
  references: z.string().nullish(),
  from: z.string().min(3, 'Укажите отправителя'),
  to: z.string().min(3),
  subject: z.string().nullish(),
  bodyText: z.string().nullish(),
  bodyHtml: z.string().nullish(),
  receivedAt: z.string().optional(),
  attachments: z
    .array(z.object({ name: z.string(), size: z.number().int().nonnegative(), contentType: z.string(), objectKey: z.string().optional() }))
    .optional(),
});

const createAppBody = z.object({
  organizationName: z.string().min(1, 'Укажите контрагента'),
  inn: z.string().optional(),
  kpp: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().optional(),
  comment: z.string().optional(),
  idempotencyKey: z.string().optional(),
  lines: z
    .array(
      z.object({
        name: z.string().min(1, 'Укажите номенклатуру позиции'),
        quantity: z.number().positive('Количество должно быть больше нуля'),
        unit: z.string().optional(),
        price: z.number().nonnegative().optional(),
        lineId: z.string().optional(),
      }),
    )
    .min(1, 'Добавьте хотя бы одну позицию'),
});

const linkBody = z.object({ applicationNumber: appParams.shape.number });
const ignoreBody = z.object({ reason: z.string().min(1, 'Укажите причину') });

export async function mailRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  app.get('/api/v1/mail/inbox', auth, async (req) => {
    const { principal } = ctx(req);
    return listInbox(req.query as Record<string, unknown>, principal);
  });

  /** Приём письма интеграцией: токен в заголовке, без пользовательской сессии. */
  app.post('/api/v1/integrations/mail/inbound', async (req, reply) => {
    const token = req.headers['x-integration-token'];
    // Отсутствие заголовка не раскрывает существование метода, неверный токен
    // отклоняется как ошибка авторизации.
    if (typeof token !== 'string' || !token.trim()) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Не найдено' } });
    }
    if (token !== config.integrationToken) {
      return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Недействительный токен интеграции' } });
    }
    const correlationId = correlationOf(req);
    const body = incomingBody.parse(req.body);
    const result = await receiveMail(
      { ...body, receivedAt: body.receivedAt ?? new Date().toISOString() },
      correlationId,
    );
    return reply.status(result.duplicate ? 200 : 202).send(result);
  });

  app.post('/api/v1/mail/:mailId/create-application', auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const { mailId } = mailParams.parse(req.params);
    const body = createAppBody.parse(req.body);
    const result = await createApplicationFromMail({ id: mailId, ...body, correlationId, actor: principal });
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });

  app.post('/api/v1/mail/:mailId/link', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { mailId } = mailParams.parse(req.params);
    const body = linkBody.parse(req.body);
    return linkMailToApplication({ id: mailId, applicationNumber: body.applicationNumber, correlationId, actor: principal });
  });

  app.post('/api/v1/mail/:mailId/ignore', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { mailId } = mailParams.parse(req.params);
    const body = ignoreBody.parse(req.body);
    return ignoreMail({ id: mailId, reason: body.reason, correlationId, actor: principal });
  });
}