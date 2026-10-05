import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctx, requireAuth } from './context.js';
import { getDashboard, getPipeline } from '../services/analytics.js';
import { getTimeline } from '../services/applications.js';
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
import {
  createQuote,
  decideApproval,
  generateQuoteDocument,
  getQuote,
  listQuotes,
  registerCustomerDecision,
  sendQuote,
  submitForApproval,
  checkCommercialBasisChange,
} from '../services/quotes.js';
import { requireIdempotencyKey } from '../lib/query.js';
import { importHandlers } from './imports.js';

const { importInspect, importUpload } = importHandlers();
import {
  correctActivity,
  cancelTask,
  completeTask,
  createTask,
  listActivities,
  listTasks,
  parseTaskListQuery,
  registerActivity,
  updateTask,
} from '../services/tasks.js';
import {
  approveRelease,
  checkRelease,
  revokeRelease,
  updateCommercial,
} from '../services/commercial.js';
import {
  createApplicationFromMail,
  ignoreMail,
  linkMailToApplication,
  listInbox,
} from '../services/mail.js';
import { confirmBatch, createBatch, getBatch, type ImportSource } from '../services/imports.js';
import { listAuditEvents, listCalendars, listReferences, upsertCalendar, upsertReference } from '../services/admin.js';
import {
  getIntegrationStatus,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  searchContacts,
  searchOrganizations,
} from '../services/directory.js';
import {
  checkCloseReadiness,
  closeApplication,
  getFulfilment,
  listClosingDocuments,
  registerClosingDocument,
} from '../services/fulfillment.js';
import { listSlaRules, upsertSlaRule } from '../services/sla.js';
import { LOSS_REASONS, ACTIVITY_TYPES } from '../domain/constants.js';

/**
 * Контрактные пути ТЗ §13.3: `/api/v1/crm/...`. Канонические маршруты остаются
 * доступны без префикса `/crm`, поэтому оба варианта контракта работают
 * одновременно и проверяют одни и те же права.
 */

const appNumber = z.object({ number: z.string().min(1) });
const idParam = (key: string) => z.object({ [key]: z.string().min(1) });

// Схемы тела повторяют канонические маршруты: контрактный путь не должен
// принимать то, что отвергает канонический, и наоборот.
const quoteCreateBody = z.object({
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

const quoteDecisionBody = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  comment: z.string().optional(),
});

const quoteSendBody = z.object({
  recipients: z.array(z.string().min(3)).min(1, 'Укажите хотя бы одного получателя'),
  subject: z.string().optional(),
  body: z.string().optional(),
});

const quoteCustomerDecisionBody = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  note: z.string().optional(),
  refMessageId: z.string().optional(),
});

const engCreateBody = z.object({
  kind: z.enum(['PREQUOTE', 'ORDER_DESIGN']),
  assigneeId: z.string().nullish(),
  priority: z.string().min(1),
  dueAt: z.string().optional(),
  questions: z.string().optional(),
});

const engCompleteBody = z.object({
  decision: z.enum(['FEASIBLE', 'FEASIBLE_WITH_CONDITIONS', 'NOT_FEASIBLE', 'NEED_DATA']),
  conditions: z.string().optional(),
  technicalExecution: z.string().optional(),
  priceInputs: z.record(z.unknown()).optional(),
  leadTimeDays: z.number().int().nonnegative().optional(),
  fileIds: z.array(z.string()).optional(),
});

const createTaskBody = z.object({
  type: z.string().min(1, 'Выберите тип задачи'),
  subject: z.string().min(1, 'Укажите тему задачи'),
  description: z.string().optional(),
  assigneeId: z.string().min(1, 'Выберите исполнителя'),
  dueAt: z.string().min(4, 'Укажите срок исполнения'),
  priority: z.string().optional(),
  contactId: z.string().nullish(),
  reminderAt: z.string().nullish(),
});

const updateTaskBody = z.object({
  lockVersion: z.number().int().min(1, 'Передайте текущую версию задачи'),
  subject: z.string().optional(),
  description: z.string().nullish(),
  assigneeId: z.string().optional(),
  dueAt: z.string().optional(),
  priority: z.string().optional(),
  reminderAt: z.string().nullish(),
});

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

const termsBody = z.object({
  lockVersion: z.number().int().min(1, 'Передайте текущую версию условий'),
  contractNumber: z.string().nullish(),
  contractDate: z.string().nullish(),
  specificationRef: z.string().nullish(),
  basisQuoteId: z.string().nullish(),
  paymentTerms: z.string().nullish(),
  paymentSchedule: z
    .array(z.object({ stage: z.string().min(1), pct: z.number().min(0).max(100), dueDays: z.number().int().nonnegative().nullish() }))
    .optional(),
  deliveryTerms: z.string().nullish(),
  criticalTermsChanged: z.boolean().optional(),
  comment: z.string().optional(),
});

const closeBody = z.object({
  lockVersion: z.number().int().min(1, 'Передайте текущую версию заявки'),
  comment: z.string().optional(),
});

const closingDocBody = z.object({
  docType: z.string().min(1, 'Укажите тип документа'),
  docNumber: z.string().max(120).optional(),
  extId: z.string().max(120).nullish(),
  extSystem: z.string().max(30).nullish(),
  status: z.enum(['PENDING', 'REGISTERED', 'SIGNED', 'CANCELLED']).optional(),
  fileId: z.string().nullish(),
  source: z.enum(['ONE_C', 'CRM']).optional(),
});

const mailCreateBody = z.object({
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

const validateImportBody = z.object({
  fileName: z.string().min(1),
  source: z.enum(['EXCEL', 'CSV']).default('EXCEL'),
  checksum: z.string().optional(),
  mapping: z.object({
    groupId: z.string().min(1),
    organizationName: z.string().min(1),
    lineName: z.string().min(1),
    quantity: z.string().min(1),
    externalNumber: z.string().optional(),
    inn: z.string().optional(),
    kpp: z.string().optional(),
    contactName: z.string().optional(),
    contactPhone: z.string().optional(),
    contactEmail: z.string().optional(),
    lineId: z.string().optional(),
    unit: z.string().optional(),
    price: z.string().optional(),
  }),
  rows: z
    .array(
      z.object({
        groupId: z.string().default(''),
        externalNumber: z.string().optional(),
        organizationName: z.string().default(''),
        inn: z.string().optional(),
        kpp: z.string().optional(),
        contactName: z.string().optional(),
        contactPhone: z.string().optional(),
        contactEmail: z.string().optional(),
        lineId: z.string().optional(),
        lineName: z.string().default(''),
        quantity: z.coerce.number().default(0),
        unit: z.string().optional(),
        price: z.coerce.number().optional(),
        rowNo: z.number().int().min(1),
      }),
    )
    .min(1, 'Файл не содержит строк для импорта'),
});

const referenceBody = z.object({
  kind: z.string().min(1),
  code: z.string().min(1),
  label: z.string().min(1),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const slaRuleBody = z.object({
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

const calendarBody = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  timezone: z.string().min(1),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1),
  workStart: z.string().regex(/^\d{2}:\d{2}$/, 'Формат ЧЧ:ММ'),
  workEnd: z.string().regex(/^\d{2}:\d{2}$/, 'Формат ЧЧ:ММ'),
  holidays: z.array(z.string()).default([]),
  isDefault: z.boolean().default(false),
});

const approvalBody = z.object({ reason: z.string().min(10, 'Опишите основание ручного разрешения (не менее 10 символов)') });
const revokeBody = z.object({ reason: z.string().min(5, 'Укажите причину отзыва разрешения') });

export async function crmContractRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };
  const c = '/api/v1/crm';

  // Рабочий стол и воронка
  app.get(`${c}/dashboard`, auth, async (req) => {
    const { principal } = ctx(req);
    return getDashboard(req.query as Record<string, unknown>, principal);
  });
  app.get(`${c}/pipeline`, auth, async (req) => {
    const { principal } = ctx(req);
    return getPipeline(req.query as Record<string, unknown>, principal);
  });

  // Задачи и активности
  app.get(`${c}/applications/:number/tasks`, auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appNumber.parse(req.params);
    return listTasks(parseTaskListQuery({ ...(req.query as Record<string, unknown>), applicationNumber: number }), principal);
  });
  app.post(`${c}/applications/:number/tasks`, auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appNumber.parse(req.params);
    const body = createTaskBody.parse(req.body);
    const task = await createTask({ applicationNumber: number, ...body, correlationId, actor: principal });
    return reply.status(201).send(task);
  });
  app.put(`${c}/tasks/:taskId`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = idParam('taskId').parse(req.params);
    const body = updateTaskBody.parse(req.body);
    return updateTask({ id: taskId, ...body, correlationId, actor: principal });
  });
  app.post(`${c}/tasks/:taskId/complete`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = idParam('taskId').parse(req.params);
    const body = z.object({ result: z.string().optional() }).parse(req.body ?? {});
    return completeTask({ id: taskId, result: body.result, correlationId, actor: principal });
  });
  app.post(`${c}/tasks/:taskId/cancel`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = idParam('taskId').parse(req.params);
    const body = z.object({ reason: z.string().min(1, 'Укажите причину отмены') }).parse(req.body);
    return cancelTask({ id: taskId, reason: body.reason, correlationId, actor: principal });
  });
  app.get(`${c}/applications/:number/activities`, auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appNumber.parse(req.params);
    return listActivities(number, req.query as Record<string, unknown>, principal);
  });
  app.post(`${c}/applications/:number/activities`, auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appNumber.parse(req.params);
    const body = activityBody.parse(req.body);
    const activity = await registerActivity({ applicationNumber: number, ...body, correlationId, actor: principal });
    return reply.status(201).send(activity);
  });
  app.put(`${c}/activities/:activityId`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { activityId } = idParam('activityId').parse(req.params);
    const body = z.object({ content: z.string().min(1), result: z.string().nullish() }).parse(req.body);
    return correctActivity({ id: activityId, ...body, correlationId, actor: principal });
  });

  // Коммерческие условия и выпуск
  app.put(`${c}/applications/:number/commercial`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appNumber.parse(req.params);
    const body = termsBody.parse(req.body);
    return updateCommercial({ number, ...body, correlationId, actor: principal });
  });
  app.get('/api/v1/applications/:number/production-release-check', auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appNumber.parse(req.params);
    return checkRelease(number, principal);
  });
  app.post(`${c}/applications/:number/release-approval`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appNumber.parse(req.params);
    const body = approvalBody.parse(req.body);
    return approveRelease({ number, reason: body.reason, correlationId, actor: principal });
  });
  app.delete(`${c}/applications/:number/release-approval`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appNumber.parse(req.params);
    const body = revokeBody.parse(req.body ?? {});
    return revokeRelease({ number, reason: body.reason, correlationId, actor: principal });
  });

  // Исполнение и закрытие
  app.get(`${c}/applications/:number/fulfillment`, auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appNumber.parse(req.params);
    return getFulfilment(number, principal);
  });
  app.get(`${c}/applications/:number/close-check`, auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appNumber.parse(req.params);
    return checkCloseReadiness(number, principal);
  });
  app.post(`${c}/applications/:number/close`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appNumber.parse(req.params);
    const body = closeBody.parse(req.body);
    return closeApplication(number, { lockVersion: body.lockVersion, comment: body.comment, correlationId, actor: principal });
  });
  app.get(`${c}/applications/:number/closing-documents`, auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appNumber.parse(req.params);
    return listClosingDocuments(number, principal);
  });
  app.post(`${c}/applications/:number/closing-documents`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appNumber.parse(req.params);
    const body = closingDocBody.parse(req.body);
    return registerClosingDocument({ ...body, number, correlationId, actor: principal });
  });

  // Справочник организаций и контактов
  app.get(`${c}/organizations`, auth, async (req) => {
    const { principal } = ctx(req);
    return searchOrganizations(req.query as Record<string, unknown>, principal);
  });
  app.get(`${c}/contacts`, auth, async (req) => {
    const { principal } = ctx(req);
    return searchContacts(req.query as Record<string, unknown>, principal);
  });

  // Почтовый приём
  app.get(`${c}/mail/inbox`, auth, async (req) => {
    const { principal } = ctx(req);
    return listInbox(req.query as Record<string, unknown>, principal);
  });
  app.post(`${c}/mail/:mailId/create-application`, auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const { mailId } = idParam('mailId').parse(req.params);
    const body = mailCreateBody.parse(req.body);
    const result = await createApplicationFromMail({ id: mailId, ...body, correlationId, actor: principal });
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });
  app.post(`${c}/mail/:mailId/link`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { mailId } = idParam('mailId').parse(req.params);
    const body = z.object({ applicationNumber: z.string().min(1) }).parse(req.body);
    return linkMailToApplication({ id: mailId, applicationNumber: body.applicationNumber, correlationId, actor: principal });
  });
  app.post(`${c}/mail/:mailId/ignore`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { mailId } = idParam('mailId').parse(req.params);
    const body = z.object({ reason: z.string().min(1, 'Укажите причину') }).parse(req.body);
    return ignoreMail({ id: mailId, reason: body.reason, correlationId, actor: principal });
  });

  // Импорт
  app.post(`${c}/imports/validate`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const body = validateImportBody.parse(req.body);
    return createBatch({
      source: body.source as ImportSource,
      fileName: body.fileName,
      checksum: body.checksum ?? `${body.fileName}:${body.rows.length}`,
      mapping: body.mapping,
      rows: body.rows,
      correlationId,
      actor: principal,
    });
  });
  app.post(`${c}/imports/:batchId/commit`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { batchId } = idParam('batchId').parse(req.params);
    const body = z.object({ onlyGroupIds: z.array(z.string()).optional() }).parse(req.body ?? {});
    return confirmBatch({ id: batchId, onlyGroupIds: body.onlyGroupIds, correlationId, actor: principal });
  });
  app.get(`${c}/imports/:batchId`, auth, async (req) => {
    const { principal } = ctx(req);
    const { batchId } = idParam('batchId').parse(req.params);
    return getBatch(batchId, principal);
  });

  // Файловые маршруты импорта живут в /imports: multipart-тело одинаково для
  // обоих префиксов, канонический маршрут и его алиас регистрируются рядом.
  app.post(`${c}/imports/inspect`, { preHandler: requireAuth() }, importInspect);
  app.post(`${c}/imports/upload`, { preHandler: requireAuth() }, importUpload);

  // Администрирование
  app.get(`${c}/admin/sla-rules`, auth, async () => listSlaRules());
  app.put(`${c}/admin/sla-rules`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const body = slaRuleBody.parse(req.body);
    return upsertSlaRule(body, principal, correlationId);
  });
  app.get(`${c}/admin/calendars`, auth, async (req) => {
    const { principal } = ctx(req);
    return listCalendars(principal);
  });
  app.put(`${c}/admin/calendars`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const body = calendarBody.parse(req.body);
    return upsertCalendar({ ...body, correlationId, actor: principal });
  });
  app.get(`${c}/admin/integrations`, auth, async (req) => {
    const { principal } = ctx(req);
    // состояние интеграций доступно администратору; для остальных — пустой ответ
    return principal.role === 'ADMIN' ? getIntegrationStatus() : [];
  });
  app.get(`${c}/admin/audit-events`, auth, async (req) => {
    const { principal } = ctx(req);
    return listAuditEvents(req.query as Record<string, unknown>, principal);
  });
  app.put(`${c}/admin/references`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const body = referenceBody.parse(req.body);
    return upsertReference({ ...body, correlationId, actor: principal });
  });

  // Уведомления
  app.get(`${c}/notifications`, auth, async (req) => {
    const { principal } = ctx(req);
    return listNotifications(req.query as Record<string, unknown>, principal);
  });
  app.post(`${c}/notifications/:notificationId/read`, auth, async (req) => {
    const { principal } = ctx(req);
    const { notificationId } = idParam('notificationId').parse(req.params);
    return markNotificationRead({ id: notificationId, read: true, p: principal });
  });
  app.post(`${c}/notifications/read-all`, auth, async (req) => {
    const { principal } = ctx(req);
    return markAllNotificationsRead(principal);
  });

  // Справочники по требованиям контракта
  app.get(`${c}/reference/loss-reasons`, auth, async (req) => {
    const { principal } = ctx(req);
    const items = await listReferences({ kind: 'LOSS_REASON' }, principal);
    return { items: items.length ? items : LOSS_REASONS.map((code) => ({ kind: 'LOSS_REASON', code })) };
  });
  app.get(`${c}/reference/activity-types`, auth, async (req) => {
    const { principal } = ctx(req);
    const items = await listReferences({ kind: 'ACTIVITY_TYPE' }, principal);
    return { items: items.length ? items : ACTIVITY_TYPES.map((code) => ({ kind: 'ACTIVITY_TYPE', code })) };
  });

  // Фильтры воронки из контракта доступны и без префикса /crm
  app.get('/api/v1/analytics/pipeline', auth, async (req) => {
    const { principal } = ctx(req);
    return getPipeline(req.query as Record<string, unknown>, principal);
  });

  // ── Таймлайн (§13.3)
  app.get(`${c}/applications/:number/timeline`, auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appNumber.parse(req.params);
    return getTimeline(number, principal);
  });

  // ── КП: контрактные алиасы, те же сервисы и те же проверки прав
  app.get(`${c}/applications/:number/quotes`, auth, async (req) => {
    const { principal } = ctx(req);
    const { number } = appNumber.parse(req.params);
    return listQuotes(number, principal);
  });
  app.post(`${c}/applications/:number/quotes`, auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appNumber.parse(req.params);
    const body = quoteCreateBody.parse(req.body);
    const quote = await createQuote({ number, ...body, actor: principal, correlationId });
    return reply.status(201).send(quote);
  });
  app.get(`${c}/quotes/:quoteId`, auth, async (req) => {
    const { principal } = ctx(req);
    const { quoteId } = idParam('quoteId').parse(req.params);
    return getQuote(quoteId, principal);
  });
  app.post(`${c}/quotes/:quoteId/generate`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = idParam('quoteId').parse(req.params);
    return generateQuoteDocument(quoteId, correlationId, principal);
  });
  app.post(`${c}/quotes/:quoteId/submit-approval`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = idParam('quoteId').parse(req.params);
    return submitForApproval(quoteId, correlationId, principal);
  });
  app.post(`${c}/quotes/:quoteId/approval-decision`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = idParam('quoteId').parse(req.params);
    const body = quoteDecisionBody.parse(req.body);
    return decideApproval(quoteId, body.decision, body.comment, correlationId, principal);
  });
  app.post(`${c}/quotes/:quoteId/send`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = idParam('quoteId').parse(req.params);
    const body = quoteSendBody.parse(req.body);
    const key = requireIdempotencyKey(req.headers['idempotency-key'] as string | undefined, 'отправка КП');
    return sendQuote({ id: quoteId, ...body, idempotencyKey: key, actor: principal, correlationId });
  });
  app.post(`${c}/quotes/:quoteId/customer-decision`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { quoteId } = idParam('quoteId').parse(req.params);
    const body = quoteCustomerDecisionBody.parse(req.body);
    return registerCustomerDecision({ id: quoteId, ...body, actor: principal, correlationId });
  });
  app.get(`${c}/applications/:number/commercial-basis-check`, auth, async (req) => {
    const { number } = appNumber.parse(req.params);
    return checkCommercialBasisChange(number);
  });

  // ── Инженерные задания: контрактные алиасы
  app.get(`${c}/engineering/tasks`, auth, async (req) => {
    const { principal } = ctx(req);
    return listEngineeringTasks(req.query as Record<string, unknown>, principal);
  });
  app.get(`${c}/engineering/tasks/:taskId`, auth, async (req) => {
    const { principal } = ctx(req);
    const { taskId } = idParam('taskId').parse(req.params);
    return getEngineeringTask(taskId, principal);
  });
  app.post(`${c}/applications/:number/engineering-tasks`, auth, async (req, reply) => {
    const { principal, correlationId } = ctx(req);
    const { number } = appNumber.parse(req.params);
    const body = engCreateBody.parse(req.body);
    const task = await createEngineeringTask({ number, ...body, actor: principal, correlationId });
    return reply.status(201).send(task);
  });
  app.post(`${c}/engineering/tasks/:taskId/assign`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = idParam('taskId').parse(req.params);
    const body = z.object({ assigneeId: z.string().min(1) }).parse(req.body);
    return assignEngineeringTask(taskId, body.assigneeId, correlationId, principal);
  });
  app.post(`${c}/engineering/tasks/:taskId/status`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = idParam('taskId').parse(req.params);
    const body = z
      .object({
        status: z.enum(['NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_INPUT', 'CANCELLED']),
        lockVersion: z.number().int().min(1),
      })
      .parse(req.body);
    return updateEngineeringTaskStatus(taskId, body.status, body.lockVersion, correlationId, principal);
  });
  app.post(`${c}/engineering/tasks/:taskId/complete`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = idParam('taskId').parse(req.params);
    const body = engCompleteBody.parse(req.body);
    return completeEngineeringTask({ id: taskId, ...body, actor: principal, correlationId });
  });
  app.post(`${c}/engineering/tasks/:taskId/cancel`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { taskId } = idParam('taskId').parse(req.params);
    const body = z.object({ reason: z.string().min(1, 'Укажите причину отмены') }).parse(req.body);
    return cancelEngineeringTask(taskId, body.reason, correlationId, principal);
  });
  app.post(`${c}/engineering/conclusions/:conclusionId/approve`, auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { conclusionId } = idParam('conclusionId').parse(req.params);
    const body = z.object({ approve: z.boolean(), comment: z.string().optional() }).parse(req.body);
    return approveEngineeringConclusion(conclusionId, body.approve, body.comment, correlationId, principal);
  });
}
