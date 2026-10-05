/**
 * Единый HTTP-клиент CRM.
 *
 * Требования, которые закладывает клиент:
 *  • SEC-01/сессия — токен хранится в localStorage и передаётся Bearer;
 *  • истёкшая сессия (401) очищается и приводит к экрану входа;
 *  • ошибки Zod (422) показываются пользователю построчно, а не как «ошибка»;
 *  • correlationId сохраняется для технической поддержки и аудита.
 */

const TOKEN_KEY = 'uniprom.token';

export class ApiError extends Error {
  status: number;
  code: string;
  fields: { field: string; message: string }[];
  details: unknown;

  constructor(status: number, body: Record<string, unknown> | null, fallback: string) {
    const error = (body?.error ?? body) as Record<string, unknown> | undefined;
    const message =
      (typeof error?.message === 'string' && error.message) ||
      (typeof body?.message === 'string' && body.message) ||
      fallback;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = String(error?.code ?? body?.code ?? `HTTP_${status}`);
    const rawFields = (error?.fields ?? body?.fields) as { field?: string; message?: string }[] | undefined;
    this.fields = Array.isArray(rawFields)
      ? rawFields.map((f) => ({ field: String(f.field ?? ''), message: String(f.message ?? '') }))
      : [];
    this.details = error?.details ?? body?.details;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* приватный режим браузера — сессия только в памяти вкладки */
  }
}

export interface RequestOptions {
  body?: unknown;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  signal?: AbortSignal;
  /** Возвращать сырой Response вместо разбора JSON (CSV-выгрузка). */
  raw?: boolean;
}

const listeners = new Set<(expired: boolean) => void>();

/** Подписка на событие «сессия истекла», чтобы приложение вернуло экран входа. */
export function onSessionExpired(fn: (expired: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  // FormData задаёт границы multipart самостоятельно, content-type не указываем.
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body !== undefined && !isFormData) headers['content-type'] = 'application/json';

  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : isFormData ? (options.body as FormData) : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (response.status === 401) {
    setToken(null);
    for (const fn of listeners) fn(true);
  }

  if (options.raw) {
    if (!response.ok) throw new ApiError(response.status, null, `Ошибка запроса ${response.status}`);
    return (await response.text()) as unknown as T;
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text.slice(0, 400) };
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, (parsed ?? null) as Record<string, unknown> | null, `Ошибка запроса ${response.status}`);
  }
  return parsed as T;
}

export const http = {
  get: <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body }),
  /** Загрузка файла: сервер разбирает CSV/XLSX сам (IMP-01). */
  upload: <T>(path: string, form: FormData) => api<T>(path, { method: 'POST', body: form }),
  patch: <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body }),
  del: <T>(path: string, body?: unknown) => api<T>(path, { method: 'DELETE', body }),
  text: (path: string) => api<string>(path, { raw: true }),
};