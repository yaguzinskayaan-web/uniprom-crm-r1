import { forbidden } from '../errors.js';
import { type Role, ROLES } from './constants.js';

/**
 * Серверные полномочия (ТЗ §3.1, §3.2). Скрытие кнопок во frontend
 * НЕ заменяет контроль доступа (RBAC-01) — здесь каждая проверка
 * обязана быть выполнена на сервере, включая поиск, агрегаты, скачивание
 * файлов и экспорт.
 *
 * Скоупы видимости (data scope) применяются дополнительно в `scope.ts`:
 *   ALL          — все данные
 *   OWN_APPS     — только назначенные заявки (SALES)
 *   ASSIGNED_ENG — назначенные инженерные задания (DESIGNER)
 *   KO_QUEUE     — направленные в КО (DESIGN_MANAGER)
 *   PRODUCED     — выпущенные в производство (PRODUCTION)
 *   NONE         — только чтение справочников (VIEWER)
 */
export const SCOPE = {
  ALL: 'ALL',
  OWN_APPS: 'OWN_APPS',
  ASSIGNED_ENG: 'ASSIGNED_ENG',
  KO_QUEUE: 'KO_QUEUE',
  PRODUCED: 'PRODUCED',
  NONE: 'NONE',
} as const;
export type Scope = (typeof SCOPE)[keyof typeof SCOPE];

export const P = {
  // справочники / чтение
  REFERENCE_READ: 'reference:read',

  // заявки
  APPLICATION_LIST: 'application:list',
  APPLICATION_READ_ANY: 'application:read:any',
  APPLICATION_CREATE: 'application:create',
  APPLICATION_UPDATE: 'application:update',
  APPLICATION_UPDATE_ANY: 'application:update:any',
  APPLICATION_ASSIGN: 'application:assign',
  APPLICATION_SET_COMPLEXITY: 'application:complexity:set',
  APPLICATION_SET_COMPLEXITY_DOWNGRADE: 'application:complexity:downgrade',
  APPLICATION_CHANGE_STAGE: 'application:stage:change',
  APPLICATION_CANCEL_WITH_LOSS_REASON: 'application:cancel:loss',
  APPLICATION_ARCHIVE: 'application:archive',
  APPLICATION_DELETE: 'application:delete',
  APPLICATION_READ_TIMELINE: 'application:timeline:read',
  APPLICATION_READ_AUDIT: 'application:audit:read',

  // организации / контакты
  ORG_READ: 'org:read',
  ORG_WRITE: 'org:write',
  CONTACT_READ: 'contact:read',

  // задачи и активности
  TASK_READ_ANY: 'task:read:any',
  TASK_CREATE: 'task:create',
  TASK_UPDATE_ANY: 'task:update:any',
  TASK_COMPLETE_OTHER: 'task:complete:other',
  // §10.1: корректировать зарегистрированную коммуникацию может её автор,
  // специальная операция администратора требует отдельного полномочия
  ACTIVITY_CORRECT_ANY: 'activity:correct:any',

  // КП
  QUOTE_READ: 'quote:read',
  QUOTE_CREATE: 'quote:create',
  QUOTE_UPDATE_DRAFT: 'quote:update:draft',
  QUOTE_UPLOAD: 'quote:upload',
  QUOTE_SUBMIT_APPROVAL: 'quote:submit-approval',
  // RBAC-04: только пользователь с полномочием SALES_MANAGER; ADMIN без скрытого обхода
  QUOTE_APPROVE: 'quote:approve',
  QUOTE_SEND: 'quote:send',
  QUOTE_RECORD_EXTERNAL_SEND: 'quote:record-external-send',
  QUOTE_ACCEPT: 'quote:accept',
  QUOTE_SUPERSEDE: 'quote:supersede',

  // конструкторский отдел
  ENG_READ_QUEUE: 'eng:queue:read',
  ENG_CREATE_TASK: 'eng:task:create',
  // §3.1: назначение DESIGNER выполняют DESIGN_MANAGER или ADMIN
  ENG_ASSIGN_DESIGNER: 'eng:assign',
  ENG_WORK: 'eng:work',
  ENG_APPROVE_CONCLUSION: 'eng:conclusion:approve',
  ENG_CANCEL: 'eng:cancel',

  // коммерческие условия
  COMMERCIAL_READ: 'commercial:read',
  COMMERCIAL_WRITE: 'commercial:write',
  CONTRACT_SIGN: 'contract:sign',

  // выпуск в производство
  RELEASE_CHECK: 'release:check',
  RELEASE_EXECUTE: 'release:execute',
  // GATE-02: ручное разрешение выпуска даёт SALES_MANAGER/ADMIN
  RELEASE_MANUAL_APPROVE: 'release:approve:manual',
  // GATE-04: административная восстановительная операция — отдельное полномочие
  RELEASE_ADMIN_OVERRIDE: 'release:override',

  // исполнение / расчёты / отгрузки / закрытие
  FULFILLMENT_READ: 'fulfillment:read',
  FULFILLMENT_WRITE: 'fulfillment:write',
  PRODUCTION_UPDATE_STAGES: 'production:stages:update',
  CLOSE_CHECK: 'close:check',
  CLOSE_EXECUTE: 'close:execute',

  // почта
  MAIL_INBOX_READ: 'mail:inbox:read',
  MAIL_INBOX_PROCESS: 'mail:inbox:process',

  // импорт
  IMPORT_RUN: 'import:run',
  IMPORT_COMMIT: 'import:commit',

  // SLA / уведомления / аналитика
  SLA_READ: 'sla:read',
  SLA_WRITE: 'sla:write',
  NOTIFICATION_READ: 'notification:read',
  ANALYTICS_READ: 'analytics:read',
  ANALYTICS_EXPORT: 'analytics:export',

  // администрирование
  ADMIN_USERS: 'admin:users',
  ADMIN_REFERENCE: 'admin:reference',
  ADMIN_INTEGRATIONS: 'admin:integrations',
  ADMIN_AUDIT: 'admin:audit',
  ADMIN_CALENDAR: 'admin:calendar',

  // файлы
  FILE_DOWNLOAD: 'file:download',
} as const;

export type Permission = (typeof P)[keyof typeof P];

const SALES_BASE: Permission[] = [
  P.REFERENCE_READ,
  P.APPLICATION_LIST,
  P.APPLICATION_CREATE,
  P.APPLICATION_UPDATE,
  P.APPLICATION_SET_COMPLEXITY,
  P.APPLICATION_CHANGE_STAGE,
  P.APPLICATION_READ_TIMELINE,
  P.ORG_READ,
  P.ORG_WRITE,
  P.CONTACT_READ,
  P.TASK_READ_ANY,
  P.TASK_CREATE,
  P.QUOTE_READ,
  P.QUOTE_CREATE,
  P.QUOTE_UPDATE_DRAFT,
  P.QUOTE_UPLOAD,
  P.QUOTE_SUBMIT_APPROVAL,
  P.QUOTE_SEND,
  P.QUOTE_RECORD_EXTERNAL_SEND,
  P.QUOTE_ACCEPT,
  P.ENG_CREATE_TASK,
  P.COMMERCIAL_READ,
  P.RELEASE_CHECK,
  P.FULFILLMENT_READ,
  P.FULFILLMENT_WRITE, // продавец подтверждает отгрузку и закрывающие документы
  P.CLOSE_CHECK,
  P.CLOSE_EXECUTE,
  P.MAIL_INBOX_READ,
  P.MAIL_INBOX_PROCESS,
  P.IMPORT_RUN,
  P.IMPORT_COMMIT,
  P.SLA_READ,
  P.NOTIFICATION_READ,
  P.ANALYTICS_READ,
  P.ANALYTICS_EXPORT, // §10.2 выгрузка снимка в разрешённой области видимости
  P.FILE_DOWNLOAD,
];

/** Матрица полномочий по ролям (§3.1). */
const SALES_MANAGER_PERMISSIONS: readonly Permission[] = [
  ...SALES_BASE,
  P.APPLICATION_READ_ANY,
  P.APPLICATION_UPDATE_ANY,
  P.APPLICATION_ASSIGN,
  P.APPLICATION_ARCHIVE,
  P.QUOTE_APPROVE, // RBAC-04
  P.ENG_READ_QUEUE,
  P.ENG_APPROVE_CONCLUSION,
  P.APPLICATION_SET_COMPLEXITY_DOWNGRADE, // ENG-03
  P.COMMERCIAL_WRITE,
  P.CONTRACT_SIGN,
  P.RELEASE_EXECUTE, // GATE-01: штатный выпуск в производство
  P.RELEASE_MANUAL_APPROVE, // GATE-01
  P.ANALYTICS_EXPORT,
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SALES: SALES_BASE,

  SALES_MANAGER: SALES_MANAGER_PERMISSIONS,

  DESIGN_MANAGER: [
    P.REFERENCE_READ,
    P.APPLICATION_LIST,
    P.APPLICATION_READ_ANY,
    P.APPLICATION_READ_TIMELINE,
    P.ORG_READ,
    P.CONTACT_READ,
    P.ENG_READ_QUEUE,
    P.ENG_CREATE_TASK,
    P.ENG_ASSIGN_DESIGNER,
    P.ENG_APPROVE_CONCLUSION,
    P.ENG_CANCEL,
    P.APPLICATION_SET_COMPLEXITY_DOWNGRADE, // ENG-03: понижение CUSTOM
    P.QUOTE_READ, // §3.1 «просмотр КО»
    P.COMMERCIAL_READ,
    P.FULFILLMENT_READ,
    P.SLA_READ,
    P.NOTIFICATION_READ,
    P.FILE_DOWNLOAD,
  ],

  DESIGNER: [
    P.REFERENCE_READ,
    P.APPLICATION_LIST,
    P.APPLICATION_READ_TIMELINE,
    P.ORG_READ,
    P.CONTACT_READ,
    P.ENG_WORK,
    P.QUOTE_READ,
    P.FULFILLMENT_READ,
    P.NOTIFICATION_READ,
    P.FILE_DOWNLOAD,
  ],

  PRODUCTION: [
    P.REFERENCE_READ,
    P.APPLICATION_LIST,
    P.APPLICATION_READ_TIMELINE,
    P.ORG_READ,
    P.PRODUCTION_UPDATE_STAGES,
    P.COMMERCIAL_READ, // минимально необходимый коммерческий контекст
    P.FULFILLMENT_READ,
    P.FULFILLMENT_WRITE, // отгрузки и закрывающие документы
    P.RELEASE_CHECK,
    P.CLOSE_CHECK,
    P.SLA_READ,
    P.NOTIFICATION_READ,
    P.FILE_DOWNLOAD,
  ],

  VIEWER: [
    P.REFERENCE_READ,
    P.APPLICATION_LIST,
    P.APPLICATION_READ_TIMELINE,
    P.ORG_READ,
    P.CONTACT_READ,
    P.QUOTE_READ,
    P.COMMERCIAL_READ,
    P.FULFILLMENT_READ,
    P.SLA_READ,
    P.ANALYTICS_READ,
    P.NOTIFICATION_READ,
    P.FILE_DOWNLOAD,
  ],

  ADMIN: [
    ...SALES_MANAGER_PERMISSIONS,
    P.APPLICATION_DELETE,
    P.APPLICATION_READ_AUDIT,
    P.TASK_UPDATE_ANY,
    P.TASK_COMPLETE_OTHER, // RBAC-05
    P.ACTIVITY_CORRECT_ANY, // §10.1 коррекция чужой коммуникации — с правом правки
    P.PRODUCTION_UPDATE_STAGES,
    P.RELEASE_ADMIN_OVERRIDE, // GATE-04
    P.SLA_WRITE,
    P.ANALYTICS_EXPORT,
    P.MAIL_INBOX_READ,
    P.MAIL_INBOX_PROCESS,
    P.IMPORT_RUN,
    P.IMPORT_COMMIT,
    P.ADMIN_USERS,
    P.ADMIN_REFERENCE,
    P.ADMIN_INTEGRATIONS,
    P.ADMIN_AUDIT,
    P.ADMIN_CALENDAR,
  ],
};

/** Область видимости данных по роли. */
export const ROLE_SCOPE: Record<Role, Scope> = {
  ADMIN: SCOPE.ALL,
  SALES_MANAGER: SCOPE.ALL,
  SALES: SCOPE.OWN_APPS,
  DESIGN_MANAGER: SCOPE.KO_QUEUE,
  DESIGNER: SCOPE.ASSIGNED_ENG,
  PRODUCTION: SCOPE.PRODUCED,
  VIEWER: SCOPE.NONE,
};

/**
 * Явное исключение из RBAC-04: ADMIN не получает скрытого обхода маршрута
 * согласования КП. Здесь перечислены полномочия, которые ADMIN имеет,
 * а «approve» — тоже имеет, но оно требует отдельного зафиксированного
 * действия; попытка согласовать «скрыто» невозможна, т.к. approve всегда
 * пишет CrmQuoteApproval. Здесь фиксируем инвариант для тестов.
 */
export const ADMIN_CANNOT_BYPASS_QUOTE_APPROVAL = true;

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function can(role: Role, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

export function assertPermission(role: Role, permission: Permission, msg?: string): void {
  if (!can(role, permission)) {
    throw forbidden(
      msg ?? `Роль ${role} не имеет полномочия «${permission}». Действие отклонено сервером.`,
    );
  }
}

export function assertAnyPermission(role: Role, permissions: Permission[], msg?: string): void {
  if (!permissions.some((p) => can(role, p))) {
    throw forbidden(msg ?? `Роль ${role} не имеет ни одного из полномочий: ${permissions.join(', ')}`);
  }
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

/** Роли, которым разрешено назначать конструктора (§3.1). */
export const ROLES_THAT_ASSIGN_DESIGNER: Role[] = ['DESIGN_MANAGER', 'ADMIN'];

/** Роли, которым разрешено согласовать коммерческую версию КП (RBAC-04). */
export const ROLES_THAT_APPROVE_QUOTES: Role[] = ['SALES_MANAGER'];