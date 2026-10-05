/** Типы контракта API, соответствующие ответам backend (snake_case сохраняется). */

export type Role = 'ADMIN' | 'SALES_MANAGER' | 'SALES' | 'DESIGN_MANAGER' | 'DESIGNER' | 'PRODUCTION' | 'VIEWER';

export interface SessionUser {
  id: string;
  login: string;
  fullName: string;
  role: Role;
  scope: string;
}

export interface LoginResponse {
  token: string;
  tokenType: string;
  expiresIn: number;
  user: SessionUser;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface PagedResponse<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface Organization {
  id: string;
  name: string;
  fullName?: string | null;
  inn?: string | null;
  kpp?: string | null;
  website?: string | null;
  industry?: string | null;
  address?: string | null;
  contacts?: Contact[];
}

export interface Contact {
  id: string;
  organizationId: string;
  fullName: string;
  position?: string | null;
  phone?: string | null;
  email?: string | null;
  preferredChannel?: string | null;
  isPrimary?: boolean;
}

export interface UserRef {
  id: string;
  fullName: string;
  role?: Role;
}

export interface ApplicationLine {
  id: string;
  lineId: string;
  name: string;
  quantity: number;
  unit?: string | null;
  catalogRef?: string | null;
  price?: number | null;
  currency?: string | null;
  complexity?: string | null;
  params?: unknown;
  shippedQty: number;
  orderQty: number;
  lockVersion?: number;
}

export interface CrmTask {
  id: string;
  applicationId: string;
  type: string;
  subject: string;
  description?: string | null;
  authorId: string;
  assigneeId: string;
  dueAt: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  priority: string;
  contactId?: string | null;
  reminderAt?: string | null;
  completedAt?: string | null;
  completedById?: string | null;
  result?: string | null;
  cancelReason?: string | null;
  lockVersion: number;
  assignee?: UserRef;
  application?: { id: string; number: string; stage: string; organization?: { name: string } };
}

export interface CrmActivity {
  id: string;
  applicationId: string;
  type: string;
  direction?: 'IN' | 'OUT' | null;
  participants?: string | null;
  occurredAt: string;
  registeredAt: string;
  authorId: string;
  subject?: string | null;
  content?: string | null;
  result?: string | null;
  isCustomerFacing: boolean;
  previousContent?: string | null;
  correctedById?: string | null;
  author?: UserRef;
}

export interface Quote {
  id: string;
  applicationId: string;
  versionNo: number;
  status: string;
  approvalStatus: string;
  amount?: number | null;
  currency?: string | null;
  validUntil?: string | null;
  leadTimeDays?: number | null;
  deliveryTerms?: string | null;
  paymentTermsNote?: string | null;
  discountPct?: number | null;
  taxAttribute?: string | null;
  technicalNotes?: string | null;
  conditionsNote?: string | null;
  fileId?: string | null;
  externalSentAt?: string | null;
  customerDecision?: string | null;
  customerDecisionAt?: string | null;
  lockVersion: number;
  lines?: QuoteLine[];
  createdAt?: string;
}

export interface QuoteLine {
  lineId: string;
  name?: string;
  unit?: string | null;
  quantity: number;
  price: number;
  amount?: number;
}

export interface Commercial {
  id: string;
  applicationId: string;
  contractNumber?: string | null;
  contractDate?: string | null;
  contractStatus: string;
  contractFileId?: string | null;
  contractSignedAt?: string | null;
  specificationRef?: string | null;
  basisQuoteId?: string | null;
  basisAmount?: number | null;
  basisCurrency?: string | null;
  paymentTerms?: string | null;
  paymentSchedule: string;
  deliveryTerms?: string | null;
  versionNo: number;
  syncedTo1C: boolean;
  lockVersion: number;
  invoices?: Invoice[];
  releaseApproval?: ReleaseApproval | null;
}

export interface Invoice {
  id: string;
  extId?: string | null;
  number?: string | null;
  docDate?: string | null;
  amount: number;
  currency: string;
  status: string;
}

export interface ReleaseApproval {
  id: string;
  reason: string;
  approvedById?: string | null;
  approvedAt?: string;
  revokedAt?: string | null;
  revokeReason?: string | null;
}

export interface EngTask {
  id: string;
  applicationId: string;
  kind: 'PREQUOTE' | 'ORDER_DESIGN';
  status: string;
  priority: string;
  assigneeId?: string | null;
  createdById?: string | null;
  dueAt?: string | null;
  questions?: string | null;
  conclusionId?: string | null;
  conclusionApprovedAt?: string | null;
  conclusionApprovedById?: string | null;
  decision?: string | null;
  conditions?: string | null;
  technicalExecution?: string | null;
  leadTimeDays?: number | null;
  lockVersion: number;
  assignee?: UserRef;
  application?: { number: string; organization?: { name: string } };
}

export interface EngConclusion {
  id: string;
  taskId: string;
  decision: string;
  conditions?: string | null;
  technicalExecution?: string | null;
  leadTimeDays?: number | null;
  createdById?: string;
  createdAt?: string;
  approvedAt?: string | null;
  approvedById?: string | null;
  approvalComment?: string | null;
}

export interface Shipment {
  id: string;
  extId?: string | null;
  number?: string | null;
  docDate?: string | null;
  status: string;
  carrier?: string | null;
  lines?: { lineId: string; quantity: number; unit?: string | null }[];
  discrepancies?: { lineId?: string; message: string }[];
}

export interface ClosingDoc {
  id: string;
  docType: string;
  isRequired: boolean;
  requiresBothSignatures?: boolean;
  status: string;
  extSystem?: string | null;
  extId?: string | null;
  number?: string | null;
  registeredAt?: string | null;
  fileId?: string | null;
  source?: string | null;
}

export interface Release {
  id: string;
  status: string;
  releasedAt?: string | null;
  completedAt?: string | null;
  stage?: string | null;
  applicationId?: string;
}

export interface SlaInstance {
  id: string;
  ruleName?: string;
  ruleCode?: string;
  stage?: string;
  dueAt?: string | null;
  status: string;
  pausedAt?: string | null;
  pauseReason?: string | null;
  breachAt?: string | null;
}

export interface ApplicationListItem {
  id: string;
  number: string;
  stage: string;
  legacyStatus?: string | null;
  organization: { id: string; name: string };
  contact?: { id: string; fullName: string; phone?: string | null; email?: string | null } | null;
  owner?: UserRef | null;
  source: string;
  priority: string;
  complexity?: string | null;
  amount?: number | null;
  currency?: string | null;
  successProbability?: number | null;
  expectedDecisionDate?: string | null;
  lastActivityAt?: string | null;
  lastCustomerContactAt?: string | null;
  nextActivityAt?: string | null;
  isClosed: boolean;
  lossReason?: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { tasks?: number; activities?: number };
  isOverdue?: boolean;
}

export interface ApplicationDetail extends ApplicationListItem {
  organizationId: string;
  contactId?: string | null;
  ownerId?: string | null;
  sourceRef?: string | null;
  complexityConfirmedById?: string | null;
  complexityConfirmedAt?: string | null;
  tags?: string[] | null;
  crmComment?: string | null;
  lossComment?: string | null;
  engineQuestions?: unknown;
  closedAt?: string | null;
  closedById?: string | null;
  closeReopenedAt?: string | null;
  closeReopenReason?: string | null;
  externalNumber?: string | null;
  parentApplicationId?: string | null;
  linkedDuplicateId?: string | null;
  isDraft?: boolean;
  lockVersion: number;
  versionNo: number;
  organization: Organization;
  contact?: Contact | null;
  lines: ApplicationLine[];
  tasks: CrmTask[];
  activities: CrmActivity[];
  quotes: Quote[];
  engTasks: EngTask[];
  commercial?: Commercial | null;
  shipments: Shipment[];
  closingDocs: ClosingDoc[];
  releases?: Release[];
  slaInstances?: SlaInstance[];
  assignmentHistory?: { id: string; fromOwnerId?: string | null; toOwnerId?: string | null; createdAt: string }[];
}

export interface Timeline {
  application: { number: string; stage: string };
  activities: (CrmActivity & { author?: UserRef })[];
  tasks: CrmTask[];
  quotes: Quote[];
  engineering: EngTask[];
  shipments: Shipment[];
  stageEvents: { id: string; fromStage?: string | null; toStage: string; createdAt: string; comment?: string | null }[];
  dispatches: unknown[];
}

export interface ReleaseCheck {
  can_release_to_production: boolean;
  blockers: { code: string; message: string }[];
  warnings?: { code: string; message: string }[];
  checks?: Record<string, unknown>;
}

/** Закрывающий документ в сводке исполнения (набор задаётся в заявке). */
export interface FulfilmentClosingDoc {
  id: string;
  docType: string;
  isRequired: boolean;
  requiresBothSignatures: boolean;
  status: string;
  number: string | null;
  registeredAt: string | null;
}

export interface FulfilmentLine {
  lineId: string;
  name: string;
  unit?: string | null;
  orderQty: number;
  shippedQty: number;
  remainingQty: number;
}

/**
 * Сводка исполнения заказа `/applications/:number/fulfilment`.
 * Имена полей (`orderQty`/`shippedQty`/`remainingQty`, `finance.*`, флаги
 * `isFullyShipped`/`isFullyPaid`) соответствуют ответу бэкенда.
 */
export interface Fulfilment {
  application: { id: string; number: string; stage: string; amount: number | null; currency: string | null };
  lines: FulfilmentLine[];
  discrepancies: { lineId?: string; message: string }[];
  shipments: {
    id: string;
    number: string | null;
    docDate: string;
    status: string;
    isCancelled: boolean;
    isPosted: boolean;
    carrier: string | null;
    lines: { lineId: string; quantity: number; actualDate: string | null }[];
  }[];
  finance: {
    contractStatus: string;
    paymentTerms: string | null;
    basisAmount: number | null;
    invoicedTotal: number;
    paidTotal: number;
    openInvoices: { id: string; number: string | null; amount: number; status: string }[];
    paymentFreshnessMinutes: number | null;
  };
  closingDocuments: FulfilmentClosingDoc[];
  isFullyShipped: boolean;
  isFullyPaid: boolean;
  closingDocumentsComplete: boolean;
}

export interface CloseCheck {
  canClose: boolean;
  blockers: { code: string; message: string }[];
  /** Полная сводка исполнения; прежние `checklist`/`closingDocuments` API не отдаёт. */
  summary: Fulfilment;
}

export interface Dashboard {
  role: string;
  period: { from: string; to: string };
  counters: Record<string, number>;
  amountsByCurrency?: Record<string, number>;
  /**
   * Счётчики задач текущего пользователя, а не списки. Массивы задач для
   * таблиц рабочего стола берутся из `/tasks?today=true` и `/tasks?overdue=true`.
   */
  tasks: { today: number; overdue: number };
  quotes: {
    pendingApproval: number;
    sentAwaitingDecision: number;
    acceptedAmountByCurrency?: Record<string, number>;
  };
  payments: {
    /** Счёт к оплате: номер счёта и остаток по нему. */
    expected: { number: string; amount: number; currency: string; dueAt: string }[];
    outstandingByCurrency: Record<string, number>;
  };
  shipments: {
    openLines: number;
    remainingByLine: { lineId: string; name: string; remaining: number; unit: string; applicationNumber: string }[];
  };
  stale: { applications: number; tasks: number };
  accountingDataAgeMinutes?: number | null;
}

export interface Pipeline {
  period: { from: string; to: string };
  scope: string;
  totals: {
    created: number;
    active: number;
    won: number;
    lost: number;
    amountByCurrency: Record<string, number>;
    conversionToContract: number;
    conversionToWon: number;
  };
  byStage: { stage: string; label: string; count: number; amountByCurrency: Record<string, number> }[];
  /** Длительности приходят в часах; прежнее `avgDays` в ответе отсутствовало. */
  stageDurations: { stage: string; label: string; samples: number; medianHours: number; maxHours: number }[];
  byComplexity: { complexity: string; count: number }[];
  lossReasons: { reason: string; label: string; count: number }[];
  /** Сумма открытых КП по валютам, а не объект с `count`. */
  openQuotes: Record<string, number>;
}

export interface PlanFact {
  fulfilment: { totalOrdered: number; totalShipped: number; totalRemaining: number; completionPct: number };
  finance: { invoicedByCurrency: Record<string, number>; paidByCurrency: Record<string, number>; paidTotal: number };
  byApplication: { number: string; ordered: number; shipped: number; amount: number; currency: string | null }[];
}

export interface Notification {
  id: string;
  userId: string;
  code: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Признак прочитанного уведомления (совместимо с API). */
  isRead: boolean;
  createdAt: string;
}

export interface MyWork {
  todayTasks: CrmTask[];
  overdueTasks: CrmTask[];
  activeApplications: (ApplicationListItem & { nextActivityAt?: string | null })[];
  pendingApprovals: number;
}

export interface AdminUser {
  id: string;
  login: string;
  fullName: string;
  email?: string | null;
  role: Role;
  scope: string;
  isActive: boolean;
  blockedAt?: string | null;
  lastLoginAt?: string | null;
}

export interface MailMessage {
  id: string;
  mailbox: string;
  from: string;
  to: string;
  subject: string;
  bodyText?: string | null;
  receivedAt: string;
  status: string;
  applicationNumber?: string | null;
  matchedApplicationId?: string | null;
}

export interface ReferenceData {
  stages: { value: string; label: string; order: number }[];
  priorities: { value: string; label: string }[];
  sources: { value: string; label: string }[];
  currencies: { value: string; label: string }[];
  complexity: { value: string; label: string }[];
  taskTypes: { value: string; label: string }[];
  activityTypes: { value: string; label: string }[];
  units: { value: string; label: string }[];
  lossReasons: { value: string; label: string }[];
}

/** Строка нормализованного импорта (IMP-01). */
export interface ImportRow {
  groupId: string;
  externalNumber?: string;
  organizationName: string;
  inn?: string;
  kpp?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  lineId?: string;
  lineName: string;
  quantity: number;
  unit?: string;
  price?: number;
  rowNo: number;
}

/** Ошибка строки импорта указывает поле, причину и способ исправления (IMP-02). */
export interface ImportIssue {
  rowNo: number;
  field: string;
  reason: string;
  fix: string;
}

export interface ImportGroupPreview {
  groupId: string;
  rows: number;
  organizationName: string;
  inn?: string | null;
  totalQty: number;
  totalAmount: number;
  duplicateHint?: string | null;
}

export interface ImportBatch {
  id: string;
  fileName: string;
  fileChecksum?: string;
  sourceKey?: string;
  externalBatchId?: string | null;
  status: string;
  totalRows: number;
  validGroups: number;
  errorGroups: number;
  createdGroups: number;
  errors: string;
  warnings?: string;
  createdAt: string;
  committedAt?: string | null;
}

export interface ImportValidateResult {
  batch: ImportBatch;
  preview: ImportGroupPreview[];
  issues: ImportIssue[];
  rejectedGroups: string[];
  duplicateOf: string | null;
}

export interface ImportCommitResult {
  batch: ImportBatch;
  created: { groupId: string; number: string; deduplicated: boolean }[];
  failed: { groupId: string; reason: string }[];
}

/** Фактические поля ответа `GET /audit-events` (без обогащения именем заявки). */
export interface AuditEvent {
  id: string;
  createdAt: string;
  actionCode: string;
  entityType?: string | null;
  entityId?: string | null;
  applicationId?: string | null;
  actorUserId?: string | null;
  actorLogin?: string | null;
  payload?: string | null;
  beforeJson?: string | null;
  afterJson?: string | null;
  correlationId?: string | null;
  userReason?: string | null;
  ip?: string | null;
}