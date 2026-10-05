import { PrismaClient } from '@prisma/client';

/**
 * Сброс временных блокировок входа: счётчик неудачных попыток и срок блокировки.
 * Нужен после ручной проверки 401/423 или прогона smoke-теста, чтобы seed-пользователи
 * снова могли войти. Скрипт ничего не меняет в данных CRM.
 */
const prisma = new PrismaClient();

const users = await prisma.user.updateMany({
  where: { OR: [{ failedLogins: { gt: 0 } }, { lockedUntil: { not: null } }] },
  data: { failedLogins: 0, lockedUntil: null },
});

const blocked = await prisma.user.count({ where: { blockedAt: { not: null } } });

console.log(`Сброшены блокировки входа: ${users.count}`);
console.log(`Заблокированных учётных записей: ${blocked}`);

await prisma.$disconnect();