import { prisma } from '../lib/prisma.js';
import { notFound } from '../errors.js';
import { P, assertPermission, permissionsFor } from '../domain/rbac.js';
import { applyScope, assertCanReadApplicationInScope, type Principal } from '../domain/scope.js';
import { normalizeEmail, normalizeInn, normalizeName, normalizePhone } from './applications.js';
import { parsePage } from '../lib/query.js';
import { jparse } from '../lib/query.js';

/**
 * Поиск контрагентов и контактов (§5.4) и внутренние уведомления (§10.3).
 *
 * Сопоставление организаций выполняется по нормализованным реквизитам (ИНН/КПП)
 * и внешнему идентификатору; контакты — по нормализованным телефону и email в
 * границах организации. Однофамильцы и похожие названия автоматически не
 * объединяются.
 */

export interface OrgSearchResult {
  id: string;
  name: string;
  fullName: string | null;
  inn: string | null;
  kpp: string | null;
  isArchived: boolean;
  contacts: { id: string; fullName: string; phone: string | null; email: string | null; isPrimary: boolean }[];
  applications: { number: string; stage: string }[];
}

export async function searchOrganizations(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.ORG_READ);
  const page = parsePage(query);
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  const scope = applyScope({}, p);

  const where: Record<string, unknown> = {};
  if (query.includeArchived !== 'true') where.isArchived = false;
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const digits = search.replace(/\D/g, '');
    where.OR = [
      { name: { contains: search } },
      { fullName: { contains: search } },
      ...(digits.length >= 10 ? [{ inn: { contains: digits } }, { kpp: { contains: digits } }] : []),
    ];
  }
  if (query.inn) where.inn = normalizeInn(String(query.inn));
  if (query.kpp) where.kpp = normalizeInn(String(query.kpp));
  if (query.extId) where.extId = String(query.extId);

  const rows = await prisma.organization.findMany({
    where,
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    skip: page.offset,
    take: page.size,
    include: {
      contacts: {
        where: { isArchived: false },
        orderBy: [{ isPrimary: 'desc' }, { fullName: 'asc' }],
        select: { id: true, fullName: true, phone: true, email: true, isPrimary: true },
      },
      applications: {
        where: scope,
        orderBy: [{ updatedAt: 'desc' }],
        take: 10,
        select: { number: true, stage: true, ownerId: true },
      },
    },
  });

  const items: OrgSearchResult[] = rows
    .map((o) => ({
      id: o.id,
      name: o.name,
      fullName: o.fullName,
      inn: o.inn,
      kpp: o.kpp,
      isArchived: o.isArchived,
      contacts: o.contacts,
      // A01: заявки уже отобраны по области видимости в выборке (where: scope),
      // поэтому повторная проверка «владелец ли я» только скрывала бы заявки
      // производства и КО, которым чтение по области разрешено
      applications: o.applications.map((a) => ({ number: a.number, stage: a.stage })),
    }))
    .filter((o) => canReadAny || o.applications.length > 0 || o.contacts.length > 0);

  const total = await prisma.organization.count({ where });
  return { items, total, page: page.page, size: page.size };
}

export async function searchContacts(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.CONTACT_READ);
  const page = parsePage(query);
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  const scope = applyScope({}, p);

  const where: Record<string, unknown> = { isArchived: false };
  if (query.organizationId) where.organizationId = String(query.organizationId);
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const digits = search.replace(/\D/g, '');
    const email = search.includes('@') ? normalizeEmail(search) : null;
    where.OR = [
      { fullName: { contains: search } },
      ...(digits.length >= 5 ? [{ phoneNormalized: digits }, { phone: { contains: search } }] : []),
      ...(email ? [{ emailNormalized: email }] : []),
    ];
  }

  const rows = await prisma.contact.findMany({
    where,
    orderBy: [{ isPrimary: 'desc' }, { fullName: 'asc' }, { id: 'asc' }],
    skip: page.offset,
    take: page.size,
    include: {
      organization: { select: { id: true, name: true, inn: true, kpp: true } },
      applications: { where: scope, orderBy: { updatedAt: 'desc' }, take: 10, select: { number: true, stage: true, ownerId: true } },
    },
  });

  const items = rows
    .map((c) => ({
      id: c.id,
      fullName: c.fullName,
      position: c.position,
      phone: c.phone,
      email: c.email,
      preferredChannel: c.preferredChannel,
      isPrimary: c.isPrimary,
      organization: c.organization,
      // Область видимости применена в выборке (where: scope), см. searchOrganizations
      applications: c.applications.map((a) => ({ number: a.number, stage: a.stage })),
    }))
    .filter((c) => canReadAny || c.applications.length > 0);

  const total = await prisma.contact.count({ where });
  return { items, total, page: page.page, size: page.size };
}

/**
 * Подсказка о возможном дубле: совпадение по ИНН/КПП или по совокупности
 * телефона и email. Подозрение на дубль не блокирует повторное обращение
 * (APP-03): решение принимает пользователь.
 */
export async function findPossibleDuplicates(
  input: { inn?: string | null; kpp?: string | null; name?: string | null; phone?: string | null; email?: string | null },
  p: Principal,
) {
  assertPermission(p.role as never, P.ORG_READ);
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  const byKey: Record<string, unknown>[] = [];
  if (input.inn) {
    byKey.push({ OR: [{ inn: normalizeInn(input.inn) }, ...(input.kpp ? [{ kpp: normalizeInn(input.kpp) }] : [])] });
  } else if (input.name) {
    byKey.push({ normalizedKey: normalizeName(input.name) });
  }
  if (!byKey.length) return { duplicates: [] as { number: string; stage: string; reason: string }[] };

  const orgs = await prisma.organization.findMany({
    where: { OR: byKey as never[], isArchived: false },
    include: { contacts: { select: { phoneNormalized: true, emailNormalized: true } } },
  });

  const phone = input.phone ? normalizePhone(input.phone) : null;
  const email = input.email ? normalizeEmail(input.email) : null;
  const duplicates: { number: string; stage: string; reason: string }[] = [];
  for (const org of orgs) {
    const apps = await prisma.application.findMany({
      where: { organizationId: org.id },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { id: true, number: true, stage: true, ownerId: true, contact: { select: { phoneNormalized: true, emailNormalized: true } } },
    });
    for (const a of apps) {
      let visible = canReadAny;
      if (!visible) {
        try {
          await assertCanReadApplicationInScope({ id: a.id, number: a.number }, p, canReadAny);
          visible = true;
        } catch {
          visible = false;
        }
      }
      if (!visible) continue;
      const sameContact =
        (phone && (a.contact?.phoneNormalized === phone || org.contacts.some((c) => c.phoneNormalized === phone))) ||
        (email && (a.contact?.emailNormalized === email || org.contacts.some((c) => c.emailNormalized === email)));
      duplicates.push({
        number: a.number,
        stage: a.stage,
        reason: sameContact ? 'совпадает контакт' : 'совпадают реквизиты организации',
      });
    }
  }
  return { duplicates };
}

// ─────────────────────────── Уведомления (§10.3)

export async function listNotifications(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.NOTIFICATION_READ);
  const page = parsePage(query);
  const where: Record<string, unknown> = { userId: p.id };
  if (query.unread === 'true') where.isRead = false;
  const [total, unread, items] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: p.id, isRead: false } }),
    prisma.notification.findMany({
      where,
      orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: page.offset,
      take: page.size,
    }),
  ]);
  return { items, total, unread, page: page.page, size: page.size };
}

/** Уведомления не заменяют задачи: изменение состояния чтения не влияет на сроки. */
export async function markNotificationRead(input: { id: string; read: boolean; p: Principal }) {
  assertPermission(input.p.role as never, P.NOTIFICATION_READ);
  // A01: чужое уведомление не раскрывается — знание идентификатора не даёт
  // доступа к содержимому.
  const current = await prisma.notification.findFirst({ where: { id: input.id, userId: input.p.id } });
  if (!current) throw notFound('Уведомление');
  return prisma.notification.update({
    where: { id: current.id },
    data: { isRead: input.read, readAt: input.read ? new Date() : null },
  });
}

export async function markAllNotificationsRead(p: Principal) {
  const result = await prisma.notification.updateMany({
    where: { userId: p.id, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return { updated: result.count };
}

// ─────────────────────────── Состояние интеграций

export interface IntegrationStatus {
  system: string;
  links: { total: number; byState: Record<string, number> };
  lastSyncedAt: string | null;
  lastEventAt: string | null;
  pendingOutbox: number;
  failedOutbox: number;
  inboxPending: number;
  lastError: { entityType: string; entityId: string; errorText: string; createdAt: string } | null;
}

export async function getIntegrationStatus(): Promise<IntegrationStatus[]> {
  const [links, outboxStates, inboxStates, lastError, lastLink] = await Promise.all([
    prisma.integrationLink.groupBy({ by: ['system', 'state'], _count: { _all: true } }),
    prisma.outboxMessage.groupBy({ by: ['state'], _count: { _all: true } }),
    prisma.inboxMessage.groupBy({ by: ['state'], _count: { _all: true } }),
    prisma.inboxMessage.findFirst({
      where: { state: 'ERROR' },
      orderBy: { receivedAt: 'desc' },
      select: { objectType: true, extId: true, result: true, receivedAt: true },
    }),
    prisma.integrationLink.findFirst({ orderBy: { updatedAt: 'desc' }, select: { lastSyncedAt: true, lastEventAt: true } }),
  ]);
  const outboxCount = (state: string) => outboxStates.find((o) => o.state === state)?._count._all ?? 0;
  const inboxCount = (state: string) => inboxStates.find((i) => i.state === state)?._count._all ?? 0;
  const systems = [...new Set(links.map((l) => l.system))];
  return systems.map((system) => {
    const forSystem = links.filter((l) => l.system === system);
    const byState: Record<string, number> = {};
    for (const l of forSystem) byState[l.state] = (byState[l.state] ?? 0) + l._count._all;
    return {
      system,
      links: { total: forSystem.reduce((s, l) => s + l._count._all, 0), byState },
      lastSyncedAt: lastLink?.lastSyncedAt?.toISOString() ?? null,
      lastEventAt: lastLink?.lastEventAt?.toISOString() ?? null,
      pendingOutbox: outboxCount('PENDING'),
      failedOutbox: outboxCount('FAILED') + outboxCount('ERROR_QUEUE'),
      inboxPending: inboxCount('PROCESSED') === 0 ? inboxStates.reduce((s, i) => s + i._count._all, 0) : 0,
      lastError: lastError
        ? {
            entityType: lastError.objectType,
            entityId: lastError.extId,
            errorText: lastError.result ?? 'ошибка обработки сообщения интеграции',
            createdAt: lastError.receivedAt.toISOString(),
          }
        : null,
    };
  });
}
