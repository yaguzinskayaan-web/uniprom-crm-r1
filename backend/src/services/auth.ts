import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { AppError, ErrorCode } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { hashPassword, issueToken, verifyPassword } from '../lib/auth.js';
import { ROLE_SCOPE, type Scope } from '../domain/rbac.js';
import { normalizeEmail } from './applications.js';

/**
 * SEC-01: пароль хранится в виде устойчивой хеш-функции со случайной солью,
 * вход ограничен по количеству неудачных попыток, блокировка временная.
 * SEC-02: роль и область видимости определяются сервером, клиент их не задаёт.
 */

export interface LoginInput {
  login: string;
  password: string;
  correlationId: string;
  ip?: string | null;
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ login: input.login }, { email: normalizeEmail(input.login) }] },
  });

  // Единый текст для неизвестного пользователя и неверного пароля
  const invalid = () => new AppError(401, ErrorCode.UNAUTHENTICATED, 'Неверный логин или пароль.');

  if (!user) {
    await audit(prisma, {
      serviceAccount: 'AUTH',
      actionCode: AuditAction.LOGIN_FAILED,
      entityType: 'User',
      entityId: 'unknown',
      after: { login: input.login },
      correlationId: input.correlationId,
      ip: input.ip ?? null,
    });
    throw invalid();
  }

  if (user.blockedAt || !user.isActive) {
    await audit(prisma, {
      actor: { id: user.id, login: user.login },
      actionCode: AuditAction.LOGIN_BLOCKED,
      entityType: 'User',
      entityId: user.id,
      after: { blockedAt: user.blockedAt },
      correlationId: input.correlationId,
      ip: input.ip ?? null,
    });
    throw new AppError(403, ErrorCode.USER_BLOCKED, 'Учётная запись заблокирована. Обратитесь к администратору.');
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    throw new AppError(
      423,
      ErrorCode.LOGIN_LIMIT_EXCEEDED,
      `Вход временно ограничен из-за превышения числа попыток. Повторите через ${minutes} мин.`,
    );
  }

  if (!verifyPassword(input.password, user.passwordHash)) {
    const failed = user.failedLogins + 1;
    const shouldLock = failed >= config.maxFailedLogins;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins: failed,
        ...(shouldLock
          ? { lockedUntil: new Date(Date.now() + config.lockoutMinutes * 60_000), failedLogins: 0 }
          : {}),
      },
    });
    await audit(prisma, {
      actor: { id: user.id, login: user.login },
      actionCode: shouldLock ? AuditAction.LOGIN_BLOCKED : AuditAction.LOGIN_FAILED,
      entityType: 'User',
      entityId: user.id,
      after: { failedLogins: failed, locked: shouldLock },
      correlationId: input.correlationId,
      ip: input.ip ?? null,
    });
    if (shouldLock) {
      throw new AppError(
        423,
        ErrorCode.LOGIN_LIMIT_EXCEEDED,
        `Превышено допустимое число попыток входа. Вход ограничен на ${config.lockoutMinutes} мин.`,
      );
    }
    throw invalid();
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  const scope: Scope = ROLE_SCOPE[updated.role as keyof typeof ROLE_SCOPE] ?? 'NONE';
  const { token, expiresIn } = issueToken({
    id: updated.id,
    login: updated.login,
    role: updated.role,
    fullName: updated.fullName,
  });

  await audit(prisma, {
    actor: { id: updated.id, login: updated.login },
    actionCode: AuditAction.LOGIN_SUCCESS,
    entityType: 'User',
    entityId: updated.id,
    after: { role: updated.role, scope },
    correlationId: input.correlationId,
    ip: input.ip ?? null,
  });

  return {
    token,
    tokenType: 'Bearer',
    expiresIn,
    user: { id: updated.id, login: updated.login, fullName: updated.fullName, role: updated.role, scope },
  };
}

export async function logout(userId: string, correlationId: string) {
  await audit(prisma, {
    serviceAccount: userId,
    actionCode: AuditAction.LOGOUT,
    entityType: 'User',
    entityId: userId,
    correlationId,
  });
  return { ok: true };
}

export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  correlationId: string;
}) {
  if (input.newPassword.length < 8) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Пароль должен содержать не менее 8 символов.', {
      fields: [{ field: 'newPassword', message: 'Минимум 8 символов' }],
    });
  }
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'Пользователь не найден');
  if (!verifyPassword(input.currentPassword, user.passwordHash)) {
    throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Текущий пароль указан неверно');
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(input.newPassword) } });
  await audit(prisma, {
    actor: { id: user.id, login: user.login },
    actionCode: AuditAction.PASSWORD_RESET,
    entityType: 'User',
    entityId: user.id,
    correlationId: input.correlationId,
  });
  return { ok: true };
}

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, login: true, fullName: true, role: true, isActive: true, lastLoginAt: true },
  });
  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'Пользователь не найден');
  return { ...user, scope: ROLE_SCOPE[user.role as keyof typeof ROLE_SCOPE] ?? 'NONE' };
}
