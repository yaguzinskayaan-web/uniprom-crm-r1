import { prisma } from '../lib/prisma.js';
import { ErrorCode, badRequest, notFound } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { P, assertPermission, permissionsFor } from '../domain/rbac.js';
import { assertCanReadApplicationInScope, type Principal } from '../domain/scope.js';
import { csv, parsePage, q } from '../lib/query.js';
import { createApplication } from './applications.js';
import { registerActivity } from './tasks.js';

/**
 * Входящая почта (§5.2, MAIL-IN-01..04).
 *
 * Создание заявки по письму выполняется только после подтверждения сотрудника;
 * цепочка определяется по Message-ID/In-Reply-To/References. Совпадение email
 * или номера в теме — подсказка, а не основание для раскрытия чужой заявки.
 * Повторная загрузка того же письма не создаёт новую активность или заявку.
 */

export interface Attachment {
  name: string;
  size: number;
  contentType: string;
  objectKey?: string;
}

export interface IncomingMail {
  mailbox: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  from: string;
  to: string;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  receivedAt: string;
  attachments?: Attachment[];
}

/** MAIL-IN-04: очистка HTML от активного содержимого. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

export async function receiveMail(mail: IncomingMail, correlationId: string): Promise<{ id: string; duplicate: boolean }> {
  const existing = await prisma.mailMessage.findUnique({ where: { messageId: mail.messageId } });
  if (existing) return { id: existing.id, duplicate: true };

  // MAIL-IN-03: подсказки по цепочке и номеру заявки в теме
  const hints = new Set<string>();
  for (const ref of [mail.inReplyTo, ...(mail.references ?? '').split(/\s+/)].filter(Boolean) as string[]) {
    const linked = await prisma.mailMessage.findUnique({ where: { messageId: ref }, select: { threadKey: true, applicationId: true } });
    if (linked?.applicationId) hints.add(linked.applicationId);
  }
  const numberInSubject = mail.subject?.match(/UPC-\d{4}-\d{5}/i)?.[0];
  if (numberInSubject) {
    const byNumber = await prisma.application.findUnique({ where: { number: numberInSubject.toUpperCase() }, select: { id: true } });
    if (byNumber) hints.add(byNumber.id);
  }
  const byContact = await prisma.contact.findFirst({
    where: { emailNormalized: mail.from.trim().toLowerCase(), isArchived: false },
    select: { applications: { select: { id: true }, take: 5 } },
  });
  for (const a of byContact?.applications ?? []) hints.add(a.id);

  const row = await prisma.mailMessage.create({
    data: {
      mailbox: mail.mailbox,
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo ?? null,
      references: mail.references ?? null,
      threadKey: mail.inReplyTo ?? mail.messageId,
      from: mail.from,
      to: mail.to,
      subject: mail.subject ?? null,
      bodyText: mail.bodyText ?? null,
      bodyHtml: mail.bodyHtml ? sanitizeHtml(mail.bodyHtml) : null,
      receivedAt: new Date(mail.receivedAt),
      direction: 'IN',
      queueState: 'SENT',
      parseState: 'PENDING',
      attachments: JSON.stringify(mail.attachments ?? []),
      linkedApplications: JSON.stringify([...hints]),
    },
  });

  await audit(prisma, {
    serviceAccount: 'MAIL_CONNECTOR',
    actionCode: AuditAction.MAIL_RECEIVED,
    entityType: 'MailMessage',
    entityId: row.id,
    applicationId: [...hints][0] ?? null,
    payload: { from: mail.from, subject: mail.subject ?? null, candidateApplications: [...hints] },
    correlationId,
  });

  return { id: row.id, duplicate: false };
}

export async function listInbox(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.MAIL_INBOX_READ);
  const page = parsePage(query);
  const where: Record<string, unknown> = { direction: 'IN' };
  const states = csv(query, 'parseState');
  if (states.length) where.parseState = { in: states };
  const mailbox = q(query, 'mailbox');
  if (mailbox) where.mailbox = mailbox;
  const search = q(query, 'search');
  if (search) {
    where.OR = [{ subject: { contains: search } }, { from: { contains: search } }, { bodyText: { contains: search } }];
  }

  const [total, rows] = await Promise.all([
    prisma.mailMessage.count({ where }),
    prisma.mailMessage.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      skip: page.offset,
      take: page.size,
      select: {
        id: true,
        mailbox: true,
        messageId: true,
        from: true,
        to: true,
        subject: true,
        bodyText: true,
        receivedAt: true,
        parseState: true,
        applicationId: true,
        attachments: true,
        linkedApplications: true,
      },
    }),
  ]);

  return { items: rows.map((r) => ({ ...r, attachments: safeJson(r.attachments, [] as Attachment[]), linkedApplications: safeJson(r.linkedApplications, [] as string[]) })), total, page: page.page, size: page.size };
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function loadMail(id: string, p: Principal) {
  assertPermission(p.role as never, P.MAIL_INBOX_PROCESS);
  const row = await prisma.mailMessage.findUnique({ where: { id } });
  if (!row) throw notFound('Письмо');
  return row;
}

/** MAIL-IN-01/02: создание заявки по письму только после подтверждения сотрудника. */
export async function createApplicationFromMail(input: {
  id: string;
  organizationName: string;
  inn?: string;
  kpp?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  lines: { name: string; quantity: number; unit?: string; price?: number; lineId?: string }[];
  comment?: string;
  idempotencyKey?: string;
  correlationId: string;
  actor: Principal;
}) {
  const mail = await loadMail(input.id, input.actor);
  if (mail.applicationId) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Письмо уже связано с заявкой');

  const { deduplicated, application } = await createApplication({
    organizationName: input.organizationName,
    inn: input.inn,
    kpp: input.kpp,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    contactEmail: input.contactEmail ?? mail.from,
    source: 'EMAIL',
    sourceRef: mail.messageId,
    priority: 'NORMAL',
    crmComment: input.comment ?? mail.subject ?? undefined,
    lines: input.lines.map((l) => ({ lineId: l.lineId, name: l.name, quantity: l.quantity, unit: l.unit, price: l.price })),
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    actor: input.actor,
  });

  if (!deduplicated) {
    await prisma.mailMessage.update({
      where: { id: mail.id },
      data: { applicationId: application.id, parseState: 'CREATED' },
    });
    await registerActivity({
      applicationNumber: application.number,
      type: 'EMAIL',
      direction: 'IN',
      participants: [mail.from],
      occurredAt: mail.receivedAt.toISOString(),
      subject: mail.subject ?? undefined,
      content: mail.bodyText ?? undefined,
      correlationId: input.correlationId,
      actor: input.actor,
    });
    await audit(prisma, {
      actor: input.actor,
      actionCode: AuditAction.MAIL_INBOX_CREATE_APP,
      entityType: 'MailMessage',
      entityId: mail.id,
      applicationId: application.id,
      after: { number: application.number },
      correlationId: input.correlationId,
    });
  }

  return { application, deduplicated };
}

export async function linkMailToApplication(input: {
  id: string;
  applicationNumber: string;
  correlationId: string;
  actor: Principal;
}) {
  const mail = await loadMail(input.id, input.actor);
  const canReadAny = permissionsFor(input.actor.role as never).includes(P.APPLICATION_READ_ANY);
  const app = await prisma.application.findUnique({ where: { number: input.applicationNumber }, select: { id: true, number: true, ownerId: true } });
  if (!app) throw notFound('Заявка');
  // A01: чужая заявка не раскрывается по подсказке из письма
  await assertCanReadApplicationInScope(app, input.actor, canReadAny);

  return prisma.$transaction(async (tx) => {
    const row = await tx.mailMessage.update({
      where: { id: mail.id },
      data: { applicationId: app.id, parseState: 'LINKED' },
    });
    await tx.crmActivity.create({
      data: {
        applicationId: app.id,
        type: 'EMAIL',
        direction: 'IN',
        participants: JSON.stringify([mail.from]),
        occurredAt: mail.receivedAt,
        authorId: input.actor.id,
        subject: mail.subject ?? undefined,
        content: mail.bodyText ?? undefined,
        isCustomerFacing: true,
      },
    });
    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.MAIL_INBOX_LINK,
      entityType: 'MailMessage',
      entityId: mail.id,
      applicationId: app.id,
      after: { number: app.number },
      correlationId: input.correlationId,
    });
    return row;
  });
}

export async function ignoreMail(input: { id: string; reason: string; correlationId: string; actor: Principal }) {
  const mail = await loadMail(input.id, input.actor);
  if (!input.reason?.trim()) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Укажите причину, по которой письмо не относится к заявкам', {
      fields: [{ field: 'reason', message: 'Обязательное поле' }],
    });
  }
  return prisma.$transaction(async (tx) => {
    const row = await tx.mailMessage.update({
      where: { id: mail.id },
      data: { parseState: 'IGNORED', errorText: input.reason.trim() },
    });
    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.MAIL_INBOX_IGNORE,
      entityType: 'MailMessage',
      entityId: mail.id,
      payload: { reason: input.reason.trim() },
      correlationId: input.correlationId,
    });
    return row;
  });
}
