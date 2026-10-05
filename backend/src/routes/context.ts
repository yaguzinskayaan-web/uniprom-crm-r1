import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { AppError, ErrorCode } from '../errors.js';
import type { Principal } from '../domain/scope.js';

export interface RouteContext {
  principal: Principal;
  correlationId: string;
}

/** Прехендлер, требующий действующей сессии. Роль и область берутся из БД. */
export function requireAuth(): preHandlerHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    await req.server.requireAuth(req, _reply);
  };
}

export function ctx(req: FastifyRequest): RouteContext {
  if (!req.principal) {
    throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Требуется вход в систему');
  }
  return { principal: req.principal, correlationId: req.correlationId };
}

/**
 * Идентификатор корреляции для методов интеграции: сессии пользователя у них
 * нет, авторизация выполняется по токену интеграции.
 */
export function correlationOf(req: FastifyRequest): string {
  return req.correlationId;
}

export function noop(_app: FastifyInstance): void {
  // заглушка не используется
}
