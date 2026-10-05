/** Доменные константы ТЗ. Единый источник правды для backend и UI. */

export const ROLES = [
  'ADMIN',
  'SALES_MANAGER',
  'SALES',
  'DESIGN_MANAGER',
  'DESIGNER',
  'PRODUCTION',
  'VIEWER',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Администратор',
  SALES_MANAGER: 'Руководитель продаж',
  SALES: 'Менеджер по продажам',
  DESIGN_MANAGER: 'Руководитель конструкторского отдела',
  DESIGNER: 'Конструктор',
  PRODUCTION: 'Производство',
  VIEWER: 'Наблюдатель',
};

// ─────────────────────────────── §7.1 этапы процесса

export const STAGES = [
  'NEW',
  'SALES_REVIEW',
  'CLARIFICATION',
  'QUOTE_PREPARED',
  'QUOTE_SENT',
  'CONTRACT_PENDING',
  'CONTRACT_SIGNED',
  'TO_PRODUCTION',
  'DESIGN_IN_PROGRESS',
  'DESIGN_COMPLETE',
  'MANUFACTURING',
  'READY_TO_SHIP',
  'FULFILLMENT',
  'CLOSED',
  'CANCELLED',
  'ARCHIVED',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  NEW: 'Новая',
  SALES_REVIEW: 'Проверка продажей',
  CLARIFICATION: 'Уточнение данных',
  QUOTE_PREPARED: 'КП подготовлено',
  QUOTE_SENT: 'КП отправлено',
  CONTRACT_PENDING: 'Согласование договора',
  CONTRACT_SIGNED: 'Договор подписан',
  TO_PRODUCTION: 'Передано в производство',
  DESIGN_IN_PROGRESS: 'Разработка документации',
  DESIGN_COMPLETE: 'Документация готова',
  MANUFACTURING: 'Изготовление',
  READY_TO_SHIP: 'Готово к отгрузке',
  FULFILLMENT: 'Отгрузки и расчёты',
  CLOSED: 'Закрыто',
  CANCELLED: 'Отменено',
  ARCHIVED: 'В архиве',
};

/** Коды этапов, унаследованные из исходной модели (§7.2). */
export const LEGACY_STATUS_MAP: Record<string, Stage> = {
  PAYMENT_PENDING: 'FULFILLMENT',
  PAID: 'FULFILLMENT',
};

export const LEGACY_STATUSES = Object.keys(LEGACY_STATUS_MAP);

/** Этапы, доступные в воронке (архив и отмена скрыты из активных списков). */
export const PIPELINE_STAGES: Stage[] = [
  'NEW',
  'SALES_REVIEW',
  'CLARIFICATION',
  'QUOTE_PREPARED',
  'QUOTE_SENT',
  'CONTRACT_PENDING',
  'CONTRACT_SIGNED',
  'TO_PRODUCTION',
  'DESIGN_IN_PROGRESS',
  'DESIGN_COMPLETE',
  'MANUFACTURING',
  'READY_TO_SHIP',
  'FULFILLMENT',
  'CLOSED',
];

/** Семантические группы для цвета статуса в UI. */
export const STAGE_TONE: Record<Stage, 'neutral' | 'info' | 'progress' | 'warning' | 'success' | 'danger'> = {
  NEW: 'neutral',
  SALES_REVIEW: 'info',
  CLARIFICATION: 'warning',
  QUOTE_PREPARED: 'info',
  QUOTE_SENT: 'info',
  CONTRACT_PENDING: 'warning',
  CONTRACT_SIGNED: 'progress',
  TO_PRODUCTION: 'progress',
  DESIGN_IN_PROGRESS: 'progress',
  DESIGN_COMPLETE: 'progress',
  MANUFACTURING: 'progress',
  READY_TO_SHIP: 'progress',
  FULFILLMENT: 'warning',
  CLOSED: 'success',
  CANCELLED: 'danger',
  ARCHIVED: 'neutral',
};

/**
 * Разрешённые переходы этапов (§7.1 + §7.2).
 * `via` — обязательное промежуточное действие/проверка; нарушение блокирует переход.
 */
export const STAGE_TRANSITIONS: Record<Stage, Stage[]> = {
  NEW: ['SALES_REVIEW', 'CANCELLED'],
  SALES_REVIEW: ['CLARIFICATION', 'QUOTE_PREPARED', 'CANCELLED'],
  CLARIFICATION: ['SALES_REVIEW', 'QUOTE_PREPARED', 'CANCELLED'],
  QUOTE_PREPARED: ['QUOTE_SENT', 'CLARIFICATION', 'CONTRACT_PENDING', 'CANCELLED'],
  QUOTE_SENT: ['CONTRACT_PENDING', 'CLARIFICATION', 'CANCELLED'],
  CONTRACT_PENDING: ['CONTRACT_SIGNED', 'CANCELLED', 'CLARIFICATION'],
  CONTRACT_SIGNED: ['TO_PRODUCTION', 'CONTRACT_PENDING'],
  // TO_PRODUCTION достигается только серверным выпуском (GATE-04) — см. releaseToProduction()
  TO_PRODUCTION: ['DESIGN_IN_PROGRESS', 'MANUFACTURING'],
  DESIGN_IN_PROGRESS: ['DESIGN_COMPLETE', 'MANUFACTURING'],
  DESIGN_COMPLETE: ['MANUFACTURING', 'READY_TO_SHIP'],
  MANUFACTURING: ['READY_TO_SHIP', 'FULFILLMENT'],
  READY_TO_SHIP: ['FULFILLMENT'],
  FULFILLMENT: ['CLOSED', 'MANUFACTURING'],
  CLOSED: ['FULFILLMENT'], // CLOSE-03: возврат при последующей корректировке
  CANCELLED: [],
  ARCHIVED: [],
};

/** Переходы, доступные только через специальный серверный маршрут. */
export const GUARDED_STAGE_TARGETS: Stage[] = ['TO_PRODUCTION', 'CLOSED'];

/** После начала коммерческой работы отмена требует причины потери (§7.2). */
export const LOSS_REASON_REQUIRED_FROM: Stage[] = ['QUOTE_PREPARED', 'QUOTE_SENT', 'CONTRACT_PENDING', 'CONTRACT_SIGNED'];

export const COMPLEXITY_LEVELS = ['STANDARD', 'MODIFIED', 'CUSTOM', 'NEEDS_CLASSIFICATION'] as const;
export type Complexity = (typeof COMPLEXITY_LEVELS)[number];

export const COMPLEXITY_LABELS: Record<Complexity, string> = {
  STANDARD: 'Типовая',
  MODIFIED: 'Модифицированная',
  CUSTOM: 'Нестандартная',
  NEEDS_CLASSIFICATION: 'Требует классификации',
};

export const COMPLEXITY_RANK: Record<Complexity, number> = {
  NEEDS_CLASSIFICATION: -1,
  STANDARD: 0,
  MODIFIED: 1,
  CUSTOM: 2,
};

/** Уровень заявки = максимум по активным позициям (ENG-01). */
export function applicationComplexity(lineComplexities: (Complexity | null)[]): Complexity {
  let max: Complexity = 'NEEDS_CLASSIFICATION';
  let has = false;
  for (const c of lineComplexities) {
    if (!c) continue;
    has = true;
    if (COMPLEXITY_RANK[c] > COMPLEXITY_RANK[max]) max = c;
  }
  return has ? max : 'NEEDS_CLASSIFICATION';
}

export const LOSS_REASONS = [
  'PRICE',
  'DELIVERY_TIME',
  'TECHNICAL_MISMATCH',
  'CUSTOMER_CANCELLED',
  'COMPETITOR',
  'NO_RESPONSE',
  'DUPLICATE',
  'OTHER',
] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

export const LOSS_REASON_LABELS: Record<LossReason, string> = {
  PRICE: 'Цена',
  DELIVERY_TIME: 'Срок поставки',
  TECHNICAL_MISMATCH: 'Техническое несоответствие',
  CUSTOMER_CANCELLED: 'Отказ клиента',
  COMPETITOR: 'Конкурент',
  NO_RESPONSE: 'Нет ответа',
  DUPLICATE: 'Дубликат',
  OTHER: 'Другое',
};

export const SOURCES = ['SELECTOR', 'MANUAL', 'EMAIL', 'IMPORT'] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<Source, string> = {
  SELECTOR: 'Модуль подбора',
  MANUAL: 'Ручной ввод',
  EMAIL: 'Входящая почта',
  IMPORT: 'Импорт Excel/CSV',
};

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export const PRIORITY_LABELS: Record<string, string> = { LOW: 'Низкий', NORMAL: 'Обычный', HIGH: 'Высокий' };

export const TASK_TYPES = ['CALL', 'EMAIL', 'MEETING', 'TASK', 'FOLLOW_UP', 'OTHER'] as const;
export const TASK_TYPE_LABELS: Record<string, string> = {
  CALL: 'Звонок',
  EMAIL: 'Письмо',
  MEETING: 'Встреча',
  TASK: 'Задача',
  FOLLOW_UP: 'Следующий контакт',
  OTHER: 'Прочее',
};

export const ACTIVITY_TYPES = ['CALL', 'EMAIL', 'MEETING', 'NOTE', 'SYSTEM'] as const;
export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  CALL: 'Звонок',
  EMAIL: 'Письмо',
  MEETING: 'Встреча',
  NOTE: 'Заметка',
  SYSTEM: 'Системное событие',
};

export const PAYMENT_TERMS = ['PREPAYMENT_100', 'PREPAYMENT_PARTIAL', 'POSTPAYMENT', 'CUSTOM', 'NOT_SET'] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];

export const PAYMENT_TERMS_LABELS: Record<PaymentTerms, string> = {
  PREPAYMENT_100: 'Предоплата 100%',
  PREPAYMENT_PARTIAL: 'Частичная предоплата (аванс)',
  POSTPAYMENT: 'Постоплата',
  CUSTOM: 'Индивидуальные условия',
  NOT_SET: 'Не заданы',
};

export const ENG_TASK_KINDS = ['PREQUOTE', 'ORDER_DESIGN'] as const;
export const ENG_TASK_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_INPUT', 'COMPLETED', 'CANCELLED'] as const;
export const ENG_TASK_KIND_LABELS: Record<string, string> = {
  PREQUOTE: 'Предварительная проработка',
  ORDER_DESIGN: 'Разработка документации',
};

export const ENG_DECISIONS = ['FEASIBLE', 'FEASIBLE_WITH_CONDITIONS', 'NEED_DATA', 'NOT_FEASIBLE'] as const;
export const ENG_DECISION_LABELS: Record<string, string> = {
  FEASIBLE: 'Допустимо',
  FEASIBLE_WITH_CONDITIONS: 'Допустимо с условиями',
  NEED_DATA: 'Нужны данные',
  NOT_FEASIBLE: 'Невыполнимо',
};

export const QUOTE_STATUSES = ['DRAFT', 'READY', 'SENT', 'ACCEPTED', 'REJECTED', 'SUPERSEDED'] as const;
export const QUOTE_APPROVAL_STATUSES = [
  'NOT_REQUESTED',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'INVALIDATED',
] as const;

export const MAIL_QUEUE_STATES = ['QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'UNKNOWN'] as const;

export const CURRENCIES = ['RUB', 'USD', 'EUR'] as const;

/** Матрица закрывающих документов по типу заказа (CLOSE-02, настраивается в §19). */
export const CLOSING_DOC_TEMPLATES: Record<string, { docType: string; required: boolean; bothSignatures?: boolean }[]> = {
  DEFAULT: [
    { docType: 'UPD', required: true, bothSignatures: true },
    { docType: 'NAKLADNAYA', required: true },
  ],
  WITH_SERVICES: [
    { docType: 'UPD', required: true, bothSignatures: true },
    { docType: 'NAKLADNAYA', required: true },
    { docType: 'ACT', required: true, bothSignatures: true },
  ],
};
