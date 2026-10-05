import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { ErrorCode, badRequest, conflict } from '../errors.js';

// ─────────────────────────── API-01: серверная пагинация

export interface PageQuery {
  page: number;
  size: number;
  offset: number;
}

export function parsePage(query: Record<string, unknown>): PageQuery {
  const page = Math.max(1, toInt(query.page, 1));
  const requested = toInt(query.size, config.defaultPageSize);
  const size = Math.min(config.maxPageSize, Math.max(1, requested));
  return { page, size, offset: (page - 1) * size };
}

function toInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export interface SortSpec<T extends string> {
  field: T;
  dir: 'asc' | 'desc';
}

/**
 * Стабильная сортировка с уникальным дополнительным ключом (API-01):
 * список не «прыгает» между страницами при равных значениях.
 */
export function parseSort<T extends string>(
  query: Record<string, unknown>,
  allowed: readonly T[],
  fallback: T = allowed[0]!,
): SortSpec<T> {
  const raw = String(query.sort ?? fallback);
  const [fieldRaw, dirRaw] = raw.split(':');
  const field = (allowed as readonly string[]).includes(fieldRaw ?? '') ? (fieldRaw as T) : fallback;
  const dir = (dirRaw ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
  return { field, dir };
}

/**
 * Стабильная сортировка: уникальный дополнительный ключ `id` предотвращает
 * «прыгание» списка между страницами при равных значениях (API-01).
 * Prisma принимает объектный orderBy только для одного поля, поэтому
 * сортировка всегда передаётся массивом.
 */
export function orderBy<T extends string>(s: SortSpec<T>): Record<string, 'asc' | 'desc'>[] {
  return [{ [s.field]: s.dir }, { id: 'asc' }];
}

// ─────────────────────────── Списки значений из query

export function csv(query: Record<string, unknown>, key: string): string[] {
  const v = query[key];
  if (v === undefined || v === null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
}

export function q(query: Record<string, unknown>, key: string): string | undefined {
  const v = query[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

export function bool(query: Record<string, unknown>, key: string): boolean | undefined {
  const v = query[key];
  if (v === undefined || v === null || v === '') return undefined;
  return v === true || v === 'true' || v === '1';
}

export function dateParam(query: Record<string, unknown>, key: string): Date | undefined {
  const s = q(query, key);
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw badRequest(ErrorCode.VALIDATION_ERROR, `Некорректная дата в параметре «${key}»`);
  return d;
}

export function numParam(query: Record<string, unknown>, key: string): number | undefined {
  const s = q(query, key);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw badRequest(ErrorCode.VALIDATION_ERROR, `Некорректное число в параметре «${key}»`);
  return n;
}

// ─────────────────────────── API-02: идемпотентность

export function idempotencyKey(headers: Record<string, unknown>, body?: unknown): string | undefined {
  const h = headers['idempotency-key'] ?? headers['x-idempotency-key'];
  if (typeof h === 'string' && h.trim()) return h.trim().slice(0, 200);
  const fromBody = (body as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim().slice(0, 200);
  return undefined;
}

export function requireIdempotencyKey(k: string | undefined, what: string): string {
  if (!k) {
    throw badRequest(
      ErrorCode.VALIDATION_ERROR,
      `Для операции «${what}» требуется ключ идемпотентности (заголовок Idempotency-Key).`,
      { fields: [{ field: 'Idempotency-Key', message: 'Укажите ключ идемпотентности' }] },
    );
  }
  return k;
}

// ─────────────────────────── API-02: optimistic locking

export function versionConflict(resource: string, current: number, provided: number) {
  // A37: второй сохраняющий получает 409, а не 400 — конфликт версий является
  // конфликтом состояния, клиент должен обновить ресурс и повторить.
  return conflict(ErrorCode.VERSION_CONFLICT, `Ресурс «${resource}» изменён другим пользователем. Обновите данные и повторите.`, {
    currentVersion: current,
    yourVersion: provided,
  });
}

export function checkVersion(resource: string, current: number, provided: number | undefined): void {
  if (provided === undefined || provided === null) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, `Не передана версия ресурса «${resource}» (lock_version)`, {
      fields: [{ field: 'lockVersion', message: 'Обязательное поле' }],
    });
  }
  if (current !== provided) {
    throw versionConflict(resource, current, provided);
  }
}

// ─────────────────────────── Разное

export function newKey(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Разбор JSON-полей БД, хранящихся как строки. */
export function jparse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
