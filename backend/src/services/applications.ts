import type { Prisma } from '@prisma/client';
import { prisma, type TxClient } from '../lib/prisma.js';
import { AppError, ErrorCode, badRequest, forbidden, notFound, conflict } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { notify, NotifyCode, notifyMany } from '../lib/notifications.js';
import { enqueueOutbox } from '../lib/integration.js';
import { applicationComplexity, COMPLEXITY_LEVELS, LOSS_REASON_REQUIRED_FROM, LOSS_REASONS, PIPELINE_STAGES, STAGES, STAGE_TRANSITIONS, type Complexity, type Stage } from '../domain/constants.js';
import { P, assertPermission, permissionsFor } from '../domain/rbac.js';
import { applyScope, assertCanReadApplicationInScope, type Principal } from '../domain/scope.js';
import { csv, dateParam, jparse, numParam, orderBy, parsePage, parseSort, q, type PageQuery } from '../lib/query.js';
import { refreshSlaForStage } from './sla.js';
import { recomputeLineFulfilment } from './fulfillment.js';

const APP_SORT_FIELDS = [
  'number',
  'stage',
  'createdAt',
  'updatedAt',
  'amount',
  'priority',
  'complexity',
  'nextActivityAt',
  'lastActivityAt',
  'expectedDecisionDate',
] as const;

// ─────────────────────────── Списки

export interface ListApplicationsParams {
  page: PageQuery;
  sort: ReturnType<typeof parseSort<(typeof APP_SORT_FIELDS)[number]>>;
  search?: string;
  stage: string[];
  ownerId: string[];
  organizationId: string[];
  source: string[];
  complexity: string[];
  priority: string[];
  isClosed?: boolean;
  onlyOverdue?: boolean;
  onlyUnassigned?: boolean;
  createdFrom?: Date;
  createdTo?: Date;
  activityStaleDays?: number;
  amountMin?: number;
  amountMax?: number;
  currency?: string;
  lossReasons: string[];
  ids?: string[];
}

function buildWhere(params: ListApplicationsParams, p: Principal): Prisma.ApplicationWhereInput {
  const where: Prisma.ApplicationWhereInput = {};
  const and: Prisma.ApplicationWhereInput[] = [];

  if (params.search) {
    // UI-04: поиск по номеру, названию, ИНН, ФИО, телефону и email без учёта регистра
    // SQLite Prisma: insensitive mode недоступен → приводим к нижнему регистру сами.
    const s = params.search.toLowerCase();
    and.push({
      OR: [
        { number: { contains: params.search } },
        { organization: { name: { contains: params.search } } },
        { organization: { fullName: { contains: params.search } } },
        { organization: { inn: { contains: params.search } } },
        { contact: { fullName: { contains: params.search } } },
        { contact: { phone: { contains: params.search } } },
        { contact: { email: { contains: params.search } } },
        { externalNumber: { contains: params.search } },
      ],
    });
    void s;
  }

  if (params.stage.length) where.stage = { in: params.stage as Stage[] };
  if (params.ownerId.length) where.ownerId = { in: params.ownerId };
  if (params.organizationId.length) where.organizationId = { in: params.organizationId };
  if (params.source.length) where.source = { in: params.source as never[] };
  if (params.complexity.length) where.complexity = { in: params.complexity as never[] };
  if (params.priority.length) where.priority = { in: params.priority as never[] };
  if (params.lossReasons.length) where.lossReason = { in: params.lossReasons };
  if (params.ids?.length) where.id = { in: params.ids };
  if (params.isClosed !== undefined) where.isClosed = params.isClosed;
  if (params.onlyUnassigned) where.ownerId = null;
  if (params.onlyOverdue) {
    and.push({
      OR: [
        { tasks: { some: { status: 'OPEN', dueAt: { lt: new Date() } } } },
        { slaInstances: { some: { status: 'ACTIVE', dueAt: { lt: new Date() } } } },
      ],
    });
  }
  if (params.activityStaleDays) {
    const threshold = new Date(Date.now() - params.activityStaleDays * 86400_000);
    and.push({
      OR: [{ lastCustomerContactAt: null }, { lastCustomerContactAt: { lt: threshold } }],
    });
  }
  if (params.createdFrom || params.createdTo) {
    where.createdAt = {
      ...(params.createdFrom ? { gte: params.createdFrom } : {}),
      ...(params.createdTo ? { lte: params.createdTo } : {}),
    };
  }
  if (params.amountMin !== undefined || params.amountMax !== undefined) {
    where.amount = {
      ...(params.amountMin !== undefined ? { gte: params.amountMin } : {}),
      ...(params.amountMax !== undefined ? { lte: params.amountMax } : {}),
    };
  }
  if (params.currency) where.currency = params.currency;
  // По умолчанию активные записи; архив и отмена — только по явному фильтру
  if (!params.stage.length && params.isClosed === undefined) {
    and.push({ NOT: { stage: 'ARCHIVED' } });
  }
  if (and.length) where.AND = and;
  return where;
}

export async function listApplications(params: ListApplicationsParams, p: Principal) {
  const where = applyScope(buildWhere(params, p), p);
  const [total, rows] = await Promise.all([
    prisma.application.count({ where }),
    prisma.application.findMany({
      where,
      orderBy: orderBy(params.sort) as Prisma.ApplicationOrderByWithRelationInput[],
      skip: params.page.offset,
      take: params.page.size,
      select: {
        id: true,
        number: true,
        stage: true,
        legacyStatus: true,
        organization: { select: { id: true, name: true, inn: true } },
        contact: { select: { id: true, fullName: true, phone: true, email: true } },
        owner: { select: { id: true, fullName: true, login: true } },
        source: true,
        priority: true,
        complexity: true,
        amount: true,
        currency: true,
        successProbability: true,
        expectedDecisionDate: true,
        lastActivityAt: true,
        lastCustomerContactAt: true,
        nextActivityAt: true,
        isClosed: true,
        lossReason: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { tasks: { where: { status: 'OPEN' } }, lines: true, quotes: true } },
      },
    }),
  ]);

  // Признак просрочки считается по той же области доступа, что и список
  const overdueFlags = await Promise.all(
    rows.map(async (r) => {
      const overdue = await prisma.crmTask.count({
        where: { applicationId: r.id, status: 'OPEN', dueAt: { lt: new Date() } },
      });
      const slaBreach = await prisma.slaInstance.count({
        where: { applicationId: r.id, status: 'ACTIVE', dueAt: { lt: new Date() } },
      });
      return overdue + slaBreach > 0;
    }),
  );

  return {
    items: rows.map((r, i) => ({ ...r, isOverdue: overdueFlags[i] })),
    total,
    page: params.page.page,
    size: params.page.size,
  };
}

export function parseListQuery(query: Record<string, unknown>): ListApplicationsParams {
  return {
    page: parsePage(query),
    sort: parseSort(query, APP_SORT_FIELDS, 'updatedAt'),
    search: q(query, 'search'),
    stage: csv(query, 'stage'),
    ownerId: csv(query, 'ownerId'),
    organizationId: csv(query, 'organizationId'),
    source: csv(query, 'source'),
    complexity: csv(query, 'complexity'),
    priority: csv(query, 'priority'),
    lossReasons: csv(query, 'lossReason'),
    ids: csv(query, 'ids'),
    isClosed: query.isClosed === undefined || query.isClosed === '' ? undefined : query.isClosed === 'true' || query.isClosed === true,
    onlyOverdue: query.overdue === 'true',
    onlyUnassigned: query.unassigned === 'true',
    createdFrom: dateParam(query, 'createdFrom'),
    createdTo: dateParam(query, 'createdTo'),
    activityStaleDays: numParam(query, 'staleDays'),
    amountMin: numParam(query, 'amountMin'),
    amountMax: numParam(query, 'amountMax'),
    currency: q(query, 'currency'),
  };
}

// ─────────────────────────── Карточка

export async function getApplicationByNumber(number: string, p: Principal) {
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  const app = await prisma.application.findUnique({
    where: { number },
    include: {
      organization: { include: { contacts: { where: { isArchived: false }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } } },
      contact: true,
      owner: { select: { id: true, fullName: true, login: true, role: true } },
      lines: { orderBy: { lineId: 'asc' } },
      tasks: {
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
        include: { assignee: { select: { id: true, fullName: true } } },
      },
      activities: {
        orderBy: { occurredAt: 'desc' },
        take: 200,
        include: { author: { select: { id: true, fullName: true } } },
      },
      quotes: {
        orderBy: { versionNo: 'desc' },
        include: {
          author: { select: { id: true, fullName: true } },
          approvals: {
            include: {
              requestedBy: { select: { id: true, fullName: true, role: true } },
              decidedBy: { select: { id: true, fullName: true, role: true } },
            },
            orderBy: { requestedAt: 'desc' },
          },
          dispatches: { orderBy: { createdAt: 'desc' }, include: { initiatedBy: { select: { id: true, fullName: true } } } },
          lines: true,
        },
      },
      engTasks: {
        orderBy: { createdAt: 'desc' },
        include: {
          assignee: { select: { id: true, fullName: true, role: true } },
          conclusions: {
            orderBy: { createdAt: 'desc' },
            include: {
              author: { select: { id: true, fullName: true } },
              approvedBy: { select: { id: true, fullName: true, role: true } },
            },
          },
        },
      },
      commercial: {
        include: {
          invoices: { orderBy: { docDate: 'desc' } },
          releaseApproval: true,
        },
      },
      shipments: { orderBy: { docDate: 'desc' }, include: { lines: true } },
      closingDocs: true,
      fileLinks: { include: { file: true }, orderBy: { createdAt: 'desc' } },
      assignmentHistory: {
        orderBy: { createdAt: 'desc' },
        include: { fromUser: { select: { id: true, fullName: true } }, toUser: { select: { id: true, fullName: true } } },
      },
      releases: { orderBy: { releasedAt: 'desc' } },
      slaInstances: { include: { pauses: true }, orderBy: { dueAt: 'asc' } },
    },
  });
  if (!app) throw notFound('Заявка');
  await assertCanReadApplicationInScope(app, p, canReadAny);
  // `tags` в SQLite хранится JSON-строкой (`String @default("[]")`), наружу
  // отдаётся массивом: клиент строит по нему список и `.map`.
  return { ...app, tags: jparse<string[]>(app.tags, []) };
}

export async function getApplicationById(id: string, p: Principal) {
  const row = await prisma.application.findUnique({ where: { id }, select: { number: true } });
  if (!row) throw notFound('Заявка');
  return getApplicationByNumber(row.number, p);
}

// ─────────────────────────── Создание

export interface CreateApplicationInput {
  organizationId?: string;
  organizationName?: string;
  inn?: string;
  kpp?: string;
  contactId?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  source: string;
  sourceRef?: string;
  priority: string;
  externalNumber?: string;
  expectedDecisionDate?: string;
  successProbability?: number;
  tags?: string[];
  crmComment?: string;
  engineQuestions?: Record<string, unknown>;
  lines?: {
    lineId?: string;
    name: string;
    quantity: number;
    unit?: string;
    catalogRef?: string;
    price?: number;
    complexity?: Complexity;
    params?: Record<string, unknown>;
    calculationRevision?: string;
  }[];
  ownerId?: string | null; // SALES_MANAGER может назначить сразу
  leaveInQueue?: boolean;
  idempotencyKey?: string;
  isDraft?: boolean;
  correlationId: string;
  actor: Principal;
  /** Канал публичного модуля подбора — ограниченный контракт (IN-01). */
  publicSelector?: boolean;
}

/** Уникальный номер заявки. APP-01: неизменяемый. */
async function nextNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `UPC-${year}-`;
  const last = await tx.application.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(5, '0')}`;
}

export async function createApplication(input: CreateApplicationInput) {
  const { actor, correlationId, publicSelector } = input;

  if (publicSelector) {
    // IN-01: публичный клиент не задаёт роль, ответственного, коммерческое
    // согласование или разрешение выпуска.
    if (input.ownerId) throw forbidden('Публичный модуль подбора не может задавать ответственного');
  } else {
    assertPermission(actor.role as never, P.APPLICATION_CREATE);
  }

  if (input.successProbability !== undefined && (input.successProbability < 0 || input.successProbability > 100)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Вероятность успешного завершения должна быть от 0 до 100 процентов', {
      fields: [{ field: 'successProbability', message: 'Допустимо 0–100' }],
    });
  }

  // IN-03: повторная отправка одной формы с тем же ключом не создаёт вторую заявку
  if (input.idempotencyKey) {
    const existing = await prisma.application.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      return { application: existing, deduplicated: true };
    }
  }

  const complexity = applicationComplexity((input.lines ?? []).map((l) => l.complexity ?? null));

  // IN-02: заявка SALES назначается создателю; остальные каналы — в очередь руководителя
  const ownerId = publicSelector
    ? null
    : input.leaveInQueue || !input.ownerId
      ? actor.role === 'SALES'
        ? actor.id
        : null
      : input.ownerId;

  if (ownerId && ownerId !== actor.id) {
    await assertAssignableToSales(ownerId);
  }

  const app = await prisma.$transaction(async (tx) => {
    const organizationId = await resolveOrganization(tx, input);
    const contactId = await resolveContact(tx, organizationId, input);
    const number = await nextNumber(tx);

    const created = await tx.application.create({
      data: {
        number,
        stage: 'NEW',
        organizationId,
        contactId,
        ownerId,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        priority: input.priority,
        complexity,
        successProbability: input.successProbability ?? null,
        expectedDecisionDate: input.expectedDecisionDate ? new Date(input.expectedDecisionDate) : null,
        tags: JSON.stringify(input.tags ?? []),
        crmComment: input.crmComment ?? null,
        engineQuestions: input.engineQuestions ? JSON.stringify(input.engineQuestions) : null,
        externalNumber: input.externalNumber ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        isDraft: input.isDraft ?? false,
        lastActivityAt: new Date(),
        createdAt: new Date(),
        lockVersion: 1,
        lines: {
          create: (input.lines ?? []).map((l, i) => ({
            lineId: l.lineId ?? `L${String(i + 1).padStart(2, '0')}`,
            name: l.name,
            quantity: l.quantity,
            unit: l.unit ?? 'шт.',
            catalogRef: l.catalogRef ?? null,
            price: l.price ?? null,
            complexity: l.complexity ?? null,
            params: JSON.stringify(l.params ?? {}),
            calculationRevision: l.calculationRevision ?? null,
            orderQty: l.quantity,
            lockVersion: 1,
          })),
        },
      },
      include: { lines: true, organization: true, owner: true },
    });

    await audit(tx, {
      actor,
      actionCode: AuditAction.APPLICATION_CREATE,
      entityType: 'Application',
      entityId: created.id,
      applicationId: created.id,
      after: { number, source: input.source, ownerId, complexity, lines: created.lines.length },
      correlationId,
    });

    // Первое событие бизнес-хронологии: заявка заведена (не клиентское касание)
    await tx.crmActivity.create({
      data: {
        applicationId: created.id,
        type: 'SYSTEM',
        direction: 'IN',
        participants: JSON.stringify([input.contactEmail ?? input.contactName ?? actor.fullName]),
        occurredAt: new Date(),
        authorId: actor.id,
        subject: 'Заявка создана',
        content: `Источник: ${input.source}`,
        isCustomerFacing: false,
      },
    });

    if (ownerId) {
      await notify(tx, {
        userId: ownerId,
        code: NotifyCode.APPLICATION_ASSIGNED,
        title: `Заявка ${number} назначена вам`,
        body: created.organization.name,
        entityType: 'Application',
        entityId: created.id,
        dedupKey: `app-assigned:${created.id}:${ownerId}`,
      });
    }
    if (!publicSelector) {
      await enqueueOutbox(tx, {
        objectType: 'APPLICATION',
        extId: created.id,
        applicationId: created.id,
        eventType: 'APPLICATION_CREATED',
        payload: { number, source: input.source },
        correlationId,
      });
    }
    await refreshSlaForStage(tx, created.id, 'NEW', complexity);
    return created;
  });

  return { application: app, deduplicated: false };
}

// ─────────────────────────── Нормализация справочников (RBAC-02, §5.4)

export function normalizeInn(inn: string): string {
  return inn.replace(/\D/g, '');
}

export function normalizeName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(ООО|ОАО|ЗАО|ИП|ПАО|АО)\s*/g, '')
    .trim();
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  if (digits.length === 10) return `7${digits}`;
  return digits;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

type Tx = Prisma.TransactionClient;

async function resolveOrganization(tx: Tx, input: CreateApplicationInput): Promise<string> {
  if (input.organizationId) {
    const org = await tx.organization.findUnique({ where: { id: input.organizationId } });
    if (!org) throw notFound('Организация');
    return org.id;
  }
  if (!input.organizationName) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Укажите организацию', {
      fields: [{ field: 'organizationName', message: 'Обязательное поле' }],
    });
  }
  const inn = input.inn ? normalizeInn(input.inn) : null;
  const key = inn ? `INN:${inn}${input.kpp ? `:${normalizeInn(input.kpp)}` : ''}` : `NAME:${normalizeName(input.organizationName)}`;
  const existing = await tx.organization.findUnique({ where: { normalizedKey: key } });
  if (existing) return existing.id;
  const org = await tx.organization.create({
    data: {
      name: input.organizationName,
      inn,
      kpp: input.kpp ? normalizeInn(input.kpp) : null,
      normalizedKey: key,
      lockVersion: 1,
    },
  });
  return org.id;
}

async function resolveContact(tx: Tx, organizationId: string, input: CreateApplicationInput): Promise<string | null> {
  if (input.contactId) {
    const c = await tx.contact.findUnique({ where: { id: input.contactId } });
    if (!c) throw notFound('Контакт');
    return c.id;
  }
  if (!input.contactName && !input.contactPhone && !input.contactEmail) return null;
  const phoneNorm = input.contactPhone ? normalizePhone(input.contactPhone) : null;
  const emailNorm = input.contactEmail ? normalizeEmail(input.contactEmail) : null;
  if (phoneNorm) {
    const byPhone = await tx.contact.findFirst({ where: { organizationId, phoneNormalized: phoneNorm } });
    if (byPhone) return byPhone.id;
  }
  if (emailNorm) {
    const byEmail = await tx.contact.findFirst({ where: { organizationId, emailNormalized: emailNorm } });
    if (byEmail) return byEmail.id;
  }
  const created = await tx.contact.create({
    data: {
      organizationId,
      fullName: input.contactName ?? input.contactEmail ?? 'Не указан',
      phone: input.contactPhone ?? null,
      phoneNormalized: phoneNorm,
      email: input.contactEmail ?? null,
      emailNormalized: emailNorm,
      isPrimary: true,
      lockVersion: 1,
    },
  });
  return created.id;
}

/** RBAC-03: назначать можно только активного пользователя подходящей роли. */
export async function assertAssignableToSales(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true, blockedAt: true } });
  if (!u) throw notFound('Пользователь');
  if (!u.isActive || u.blockedAt) {
    throw badRequest(ErrorCode.ASSIGNEE_INACTIVE, 'Назначить заявку можно только активному пользователю', {
      fields: [{ field: 'ownerId', message: 'Пользователь не активен' }],
    });
  }
  if (u.role !== 'SALES' && u.role !== 'SALES_MANAGER') {
    throw badRequest(ErrorCode.ASSIGNEE_ROLE_MISMATCH, 'Заявку можно назначить только сотруднику продаж (SALES)', {
      fields: [{ field: 'ownerId', message: 'Недостаточная роль' }],
    });
  }
  return true;
}

/** §3.1: SALES_MANAGER не назначает конструкторов. */
export async function assertAssignableDesigner(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true, blockedAt: true } });
  if (!u) throw notFound('Пользователь');
  if (!u.isActive || u.blockedAt) {
    throw badRequest(ErrorCode.ASSIGNEE_INACTIVE, 'Назначить задание можно только активному пользователю');
  }
  if (u.role !== 'DESIGNER') {
    throw badRequest(ErrorCode.ASSIGNEE_ROLE_MISMATCH, 'Инженерное задание можно назначить только конструктору (DESIGNER)');
  }
  return true;
}

// ─────────────────────────── Обновление

export interface UpdateApplicationInput {
  number: string;
  lockVersion: number;
  contactId?: string | null;
  ownerId?: string | null;
  priority?: string;
  successProbability?: number | null;
  expectedDecisionDate?: string | null;
  tags?: string[];
  crmComment?: string | null;
  engineQuestions?: Record<string, unknown>;
  isDraft?: boolean;
  lines?: {
    lineId: string;
    name?: string;
    quantity?: number;
    unit?: string;
    price?: number | null;
    complexity?: Complexity | null;
    params?: Record<string, unknown>;
    calculationRevision?: string;
  }[];
  correlationId: string;
  actor: Principal;
}

export async function updateApplication(input: UpdateApplicationInput) {
  const { actor, correlationId } = input;
  const current = await prisma.application.findUnique({
    where: { number: input.number },
    include: { lines: true, organization: true },
  });
  if (!current) throw notFound('Заявка');

  const canAny = permissionsFor(actor.role as never).includes(P.APPLICATION_UPDATE_ANY);
  if (!canAny && current.ownerId !== actor.id) {
    // Не раскрываем существование чужой заявки
    throw notFound('Заявка');
  }
  assertPermission(actor.role as never, P.APPLICATION_UPDATE);

  if (current.lockVersion !== input.lockVersion) {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Заявка изменена другим пользователем. Обновите карточку и повторите.', {
      details: { currentVersion: current.lockVersion, yourVersion: input.lockVersion },
    });
  }

  if (input.ownerId !== undefined && input.ownerId !== current.ownerId) {
    if (!canAny) throw forbidden('Переназначение заявки доступно руководителю продаж');
    if (input.ownerId) await assertAssignableToSales(input.ownerId);
  }

  // Смена технических параметров увеличивает ревизию — заключение КО перестаёт
  // действовать для новой ревизии (ENG-05, A12)
  let engineRevision = current.versionNo;
  const paramsChanged =
    input.engineQuestions !== undefined ||
    input.lines?.some((l) => {
      const cur = current.lines.find((x) => x.lineId === l.lineId);
      return (
        l.params !== undefined ||
        l.quantity !== undefined ||
        (cur && JSON.stringify(jparse(cur.params, {})) !== JSON.stringify(l.params ?? {}))
      );
    });
  if (paramsChanged) engineRevision = current.versionNo + 1;

  const result = await prisma.$transaction(async (tx) => {
    if (input.lines) {
      for (const l of input.lines) {
        const existing = current.lines.find((x) => x.lineId === l.lineId);
        if (!existing) continue;
        await tx.applicationLine.update({
          where: { id: existing.id },
          data: {
            ...(l.name !== undefined ? { name: l.name } : {}),
            ...(l.quantity !== undefined ? { quantity: l.quantity, orderQty: l.quantity } : {}),
            ...(l.unit !== undefined ? { unit: l.unit } : {}),
            ...(l.price !== undefined ? { price: l.price } : {}),
            ...(l.complexity !== undefined ? { complexity: l.complexity } : {}),
            ...(l.params !== undefined ? { params: JSON.stringify(l.params) } : {}),
            ...(l.calculationRevision !== undefined ? { calculationRevision: l.calculationRevision } : {}),
            lockVersion: { increment: 1 },
          },
        });
      }
    }

    const nextComplexity = applicationComplexity(
      (input.lines ?? current.lines).map((l) => (l as { complexity?: Complexity | null }).complexity ?? null),
    );
    const complexityFromLines = input.lines !== undefined && input.lines.some((l) => l.complexity !== undefined);
    if (complexityFromLines && nextComplexity !== current.complexity) {
      // Уровень заявки следует за позициями, но требует подтверждения (ENG-01)
      await tx.application.update({
        where: { id: current.id },
        data: { complexity: nextComplexity, complexityConfirmedById: null, complexityConfirmedAt: null },
      });
    }

    const updated = await tx.application.update({
      where: { id: current.id },
      data: {
        ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.successProbability !== undefined ? { successProbability: input.successProbability } : {}),
        ...(input.expectedDecisionDate !== undefined
          ? { expectedDecisionDate: input.expectedDecisionDate ? new Date(input.expectedDecisionDate) : null }
          : {}),
        ...(input.tags !== undefined ? { tags: JSON.stringify(input.tags) } : {}),
        ...(input.crmComment !== undefined ? { crmComment: input.crmComment } : {}),
        ...(input.engineQuestions !== undefined ? { engineQuestions: JSON.stringify(input.engineQuestions) } : {}),
        ...(input.isDraft !== undefined ? { isDraft: input.isDraft } : {}),
        versionNo: engineRevision,
        lockVersion: { increment: 1 },
      },
    });

    if (paramsChanged) {
      // Действующее заключение КО сохраняется, но помечается как требующее перепроверки
      const conclusions = await tx.engineeringConclusion.findMany({
        where: { applicationId: current.id, isValid: true, decision: { in: ['FEASIBLE', 'FEASIBLE_WITH_CONDITIONS'] } },
      });
      for (const c of conclusions) {
        await tx.engineeringConclusion.update({
          where: { id: c.id },
          data: { isValid: false, invalidatedReason: 'TECH_REVISION_CHANGED' },
        });
      }
      if (conclusions.length) {
        await audit(tx, {
          actor,
          actionCode: AuditAction.ENG_CONCLUSION_INVALIDATE,
          entityType: 'EngineeringConclusion',
          entityId: current.id,
          applicationId: current.id,
          payload: { reason: 'TECH_REVISION_CHANGED', newRevision: engineRevision, count: conclusions.length },
          correlationId,
        });
      }
    }

    await audit(tx, {
      actor,
      actionCode: AuditAction.APPLICATION_UPDATE,
      entityType: 'Application',
      entityId: current.id,
      applicationId: current.id,
      before: { lockVersion: current.lockVersion, complexity: current.complexity, ownerId: current.ownerId },
      after: { lockVersion: current.lockVersion + 1, ownerId: updated.ownerId, complexity: updated.complexity },
      correlationId,
    });

    if (input.ownerId && input.ownerId !== current.ownerId && input.ownerId !== actor.id) {
      await notify(tx, {
        userId: input.ownerId,
        code: NotifyCode.APPLICATION_REASSIGNED,
        title: `Заявка ${current.number} передана вам`,
        body: current.organization.name,
        entityType: 'Application',
        entityId: current.id,
        dedupKey: `app-reassigned:${current.id}:${input.ownerId}:${updated.lockVersion}`,
      });
    }

    if (paramsChanged) await refreshSlaForStage(tx, current.id, current.stage as Stage, current.complexity);
    return updated;
  });

  return result;
}

// ─────────────────────────── Смена этапа (§7)

export interface ChangeStageInput {
  number: string;
  to: Stage;
  lossReason?: string;
  lossComment?: string;
  comment?: string;
  correlationId: string;
  actor: Principal;
}

export async function changeStage(input: ChangeStageInput) {
  const { actor, correlationId, to } = input;
  assertPermission(actor.role as never, P.APPLICATION_CHANGE_STAGE);

  const current = await prisma.application.findUnique({ where: { number: input.number }, include: { lines: true } });
  if (!current) throw notFound('Заявка');

  const canAny = permissionsFor(actor.role as never).includes(P.APPLICATION_UPDATE_ANY);
  if (!canAny && current.ownerId !== actor.id && actor.role !== 'SALES_MANAGER') {
    throw notFound('Заявка');
  }

  if (!(STAGES as readonly string[]).includes(to)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, `Неизвестный этап «${to}»`);
  }

  // GATE-04: TO_PRODUCTION только через серверный выпуск
  if (to === 'TO_PRODUCTION') {
    throw badRequest(
      ErrorCode.RELEASE_NOT_ALLOWED_FOR_STAGE,
      'Этап «Передано в производство» устанавливается только серверным выпуском с проверкой условий оплаты и договора. Прямой переход запрещён (ТЗ GATE-04).',
    );
  }
  // CLOSE-03: закрытие только отдельным действием с проверкой условий
  if (to === 'CLOSED') {
    throw badRequest(
      ErrorCode.APPLICATION_NOT_IN_FULFILLMENT,
      'Закрытие выполняется отдельным действием «Закрыть заявку» с проверкой отгрузок, расчётов и закрывающих документов (ТЗ CLOSE-01).',
    );
  }

  if (to === 'CANCELLED') {
    if (LOSS_REASON_REQUIRED_FROM.includes(current.stage as Stage)) {
      if (!input.lossReason) {
        throw badRequest(
          ErrorCode.STAGE_TRANSITION_REQUIRES_LOSS_REASON,
          'Отмена после начала коммерческой работы требует указания причины потери.',
          { fields: [{ field: 'lossReason', message: 'Обязательное поле' }] },
        );
      }
      if (!(LOSS_REASONS as readonly string[]).includes(input.lossReason)) {
        throw badRequest(ErrorCode.VALIDATION_ERROR, 'Неизвестная причина потери', {
          fields: [{ field: 'lossReason', message: 'Выберите значение из справочника' }],
        });
      }
      if (input.lossReason === 'OTHER' && !input.lossComment) {
        throw badRequest(
          ErrorCode.STAGE_TRANSITION_REQUIRES_COMMENT,
          'Для причины «Другое» пояснение обязательно.',
          { fields: [{ field: 'lossComment', message: 'Обязательное поле' }] },
        );
      }
    }
  }

  if (to === 'ARCHIVED') {
    assertPermission(actor.role as never, P.APPLICATION_ARCHIVE);
  }

  const allowed = STAGE_TRANSITIONS[current.stage as Stage] ?? [];
  if (!allowed.includes(to)) {
    throw badRequest(
      ErrorCode.INVALID_STAGE_TRANSITION,
      `Переход «${current.stage} → ${to}» не предусмотрен маршрутом. Допустимо: ${allowed.join(', ') || 'нет переходов'}.`,
      { details: { from: current.stage, to, allowed } },
    );
  }

  const nextActivity = await computeNextActivity(current.id);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.application.update({
      where: { id: current.id },
      data: {
        stage: to,
        ...(to === 'CANCELLED'
          ? {
              lossReason: input.lossReason ?? current.lossReason,
              lossComment: input.lossComment ?? null,
              isClosed: true,
              closedAt: new Date(),
              closedById: actor.id,
            }
          : {}),
        ...(to === 'ARCHIVED' ? { isClosed: true } : {}),
        nextActivityAt: nextActivity,
        lockVersion: { increment: 1 },
      },
    });

    await audit(tx, {
      actor,
      actionCode: to === 'CANCELLED' ? AuditAction.APPLICATION_CANCEL : AuditAction.APPLICATION_STAGE_CHANGE,
      entityType: 'Application',
      entityId: current.id,
      applicationId: current.id,
      before: { stage: current.stage },
      after: { stage: to, lossReason: input.lossReason ?? null, comment: input.comment ?? null },
      correlationId,
    });

    if (to === 'CANCELLED' && current.ownerId) {
      await notify(tx, {
        userId: current.ownerId,
        code: NotifyCode.APPLICATION_STAGE_CHANGED,
        title: `Заявка ${current.number} отменена`,
        body: input.lossReason ?? undefined,
        entityType: 'Application',
        entityId: current.id,
        dedupKey: `stage:${current.id}:${to}:${row.lockVersion}`,
      });
    }

    await refreshSlaForStage(tx, current.id, to, current.complexity);
    return row;
  });

  return updated;
}

/** §10.1: next_activity_at пересчитывается по ближайшей открытой задаче. */
/**
 * Ближайшая дата открытой задачи. Клиент передаётся явно, чтобы расчёт шёл
 * внутри той же транзакции, что и изменение задачи (иначе незакоммиченные
 * изменения не видны и поле остаётся пустым).
 */
export async function computeNextActivity(applicationId: string, client: TxClient = prisma): Promise<Date | null> {
  const next = await client.crmTask.findFirst({
    where: { applicationId, status: 'OPEN' },
    orderBy: { dueAt: 'asc' },
    select: { dueAt: true },
  });
  return next?.dueAt ?? null;
}

// ─────────────────────────── Назначение (RBAC-03)

export interface AssignApplicationInput {
  number: string;
  ownerId: string | null;
  moveOpenTasks: boolean;
  comment?: string;
  correlationId: string;
  actor: Principal;
}

export async function assignApplication(input: AssignApplicationInput) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.APPLICATION_ASSIGN);
  if (input.ownerId) await assertAssignableToSales(input.ownerId);

  const current = await prisma.application.findUnique({
    where: { number: input.number },
    include: { tasks: { where: { status: 'OPEN' } }, organization: true },
  });
  if (!current) throw notFound('Заявка');

  const result = await prisma.$transaction(async (tx) => {
    if (input.ownerId && input.moveOpenTasks) {
      // Открытые задачи не теряются: переносим исполнителю
      await tx.crmTask.updateMany({
        where: { applicationId: current.id, status: 'OPEN' },
        data: { assigneeId: input.ownerId, lockVersion: { increment: 1 } },
      });
    }

    await tx.assignmentHistory.create({
      data: {
        applicationId: current.id,
        fromUserId: current.ownerId,
        toUserId: input.ownerId,
        movedOpenTasks: input.moveOpenTasks,
        comment: input.comment ?? null,
        actorId: actor.id,
      },
    });

    const row = await tx.application.update({
      where: { id: current.id },
      data: { ownerId: input.ownerId, lockVersion: { increment: 1 } },
    });

    await audit(tx, {
      actor,
      actionCode: current.ownerId ? AuditAction.APPLICATION_REASSIGN : AuditAction.APPLICATION_ASSIGN,
      entityType: 'Application',
      entityId: current.id,
      applicationId: current.id,
      before: { ownerId: current.ownerId },
      after: { ownerId: input.ownerId, movedOpenTasks: input.moveOpenTasks },
      correlationId,
    });

    if (input.ownerId) {
      const leaders = await tx.user.findMany({ where: { role: 'SALES_MANAGER', isActive: true }, select: { id: true } });
      await notifyMany(tx, [input.ownerId, ...leaders.map((l) => l.id)], {
        code: current.ownerId ? NotifyCode.APPLICATION_REASSIGNED : NotifyCode.APPLICATION_ASSIGNED,
        title: current.ownerId
          ? `Заявка ${current.number} передана: ${actor.fullName}`
          : `Новая заявка ${current.number}`,
        body: current.organization.name,
        entityType: 'Application',
        entityId: current.id,
        dedupKey: `assign:${current.id}:${input.ownerId}:${row.lockVersion}`,
      });
    }
    return row;
  });

  return result;
}

// ─────────────────────────── Классификация сложности (ENG-01..03)

export interface SetComplexityInput {
  number: string;
  complexity: Complexity;
  comment?: string;
  correlationId: string;
  actor: Principal;
}

export async function setApplicationComplexity(input: SetComplexityInput) {
  const { actor, correlationId } = input;
  if (!(COMPLEXITY_LEVELS as readonly string[]).includes(input.complexity)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Неизвестный уровень сложности', {
      fields: [{ field: 'complexity', message: 'Выберите значение' }],
    });
  }
  assertPermission(actor.role as never, P.APPLICATION_SET_COMPLEXITY);

  const current = await prisma.application.findUnique({
    where: { number: input.number },
    include: { lines: true, engTasks: { include: { conclusions: { where: { isValid: true } } } } },
  });
  if (!current) throw notFound('Заявка');

  const rank: Record<string, number> = { NEEDS_CLASSIFICATION: -1, STANDARD: 0, MODIFIED: 1, CUSTOM: 2 };
  const isDowngrade = rank[input.complexity]! < rank[current.complexity]!;

  // ENG-03: понижение ранее подтверждённого CUSTOM либо снятие сработавшего
  // технического ограничения требует решения DESIGN_MANAGER с причиной
  const requiresManager =
    isDowngrade && (current.complexity === 'CUSTOM' || current.engineQuestions !== null || current.lines.some((l) => jparse<Record<string, unknown>>(l.params, {}).requiresKo === true));

  if (requiresManager) {
    const canDowngrade = permissionsFor(actor.role as never).includes(P.APPLICATION_SET_COMPLEXITY_DOWNGRADE);
    if (!canDowngrade) {
      throw forbidden(
        'Понижение ранее подтверждённой сложности требует решения руководителя конструкторского отдела с указанием причины (ТЗ ENG-03).',
      );
    }
    if (!input.comment) {
      throw badRequest(ErrorCode.COMPLEXITY_DOWNGRADE_REQUIRES_APPROVER, 'Требуется указать причину понижения сложности', {
        fields: [{ field: 'comment', message: 'Обязательное поле' }],
      });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    // При смене классификации повторно проверяется действительность заключения и согласования КП
    const invalidates = input.complexity === 'NEEDS_CLASSIFICATION' || rank[input.complexity]! < rank[current.complexity]!;
    if (invalidates) {
      for (const t of current.engTasks) {
        for (const c of t.conclusions) {
          if (c.decision === 'FEASIBLE' || c.decision === 'FEASIBLE_WITH_CONDITIONS') {
            await tx.engineeringConclusion.update({
              where: { id: c.id },
              data: { isValid: false, invalidatedReason: 'COMPLEXITY_CHANGED' },
            });
          }
        }
      }
      await tx.crmQuote.updateMany({
        where: { applicationId: current.id, approvalStatus: 'APPROVED', status: { in: ['DRAFT', 'READY'] } },
        data: { approvalStatus: 'INVALIDATED' },
      });
    }

    // Позиции без явно заданного уровня наследуют уровень заявки
    for (const l of current.lines) {
      await tx.applicationLine.update({ where: { id: l.id }, data: { complexity: input.complexity } });
    }

    const row = await tx.application.update({
      where: { id: current.id },
      data: {
        complexity: input.complexity,
        complexityConfirmedById: actor.id,
        complexityConfirmedAt: new Date(),
        // Ревизия инженерных данных меняется только при смене уровня:
        // подтверждение того же уровня не должно аннулировать заключение КО.
        ...(input.complexity !== current.complexity ? { versionNo: { increment: 1 } } : {}),
        lockVersion: { increment: 1 },
      },
    });

    await audit(tx, {
      actor,
      actionCode: AuditAction.APPLICATION_COMPLEXITY_CHANGE,
      entityType: 'Application',
      entityId: current.id,
      applicationId: current.id,
      before: { complexity: current.complexity },
      after: { complexity: input.complexity, comment: input.comment ?? null, requiresManager },
      correlationId,
    });
    return row;
  });

  return updated;
}

// ─────────────────────────── Таймлайн (§13.3 GET timeline)

export async function getTimeline(number: string, p: Principal) {
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  const app = await prisma.application.findUnique({
    where: { number },
    select: { id: true, number: true, ownerId: true, organization: { select: { name: true } } },
  });
  if (!app) throw notFound('Заявка');
  await assertCanReadApplicationInScope(app, p, canReadAny);

  const [activities, tasks, quotes, eng, shipments, stageEvents, documents] = await Promise.all([
    prisma.crmActivity.findMany({
      where: { applicationId: app.id },
      orderBy: { occurredAt: 'desc' },
      take: 100,
      include: { author: { select: { id: true, fullName: true, role: true } } },
    }),
    prisma.crmTask.findMany({
      where: { applicationId: app.id },
      orderBy: { createdAt: 'desc' },
      include: { assignee: { select: { id: true, fullName: true } } },
    }),
    prisma.crmQuote.findMany({
      where: { applicationId: app.id },
      select: { id: true, number: true, versionNo: true, status: true, approvalStatus: true, createdAt: true, amount: true, currency: true, sentAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.engineeringConclusion.findMany({
      where: { applicationId: app.id },
      select: {
        id: true,
        decision: true,
        isValid: true,
        createdAt: true,
        validForRevision: true,
        engineeringTask: { select: { kind: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.shipment.findMany({
      where: { applicationId: app.id },
      select: { id: true, number: true, docDate: true, status: true, isCancelled: true },
      orderBy: { docDate: 'desc' },
    }),
    prisma.auditEvent.findMany({
      where: { applicationId: app.id, actionCode: { in: ['APPLICATION_STAGE_CHANGE', 'APPLICATION_CANCEL', 'PRODUCTION_RELEASE', 'APPLICATION_CLOSE', 'APPLICATION_ARCHIVE', 'APPLICATION_ADMIN_STAGE_OVERRIDE'] } },
      select: { id: true, actionCode: true, createdAt: true, actorLogin: true, payload: true, userReason: true },
      orderBy: { createdAt: 'desc' },
      take: 60,
    }),
    prisma.crmQuoteDispatch.findMany({
      where: { quote: { applicationId: app.id } },
      select: { id: true, channel: true, sentAt: true, actualDateTime: true, isManual: true, recipients: true, queueState: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 40,
    }),
  ]);

  return {
    application: { number: app.number, organization: app.organization.name },
    activities,
    tasks,
    quotes,
    engineering: eng,
    shipments,
    stageEvents,
    dispatches: documents,
  };
}

export async function getAuditTrail(number: string, p: Principal) {
  assertPermission(p.role as never, P.APPLICATION_READ_AUDIT);
  const app = await prisma.application.findUnique({ where: { number }, select: { id: true } });
  if (!app) throw notFound('Заявка');
  const page = parsePage({});
  return prisma.auditEvent.findMany({
    where: { applicationId: app.id },
    orderBy: { createdAt: 'desc' },
    skip: page.offset,
    take: 200,
  });
}

/**
 * SEND-06: факт подтверждённой отправки КП переводит этап заявки по маршруту
 * §7.2. Прямая установка TO_PRODUCTION и CLOSED невозможна: оба перехода
 * выполняются только серверными операциями выпуска и закрытия (GATE-04, CLOSE-01).
 */
export async function refreshApplicationStageForQuote(
  applicationId: string,
  quoteStatus: string,
  correlationId: string,
): Promise<void> {
  const current = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, number: true, stage: true, complexity: true, ownerId: true },
  });
  if (!current) return;

  const isAccepted = quoteStatus === 'ACCEPTED';
  const isSent = quoteStatus === 'SENT' || quoteStatus === 'REJECTED' || isAccepted;
  if (!isSent) return;

  const desired: Stage[] = isAccepted
    ? (STAGE_TRANSITIONS[current.stage as Stage] ?? []).filter((s) => s === 'CONTRACT_PENDING')
    : (STAGE_TRANSITIONS[current.stage as Stage] ?? []).filter((s) => s === 'QUOTE_SENT');

  if (!desired.length) return;
  const to = desired[0]!;

  await prisma.$transaction(async (tx) => {
    const row = await tx.application.update({
      where: { id: applicationId },
      data: { stage: to, lastActivityAt: new Date(), lockVersion: { increment: 1 } },
    });
    await audit(tx, {
      serviceAccount: 'QUOTE_WORKER',
      actionCode: AuditAction.APPLICATION_STAGE_CHANGE,
      entityType: 'Application',
      entityId: applicationId,
      applicationId,
      before: { stage: current.stage },
      after: { stage: to, reason: `QUOTE_${quoteStatus}` },
      correlationId,
    });
    await refreshSlaForStage(tx, applicationId, to, current.complexity);
    void row;
  });
}

/** Обновление агрегата «сумма/валюта» по выбранной действующей принятой версии КП (§10.3). */
export async function refreshApplicationAmount(applicationId: string) {
  const basis = await prisma.crmQuote.findFirst({
    where: { applicationId, isActiveBasis: true },
    select: { amount: true, currency: true },
  });
  await prisma.application.update({
    where: { id: applicationId },
    data: { amount: basis?.amount ?? null, currency: basis?.currency ?? null },
  });
}

export { recomputeLineFulfilment };
