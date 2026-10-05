import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { AppError, ErrorCode } from '../errors.js';
import { ROLE_SCOPE, type Scope } from '../domain/rbac.js';
import type { Principal } from '../domain/scope.js';

// ─────────────────────────── SEC-01: устойчивые хеши паролей

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(plain.normalize('NFKC'), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64!, 'base64');
    const expected = Buffer.from(keyB64!, 'base64');
    const actual = scryptSync(plain.normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ─────────────────────────── Токены сессии

export interface TokenClaims {
  sub: string;
  login: string;
  role: string;
  name: string;
  scope: Scope;
  jti: string;
}

export function issueToken(p: {
  id: string;
  login: string;
  role: string;
  fullName: string;
}): { token: string; expiresIn: number } {
  const scope = ROLE_SCOPE[p.role as keyof typeof ROLE_SCOPE] ?? 'NONE';
  const claims: TokenClaims = {
    sub: p.id,
    login: p.login,
    role: p.role,
    name: p.fullName,
    scope,
    jti: randomBytes(12).toString('hex'),
  };
  const token = jwt.sign(claims, config.jwtSecret, { expiresIn: config.jwtTtlSeconds });
  return { token, expiresIn: config.jwtTtlSeconds };
}

export function verifyToken(token: string): TokenClaims {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (typeof decoded === 'string') throw new Error('bad token');
    const c = decoded as unknown as TokenClaims;
    if (!c.sub || !c.role) throw new Error('bad claims');
    return c;
  } catch {
    throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Сессия недействительна или истекла. Войдите заново.');
  }
}

export function claimsToPrincipal(c: TokenClaims): Principal {
  return { id: c.sub, login: c.login, role: c.role, fullName: c.name, scope: c.scope };
}

// ─────────────────────────── SEC-02: DEV-заголовки отключены в production

export const DEV_HEADERS = ['x-uniprom-api-key', 'x-user-id'] as const;

export function assertNoDevHeaders(headers: Record<string, unknown>): void {
  if (config.allowDevHeaders) return;
  for (const h of DEV_HEADERS) {
    if (headers[h] !== undefined) {
      throw new AppError(
        400,
        ErrorCode.FORBIDDEN,
        `Заголовок ${h} не является рабочей аутентификацией и отключён в production (ТЗ SEC-02).`,
      );
    }
  }
}

// ─────────────────────────── Отпечатки для оптимистической блокировки (API-02)

/** Стабильный отпечаток неизменяемого содержимого версии КП (QUOTE-06/07). */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function fileChecksum(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Отпечаток состава заказа — к нему привязывается разрешение выпуска (GATE-02). */
export function orderCompositionHash(input: {
  termsVersionNo: number;
  amount: number | null;
  currency: string | null;
  lines: { lineId: string; quantity: number; price: number | null }[];
}): string {
  return fingerprint(input);
}
