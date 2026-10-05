/**
 * Начальное наполнение справочников и демонстрационные данные.
 * Запуск: npm run seed  (идемпотентно — повторный запуск обновляет записи)
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/auth.js';
import {
  CLOSING_DOC_TEMPLATES,
  ENG_DECISION_LABELS,
  LOSS_REASON_LABELS,
  PRIORITY_LABELS,
  SOURCES,
  STAGE_LABELS,
  TASK_TYPES,
  type Complexity,
  type Stage,
} from '../src/domain/constants.js';

const prisma = new PrismaClient();

const USERS = [
  { login: 'admin', fullName: 'Ильин Артём Сергеевич', role: 'ADMIN', email: 'admin@uniprom.pro' },
  { login: 'rm.sales', fullName: 'Ковалёва Ольга Николаевна', role: 'SALES_MANAGER', email: 'rm.sales@uniprom.pro' },
  { login: 'sales1', fullName: 'Смирнов Илья Русланович', role: 'SALES', email: 'sales1@uniprom.pro' },
  { login: 'sales2', fullName: 'Егорова Анна Викторовна', role: 'SALES', email: 'sales2@uniprom.pro' },
  { login: 'rm.ko', fullName: 'Николаев Дмитрий Павлович', role: 'DESIGN_MANAGER', email: 'rm.ko@uniprom.pro' },
  { login: 'ko1', fullName: 'Фёдоров Максим Игоревич', role: 'DESIGNER', email: 'ko1@uniprom.pro' },
  { login: 'proizv', fullName: 'Гусева Светлана Юрьевна', role: 'PRODUCTION', email: 'proizv@uniprom.pro' },
  { login: 'viewer', fullName: 'Наблюдатель', role: 'VIEWER', email: 'viewer@uniprom.pro' },
] as const;

const DEFAULT_PASSWORD = 'Uniprom#2026';

const SLA_RULES = [
  {
    code: 'FIRST_RESPONSE',
    name: 'Первичный отклик клиенту',
    stage: 'NEW',
    durationMinutes: 120,
    remindBeforeMinutes: 30,
    usesBusinessHours: true,
    pauseOnCustomerWait: false,
    complexity: 'ANY',
    priority: 'ANY',
  },
  {
    code: 'KO_PREQUOTE',
    name: 'Предварительная проработка КО',
    stage: 'SALES_REVIEW',
    durationMinutes: 1440,
    remindBeforeMinutes: 240,
    usesBusinessHours: true,
    pauseOnCustomerWait: true,
    complexity: 'ANY',
    priority: 'ANY',
  },
  {
    code: 'QUOTE_PREPARATION',
    name: 'Подготовка коммерческого предложения',
    stage: 'CLARIFICATION',
    durationMinutes: 480,
    remindBeforeMinutes: 120,
    usesBusinessHours: true,
    pauseOnCustomerWait: true,
    complexity: 'ANY',
    priority: 'ANY',
  },
  {
    code: 'QUOTE_APPROVAL',
    name: 'Согласование коммерческой версии КП',
    stage: 'QUOTE_PREPARED',
    durationMinutes: 240,
    remindBeforeMinutes: 60,
    usesBusinessHours: true,
    pauseOnCustomerWait: false,
    complexity: 'ANY',
    priority: 'ANY',
  },
  {
    code: 'FOLLOW_UP_CONTACT',
    name: 'Следующий контакт с клиентом',
    stage: 'QUOTE_SENT',
    durationMinutes: 2880,
    remindBeforeMinutes: 480,
    usesBusinessHours: true,
    pauseOnCustomerWait: false,
    complexity: 'ANY',
    priority: 'ANY',
  },
] as const;

async function seedUsers() {
  const passwordHash = hashPassword(DEFAULT_PASSWORD);
  for (const u of USERS) {
    await prisma.user.upsert({
      where: { login: u.login },
      update: { fullName: u.fullName, role: u.role, email: u.email },
      create: { ...u, passwordHash },
    });
  }
  console.log(`Пользователи: ${USERS.length} (пароль ${DEFAULT_PASSWORD})`);
}

async function seedCalendar() {
  await prisma.workCalendar.upsert({
    where: { id: 'work-calendar-default' },
    update: {},
    create: {
      id: 'work-calendar-default',
      name: 'Основной календарь (Екатеринбург)',
      timezone: 'Asia/Yekaterinburg',
      weekdays: JSON.stringify([1, 2, 3, 4, 5]),
      workStart: '09:00',
      workEnd: '18:00',
      holidays: JSON.stringify([]),
      isDefault: true,
    },
  });
  console.log('Календарь рабочего времени: 1');
}

async function seedSlaRules() {
  for (const r of SLA_RULES) {
    await prisma.slaRule.upsert({
      where: { code: r.code },
      update: {
        name: r.name,
        stage: r.stage,
        durationMinutes: r.durationMinutes,
        remindBeforeMinutes: r.remindBeforeMinutes,
        usesBusinessHours: r.usesBusinessHours,
        pauseOnCustomerWait: r.pauseOnCustomerWait,
        complexity: r.complexity,
        priority: r.priority,
        isActive: true,
        versionNo: { increment: 1 },
      },
      create: { ...r },
    });
  }
  console.log(`Нормативы SLA: ${SLA_RULES.length}`);
}

async function seedReferences() {
  const refs: { kind: string; code: string; label: string; order: number }[] = [];

  (Object.keys(STAGE_LABELS) as Stage[]).forEach((code, i) =>
    refs.push({ kind: 'STAGE', code, label: STAGE_LABELS[code], order: i }),
  );
  SOURCES.forEach((code, i) => refs.push({ kind: 'SOURCE', code, label: code, order: i }));
  (Object.keys(PRIORITY_LABELS) as string[]).forEach((code, i) =>
    refs.push({ kind: 'PRIORITY', code, label: PRIORITY_LABELS[code] ?? code, order: i }),
  );
  (Object.keys(LOSS_REASON_LABELS) as (keyof typeof LOSS_REASON_LABELS)[]).forEach((code, i) =>
    refs.push({ kind: 'LOSS_REASON', code, label: LOSS_REASON_LABELS[code], order: i }),
  );
  TASK_TYPES.forEach((code, i) => refs.push({ kind: 'TASK_TYPE', code, label: code, order: i }));
  (Object.keys(ENG_DECISION_LABELS) as (keyof typeof ENG_DECISION_LABELS)[]).forEach((code, i) =>
    refs.push({ kind: 'ENG_DECISION', code, label: ENG_DECISION_LABELS[code], order: i }),
  );
  (['NEEDS_CLASSIFICATION', 'STANDARD', 'MODIFIED', 'CUSTOM'] as Complexity[]).forEach((code, i) =>
    refs.push({ kind: 'COMPLEXITY', code, label: code, order: i }),
  );
  ['NDS_20', 'NDS_10', 'NDS_0', 'NO_NDS'].forEach((code, i) =>
    refs.push({ kind: 'TAX_ATTRIBUTE', code, label: code, order: i }),
  );
  ['RUB', 'USD', 'EUR'].forEach((code, i) => refs.push({ kind: 'CURRENCY', code, label: code, order: i }));
  ['PC', 'PCE', 'M2'].forEach((code, i) => refs.push({ kind: 'UNIT', code, label: code, order: i }));

  for (const r of refs) {
    await prisma.referenceItem.upsert({
      where: { kind_code: { kind: r.kind, code: r.code } },
      update: { label: r.label, sortOrder: r.order, isActive: true },
      create: { kind: r.kind, code: r.code, label: r.label, sortOrder: r.order, isActive: true },
    });
  }
  console.log(`Справочники: ${refs.length}`);
}

async function seedDemoApplication() {
  const existing = await prisma.application.findFirst({ where: { number: 'UPC-2026-00001' } });
  if (existing) {
    console.log('Демонстрационная заявка уже присутствует');
    return;
  }
  const sales = await prisma.user.findUnique({ where: { login: 'sales1' } });
  const org = await prisma.organization.create({
    data: {
      name: 'Уралмаш-Прибор',
      fullName: 'ООО «Уралмаш-Прибор»',
      inn: '6658000000',
      kpp: '665801001',
      address: 'г. Екатеринбург, ул. Машиностроителей, 19',
      normalizedKey: 'INN:6658000000:665801001',
      lockVersion: 1,
    },
  });
  const contact = await prisma.contact.create({
    data: {
      organizationId: org.id,
      fullName: 'Петров Сергей Николаевич',
      position: 'Главный инженер',
      phone: '+7 (343) 300-10-20',
      phoneNormalized: '73433001020',
      email: 's.petrov@uralmash-pribor.ru',
      emailNormalized: 's.petrov@uralmash-pribor.ru',
      isPrimary: true,
      lockVersion: 1,
    },
  });

  await prisma.application.create({
    data: {
      number: 'UPC-2026-00001',
      stage: 'SALES_REVIEW',
      organizationId: org.id,
      contactId: contact.id,
      ownerId: sales?.id ?? null,
      source: 'MANUAL',
      priority: 'NORMAL',
      complexity: 'MODIFIED',
      amount: 480000,
      currency: 'RUB',
      successProbability: 60,
      expectedDecisionDate: new Date(Date.now() + 30 * 86400_000),
      tags: JSON.stringify(['демо', 'Московский ремонт']),
      crmComment: 'Демонстрационная заявка для проверки сценария КП',
      engineQuestions: JSON.stringify({ requiresKo: true, drawingNo: 'ТУ-44-118' }),
      lastActivityAt: new Date(),
      versionNo: 1,
      lockVersion: 1,
      lines: {
        create: [
          {
            lineId: 'L01',
            name: 'Блок питания БП-12У',
            quantity: 4,
            unit: 'шт.',
            price: 90000,
            complexity: 'MODIFIED',
            params: JSON.stringify({ voltage: 12, requiresKo: true }),
            orderQty: 4,
            lockVersion: 1,
          },
          {
            lineId: 'L02',
            name: 'Монтаж и пусконаладка',
            quantity: 1,
            unit: 'усл.',
            price: 120000,
            complexity: 'STANDARD',
            params: JSON.stringify({}),
            orderQty: 1,
            lockVersion: 1,
          },
        ],
      },
    },
  });

  const app = await prisma.application.findUnique({ where: { number: 'UPC-2026-00001' } });
  if (app) {
    const commercial = await prisma.applicationCommercial.create({ data: { applicationId: app.id } });
    for (const d of CLOSING_DOC_TEMPLATES.DEFAULT) {
      await prisma.closingDocument.create({
        data: {
          applicationId: app.id,
          docType: d.docType,
          isRequired: d.required,
          requiresBothSignatures: d.bothSignatures ?? false,
        },
      });
    }
    void commercial;
  }

  const demoApp = await prisma.application.findUniqueOrThrow({ where: { number: 'UPC-2026-00001' } });
  await prisma.crmActivity.create({
    data: {
      applicationId: demoApp.id,
      type: 'SYSTEM',
      direction: 'IN',
      participants: JSON.stringify(['system']),
      occurredAt: new Date(),
      authorId: sales?.id ?? (await prisma.user.findUniqueOrThrow({ where: { login: 'admin' } })).id,
      subject: 'Заявка создана вручную',
      content: 'Демонстрационные данные',
      isCustomerFacing: false,
    },
  });

  console.log('Демонстрационная заявка: UPC-2026-00001');
}

async function main() {
  await seedUsers();
  await seedCalendar();
  await seedSlaRules();
  await seedReferences();
  await seedDemoApplication();
  console.log('Начальные данные загружены.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
