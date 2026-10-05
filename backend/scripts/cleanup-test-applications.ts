import { PrismaClient } from '@prisma/client';

/**
 * Удаление заявок, созданных автотестами. Удалить заявку через API нельзя:
 * `DELETE /applications/:number` не предусмотрен, поэтому ui-flows оставляет
 * мусор в базе. Скрипт трогает только организации, имя которых содержит маркер
 * (по умолчанию `UI-CHECK`), и не трогает ничего больше.
 *
 * Запуск: npm run test:cleanup -- [--marker=UI-CHECK]... [--dry-run]
 */
const prisma = new PrismaClient();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const markers = args
  .filter((a) => a.startsWith('--marker='))
  .map((a) => a.slice('--marker='.length).trim())
  .filter(Boolean);

if (markers.length === 0) markers.push('UI-CHECK');
if (markers.some((m) => m.length < 3)) {
  console.error('Отказ: маркер короче 3 символов, слишком широкое совпадение.');
  process.exit(1);
}

const organizations = await prisma.organization.findMany({
  where: { OR: markers.map((m) => ({ name: { contains: m } })) },
  select: { id: true, name: true, _count: { select: { applications: true } } },
});

if (organizations.length === 0) {
  console.log(`Нечего удалять: организации по маркерам ${markers.join(', ')} не найдены.`);
  await prisma.$disconnect();
  process.exit(0);
}

const orgIds = organizations.map((o) => o.id);
const applications = await prisma.application.findMany({
  where: { organizationId: { in: orgIds } },
  select: { id: true, number: true },
});

console.log(`Маркеры: ${markers.join(', ')}${dryRun ? ' (пробный запуск, удалять не буду)' : ''}`);
console.log(`Организаций: ${organizations.length}, заявок в них: ${applications.length}`);
for (const o of organizations) console.log(`  ${o.name} — заявок: ${o._count.applications}`);

if (dryRun) {
  for (const a of applications) console.log(`  было бы удалено: ${a.number}`);
  await prisma.$disconnect();
  process.exit(0);
}

const appIds = applications.map((a) => a.number);

const removed = await prisma.$transaction(async (tx) => {
  const counts = { applications: 0, contacts: 0, organizations: 0 };

  // Эти связи объявлены без onDelete: Cascade, поэтому заявку нельзя удалить,
  // пока они на неё ссылаются. Остальное схема сносит каскадом.
  const dangling = [
    await tx.engineeringConclusion.deleteMany({ where: { applicationId: { in: appIds } } }),
    await tx.mailMessage.deleteMany({ where: { applicationId: { in: appIds } } }),
    await tx.auditEvent.deleteMany({ where: { applicationId: { in: appIds } } }),
    await tx.integrationLink.deleteMany({ where: { applicationId: { in: appIds } } }),
    await tx.outboxMessage.deleteMany({ where: { applicationId: { in: appIds } } }),
  ];

  const delApps = await tx.application.deleteMany({ where: { number: { in: appIds } } });
  counts.applications = delApps.count;

  const delContacts = await tx.contact.deleteMany({ where: { organizationId: { in: orgIds } } });
  counts.contacts = delContacts.count;

  const emptyOrgs = await tx.organization.findMany({
    where: { id: { in: orgIds }, applications: { none: {} } },
    select: { id: true },
  });
  const delOrgs = await tx.organization.deleteMany({
    where: { id: { in: emptyOrgs.map((o) => o.id) } },
  });
  counts.organizations = delOrgs.count;

  return { counts, dangling: dangling.reduce((sum, r) => sum + r.count, 0) };
});

console.log(
  `Удалено: заявок ${removed.counts.applications}, контактов ${removed.counts.contacts}, ` +
    `организаций ${removed.counts.organizations}, прочих связанных записей ${removed.dangling}`,
);

const leftover = await prisma.application.count({ where: { number: { in: appIds } } });
if (leftover > 0) {
  console.error(`Осталось заявок: ${leftover}`);
  process.exitCode = 1;
}

await prisma.$disconnect();