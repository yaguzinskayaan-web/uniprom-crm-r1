import type { Prisma } from '@prisma/client';

/**
 * Business error codes from ТЗ §13.3 API-03 plus the codes actually raised by
 * this implementation. The `code` is a stable contract for the frontend and
 * for acceptance tests (§17); `message` must stay human readable and must
 * never leak a stack trace or SQL (UI-03).
 */
export const ErrorCode = {
  // validation / generic
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  USER_BLOCKED: 'USER_BLOCKED',
  LOGIN_LIMIT_EXCEEDED: 'LOGIN_LIMIT_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',

  // optimistic locking (API-02, A37)
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  RESOURCE_LOCKED: 'RESOURCE_LOCKED',

  // quote approval (A14..A17)
  QUOTE_APPROVAL_REQUIRED: 'QUOTE_APPROVAL_REQUIRED',
  QUOTE_VERSION_CHANGED: 'QUOTE_VERSION_CHANGED',
  QUOTE_NOT_READY: 'QUOTE_NOT_READY',
  QUOTE_ALREADY_SENT: 'QUOTE_ALREADY_SENT',
  QUOTE_SENT_IMMUTABLE: 'QUOTE_SENT_IMMUTABLE',
  QUOTE_FILE_REQUIRED: 'QUOTE_FILE_REQUIRED',
  QUOTE_VALIDITY_EXPIRED: 'QUOTE_VALIDITY_EXPIRED',
  QUOTE_RECIPIENT_REQUIRED: 'QUOTE_RECIPIENT_REQUIRED',
  QUOTE_APPROVER_ROLE_REQUIRED: 'QUOTE_APPROVER_ROLE_REQUIRED',
  QUOTE_APPROVAL_COMMENT_REQUIRED: 'QUOTE_APPROVAL_COMMENT_REQUIRED',
  DUPLICATE_IDEMPOTENCY_KEY: 'DUPLICATE_IDEMPOTENCY_KEY',

  // engineering (A10..A12)
  TECH_REVIEW_REQUIRED: 'TECH_REVIEW_REQUIRED',
  TECH_CONCLUSION_MISSING: 'TECH_CONCLUSION_MISSING',
  TECH_REVISION_CHANGED: 'TECH_REVISION_CHANGED',
  TECH_CONCLUSION_NOT_APPROVED: 'TECH_CONCLUSION_NOT_APPROVED',
  COMPLEXITY_DOWNGRADE_REQUIRES_APPROVER: 'COMPLEXITY_DOWNGRADE_REQUIRES_APPROVER',

  // release gate (GATE-01..04, A21..A27)
  CONTRACT_NOT_SIGNED: 'CONTRACT_NOT_SIGNED',
  PAYMENT_TERMS_NOT_SET: 'PAYMENT_TERMS_NOT_SET',
  FULL_PREPAYMENT_REQUIRED: 'FULL_PREPAYMENT_REQUIRED',
  PARTIAL_PREPAYMENT_REQUIRED: 'PARTIAL_PREPAYMENT_REQUIRED',
  MANUAL_RELEASE_APPROVAL_REQUIRED: 'MANUAL_RELEASE_APPROVAL_REQUIRED',
  PAYMENT_DATA_STALE: 'PAYMENT_DATA_STALE',
  ALREADY_RELEASED: 'ALREADY_RELEASED',
  RELEASE_NOT_ALLOWED_FOR_STAGE: 'RELEASE_NOT_ALLOWED_FOR_STAGE',
  RELEASE_APPROVAL_STALE: 'RELEASE_APPROVAL_STALE',

  // stage transitions (§7.2)
  INVALID_STAGE_TRANSITION: 'INVALID_STAGE_TRANSITION',
  STAGE_TRANSITION_REQUIRES_LOSS_REASON: 'STAGE_TRANSITION_REQUIRES_LOSS_REASON',
  STAGE_TRANSITION_REQUIRES_COMMENT: 'STAGE_TRANSITION_REQUIRES_COMMENT',

  // close (A30..A34)
  SHIPMENT_INCOMPLETE: 'SHIPMENT_INCOMPLETE',
  PAYMENT_INCOMPLETE: 'PAYMENT_INCOMPLETE',
  CLOSING_DOCUMENTS_INCOMPLETE: 'CLOSING_DOCUMENTS_INCOMPLETE',
  UNRESOLVED_DISCREPANCY: 'UNRESOLVED_DISCREPANCY',
  APPLICATION_NOT_IN_FULFILLMENT: 'APPLICATION_NOT_IN_FULFILLMENT',

  // assignment / RBAC
  ASSIGNEE_ROLE_MISMATCH: 'ASSIGNEE_ROLE_MISMATCH',
  ASSIGNEE_INACTIVE: 'ASSIGNEE_INACTIVE',
  CANNOT_ASSIGN_DESIGNER: 'CANNOT_ASSIGN_DESIGNER',

  // import (A08, A09)
  IMPORT_GROUP_INCOMPLETE: 'IMPORT_GROUP_INCOMPLETE',
  IMPORT_ALREADY_COMMITTED: 'IMPORT_ALREADY_COMMITTED',
  IMPORT_TOO_LARGE: 'IMPORT_TOO_LARGE',

  // integration
  INTEGRATION_CONFLICT: 'INTEGRATION_CONFLICT',
  STALE_INTEGRATION_VERSION: 'STALE_INTEGRATION_VERSION',

  // admin special operation
  REASON_REQUIRED: 'REASON_REQUIRED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface FieldError {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly fields: FieldError[];
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    opts: { fields?: FieldError[]; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = opts.fields ?? [];
    this.details = opts.details;
  }

  toPayload(correlationId: string) {
    return {
      code: this.code,
      message: this.message,
      ...(this.fields.length ? { fields: this.fields } : {}),
      ...(this.details ? { details: this.details } : {}),
      correlationId,
    };
  }
}

export const badRequest = (
  code: ErrorCodeValue,
  msg: string,
  opts?: { fields?: FieldError[]; details?: Record<string, unknown> },
) => new AppError(400, code, msg, opts);

export const forbidden = (msg = 'Недостаточно прав для этого действия') =>
  new AppError(403, ErrorCode.FORBIDDEN, msg);

export const notFound = (what = 'Объект') => new AppError(404, ErrorCode.NOT_FOUND, `${what} не найден`);

export const conflict = (code: ErrorCodeValue, msg: string, details?: Record<string, unknown>) =>
  new AppError(409, code, msg, { details });

export const unprocessable = (code: ErrorCodeValue, msg: string, fields?: FieldError[]) =>
  new AppError(422, code, msg, { fields });

export function prismaNotFound(where: Record<string, unknown>, what: string): AppError {
  return new AppError(404, ErrorCode.NOT_FOUND, `${what} не найден`, { details: { where: sanitizeWhere(where) } });
}

/** Never echo arbitrary values of foreign entities back to the caller. */
function sanitizeWhere(where: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(where)) {
    if (k === 'id' || k.endsWith('Id') || k === 'number') out[k] = typeof v === 'string' ? v.slice(0, 64) : v;
  }
  return out;
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = err as { code?: string; message?: string; statusCode?: number; meta?: { target?: string[] } };
  // Ограничение частоты — штатный ответ сервиса, а не внутренняя ошибка.
  if (e?.statusCode === 429) {
    return new AppError(429, ErrorCode.RATE_LIMITED, 'Слишком много запросов. Повторите попытку через несколько секунд.');
  }
  // Prisma unique constraint -> conflict
  if (e?.code === 'P2002') {
    const target = (e.meta?.target ?? []).join(', ');
    return new AppError(409, ErrorCode.VERSION_CONFLICT, 'Нарушено ограничение уникальности', {
      details: target ? { unique: target } : undefined,
    });
  }
  if (e?.code === 'P2025') {
    return new AppError(404, ErrorCode.NOT_FOUND, 'Объект не найден');
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервиса');
}

export type Tx = Prisma.TransactionClient;
