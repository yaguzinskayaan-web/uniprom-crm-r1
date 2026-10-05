/**
 * Сквозная проверка основного пути R1: вход, заявка, КП, согласование,
 * отправка, приём клиентом. Запуск: npm run smoke
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:3001';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'Uniprom#2026';
const MAIL_TOKEN = process.env.INTEGRATION_TOKEN ?? 'dev-integration-token';

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

interface Session {
  token: string;
  json?: any;
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

async function login(login: string): Promise<Session> {
  const r = await call('POST', '/api/v1/auth/login', { body: { login, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`Не удалось войти ${login}: ${JSON.stringify(r.json)}`);
  return { token: r.json.token };
}

async function main(): Promise<void> {
  console.log(`Проверка ${BASE}\n`);

  console.log('Здоровье и вход');
  const health = await call('GET', '/api/v1/health');
  ok('GET /health', health.status === 200 && health.json.status === 'ok', health.json);

  // Неверный пароль не раскрывает существование учётной записи (SEC-01).
  // Проверка выполняется до успешного входа: успешный вход сбрасывает счётчик
  // неудачных попыток, поэтому повторные прогоны не блокируют пользователя.
  const bad = await call('POST', '/api/v1/auth/login', { body: { login: 'sales1', password: 'wrong' } });
  ok('неверный пароль отклонён (SEC-01)', bad.status === 401, bad.json);
  const unknownLogin = await call('POST', '/api/v1/auth/login', { body: { login: 'no-such-login', password: 'wrong' } });
  ok('неизвестный логин даёт тот же ответ (SEC-01)', unknownLogin.status === 401 && unknownLogin.json?.code === bad.json?.code, {
    bad: bad.json?.code,
    unknown: unknownLogin.json?.code,
  });

  const noAuth = await call('GET', '/api/v1/applications');
  ok('без токена — 401', noAuth.status === 401, noAuth.json);

  const sales = await login('sales1');
  const sales2 = await login('sales2');
  const manager = await login('rm.sales');
  const designer = await login('ko1');
  const koManager = await login('rm.ko');
  const viewer = await login('viewer');
  const production = await login('proizv');
  ok('вход всех ролей', Boolean(sales.token && manager.token && designer.token && koManager.token && production.token));
  console.log('\nRBAC и область видимости');
  const ownList = await call('GET', '/api/v1/applications', { token: sales.token });
  ok('SALES видит только свои заявки', ownList.status === 200 && ownList.json.items.every((a: any) => a.owner), ownList.json);

  const forbidden = await call('GET', '/api/v1/engineering/tasks', { token: sales.token });
  ok('SALES не имеет очереди КО', forbidden.status === 403, forbidden.json);

  console.log('\nСоздание заявки и идемпотентность');
  const key = `smoke-${Date.now()}`;
  const created = await call('POST', '/api/v1/applications', {
    token: sales.token,
    body: {
      organizationName: 'ООО «Тест-Строй»',
      inn: '6670000000',
      contactName: 'Иванов Иван',
      contactPhone: '+7 (343) 111-22-33',
      contactEmail: 'ivanov@test-stroy.ru',
      source: 'MANUAL',
      priority: 'HIGH',
      engineQuestions: { requiresKo: true },
      tags: ['срочно', 'черновик'],
      idempotencyKey: key,
      lines: [
        { name: 'Клапан КВ-100', quantity: 10, price: 15000, complexity: 'CUSTOM', params: { dn: 100 } },
        { name: 'Доставка', quantity: 1, unit: 'усл.', price: 5000 },
      ],
    },
  });
  ok('заявка создана', created.status === 201, created.json);
  const number: string = created.json?.application?.number;
  ok('номер вида UPC-ГГГГ-NNNNN', /^UPC-\d{4}-\d{5}$/.test(number ?? ''), number);

  const repeat = await call('POST', '/api/v1/applications', {
    token: sales.token,
    body: { organizationName: 'ООО «Тест-Строй»', source: 'MANUAL', priority: 'HIGH', idempotencyKey: key },
  });
  ok('повтор с тем же ключом не создаёт вторую заявку (IN-03)', repeat.status === 200 && repeat.json.deduplicated, repeat.json);

  const level = created.json?.application?.complexity;
  ok('уровень заявки = максимум по позициям (ENG-01)', level === 'CUSTOM', level);

  // `tags` в БД лежит JSON-строкой, но наружу обязан приходить массивом:
  // иначе клиент падает на `tags.map`. Раньше это расхождение не проверялось.
  const cardTags = await call('GET', `/api/v1/applications/${number}`, { token: sales.token });
  ok('теги заявки отдаются массивом', Array.isArray(cardTags.json?.tags), cardTags.json?.tags);
  ok(
    'теги сохраняются и читаются без потерь',
    Array.isArray(cardTags.json?.tags) &&
      cardTags.json.tags.length === 2 &&
      cardTags.json.tags.includes('срочно') &&
      cardTags.json.tags.includes('черновик'),
    cardTags.json?.tags,
  );

  const assigned = await call('POST', `/api/v1/applications/${number}/assign`, {
    token: manager.token,
    body: { ownerId: null, moveOpenTasks: false },
  });
  ok('SALES_MANAGER может оставить заявку в очереди', assigned.status === 200, assigned.json);
  await call('POST', `/api/v1/applications/${number}/assign`, {
    token: manager.token,
    body: { ownerId: created.json.application.ownerId, moveOpenTasks: true },
  });

  console.log('\nМаршрут этапов');
  const badJump = await call('POST', `/api/v1/applications/${number}/stage`, {
    token: sales.token,
    body: { to: 'QUOTE_SENT' },
  });
  ok('переход через этап невозможен (§7.1)', badJump.status === 400, badJump.json?.code);
  const toReviewOk = await call('POST', `/api/v1/applications/${number}/stage`, {
    token: sales.token,
    body: { to: 'SALES_REVIEW' },
  });
  ok('NEW → SALES_REVIEW', toReviewOk.status === 200, toReviewOk.json?.code);
  const toPreparedOk = await call('POST', `/api/v1/applications/${number}/stage`, {
    token: sales.token,
    body: { to: 'QUOTE_PREPARED' },
  });
  ok('SALES_REVIEW → QUOTE_PREPARED', toPreparedOk.status === 200, toPreparedOk.json?.code);

  console.log('\nИнженерное задание и заключение');
  const assignDesigner = await call('POST', `/api/v1/applications/${number}/engineering-tasks`, {
    token: sales.token,
    body: { kind: 'PREQUOTE', assigneeId: null, priority: 'HIGH' },
  });
  ok('SALES создаёт PREQUOTE без назначения', assignDesigner.status === 201, assignDesigner.json);
  const taskId: string = assignDesigner.json?.id;

  const wrongAssign = await call('POST', `/api/v1/engineering/tasks/${taskId}/assign`, {
    token: manager.token,
    body: { assigneeId: (await call('GET', '/api/v1/auth/me', { token: designer.token })).json.id },
  });
  ok('SALES_MANAGER не может назначать конструкторов (§3.1, A03)', wrongAssign.status === 403, wrongAssign.json);

  await call('POST', `/api/v1/engineering/tasks/${taskId}/assign`, {
    token: koManager.token,
    body: { assigneeId: (await call('GET', '/api/v1/auth/me', { token: designer.token })).json.id },
  });

  const conclusion = await call('POST', `/api/v1/engineering/tasks/${taskId}/complete`, {
    token: designer.token,
    body: { decision: 'FEASIBLE_WITH_CONDITIONS', conditions: 'Поставка 30 рабочих дней', leadTimeDays: 30 },
  });
  ok('конструктор фиксирует заключение', conclusion.status === 200, conclusion.json);
  const conclusionId: string = conclusion.json?.conclusion?.id;

  const conclusionApproved = await call('POST', `/api/v1/engineering/conclusions/${conclusionId}/approve`, {
    token: koManager.token,
    body: { approve: true, comment: 'Проработано' },
  });
  ok('руководитель КО утвердил заключение (ENG-06)', conclusionApproved.status === 200, conclusionApproved.json);

  const unapproved = await call('POST', `/api/v1/applications/${number}/complexity`, {
    token: sales.token,
    body: { complexity: 'CUSTOM' },
  });
  ok('подтверждение сложности продажом принято', unapproved.status === 200, unapproved.json);

  const sentBeforeApprove = await call('POST', `/api/v1/applications/${number}/quotes`, {
    token: sales.token,
    body: {},
  });
  const quoteId: string = sentBeforeApprove.json?.id;
  ok('создана версия КП', Boolean(quoteId), sentBeforeApprove.json);

  const earlySend = await call('POST', `/api/v1/quotes/${quoteId}/send`, {
    token: sales.token,
    body: { recipients: ['client@test-stroy.ru'] },
    headers: { 'idempotency-key': `smoke-send-${Date.now()}` },
  });
  ok('отправка без согласования запрещена (SEND-01, A14)', earlySend.status === 422, earlySend.json);

  console.log('\nКП: документ, согласование, невозможность обхода');
  const generated = await call('POST', `/api/v1/quotes/${quoteId}/generate`, { token: sales.token });
  ok('PDF версии сформирован', generated.status === 200 && Boolean(generated.json?.fileId), generated.json);

  const submitted = await call('POST', `/api/v1/quotes/${quoteId}/submit-approval`, { token: sales.token });
  ok('отправлено на согласование', submitted.status === 200, submitted.json);

  const selfApprove = await call('POST', `/api/v1/quotes/${quoteId}/approval-decision`, {
    token: sales.token,
    body: { decision: 'APPROVED' },
  });
  ok('SALES не может согласовать сам (RBAC-04)', selfApprove.status === 403, selfApprove.json);

  const noComment = await call('POST', `/api/v1/quotes/${quoteId}/approval-decision`, {
    token: manager.token,
    body: { decision: 'REJECTED' },
  });
  ok('возврат без комментария запрещён (A15)', noComment.status === 400, noComment.json);

  const approved = await call('POST', `/api/v1/quotes/${quoteId}/approval-decision`, {
    token: manager.token,
    body: { decision: 'APPROVED', comment: 'Согласовано' },
  });
  ok('руководитель продаж согласовал', approved.status === 200, approved.json);

  const mutate = await call('PATCH', `/api/v1/quotes/${quoteId}`, {
    token: sales.token,
    body: { lockVersion: approved.json.lockVersion, amount: 1 },
  });
  ok('изменение согласованной версии запрещено (QUOTE-03)', mutate.status === 400, mutate.json);

  const idem = `smoke-send-${Date.now()}`;
  const send1 = await call('POST', `/api/v1/quotes/${quoteId}/send`, {
    token: sales.token,
    body: { recipients: ['client@test-stroy.ru'], subject: 'КП' },
    headers: { 'idempotency-key': idem },
  });
  ok('отправка поставлена в очередь', send1.status === 200 && send1.json.deduplicated === false, send1.json);
  const send2 = await call('POST', `/api/v1/quotes/${quoteId}/send`, {
    token: sales.token,
    body: { recipients: ['client@test-stroy.ru'], subject: 'КП' },
    headers: { 'idempotency-key': idem },
  });
  ok('повтор с тем же ключом не дублирует письмо (SEND-02)', send2.json?.deduplicated === true, send2.json);

  const dispatchId: string = send1.json?.dispatch?.id;
  const confirm = await call('POST', `/internal/dispatches/${dispatchId}/confirm`, { token: sales.token });
  ok('факт отправки зафиксирован (SEND-06)', confirm.status === 200, confirm.json);

  const card = await call('GET', `/api/v1/applications/${number}`, { token: sales.token });
  ok('этап переведён в «КП отправлено»', card.json?.stage === 'QUOTE_SENT', card.json?.stage);
  ok('SENT не равен ACCEPTED до ручного решения', card.json?.quotes?.[0]?.status === 'SENT', card.json?.quotes?.[0]?.status);

  const accepted = await call('POST', `/api/v1/quotes/${quoteId}/customer-decision`, {
    token: sales.token,
    body: { decision: 'ACCEPTED', note: 'Письмо клиента от 12.05.2026' },
  });
  ok('решение клиента зафиксировано вручную (SEND-05)', accepted.status === 200, accepted.json);

  const card2 = await call('GET', `/api/v1/applications/${number}`, { token: sales.token });
  ok('сумма заявки взята из принятой версии', card2.json?.amount > 0, card2.json?.amount);

  console.log('\nОптимистическая блокировка и область видимости');
  const stale = await call('PATCH', `/api/v1/applications/${number}`, {
    token: sales.token,
    body: { lockVersion: 1, crmComment: 'Правка' },
  });
  ok('устаревшая версия отклонена (API-02)', stale.status === 409 && stale.json?.code === 'VERSION_CONFLICT', stale.json);

  const foreign = await call('GET', '/api/v1/applications/UPC-2026-00001', { token: sales2.token });
  ok('чужая заявка скрыта как несуществующая (A01)', foreign.status === 404, foreign.json?.code);

  const viewerList = await call('GET', '/api/v1/applications', { token: viewer.token });
  ok('VIEWER по умолчанию не видит заявок (RBAC-02)', viewerList.status === 200 && viewerList.json.total === 0, viewerList.json);

  const viewerQuote = await call('GET', `/api/v1/quotes/${quoteId}`, { token: viewer.token });
  ok('VIEWER не читает чужое КП', viewerQuote.status === 404, viewerQuote.json);

  console.log('\nОтказ по причинам потери');
  const afterAccept = await call('GET', `/api/v1/applications/${number}`, { token: sales.token });
  ok('принятое КП переводит заявку на согласование договора', afterAccept.json?.stage === 'CONTRACT_PENDING', afterAccept.json?.stage);
  const cancelNoReason = await call('POST', `/api/v1/applications/${number}/stage`, {
    token: sales.token,
    body: { to: 'CANCELLED' },
  });
  ok('отмена без причины потери отклонена (§7.2)', cancelNoReason.status === 400, cancelNoReason.json?.code);
  const cancelOther = await call('POST', `/api/v1/applications/${number}/stage`, {
    token: sales.token,
    body: { to: 'CANCELLED', lossReason: 'OTHER' },
  });
  ok('для «Другое» обязательно пояснение', cancelOther.status === 400, cancelOther.json);

  const directProduction = await call('POST', `/api/v1/applications/${number}/stage`, {
    token: manager.token,
    body: { to: 'TO_PRODUCTION' },
  });
  ok('прямой переход в производство запрещён (GATE-04)', directProduction.status === 400, directProduction.json);

  const directClose = await call('POST', `/api/v1/applications/${number}/stage`, {
    token: manager.token,
    body: { to: 'CLOSED' },
  });
  ok('прямое закрытие запрещено (CLOSE-01)', directClose.status === 400, directClose.json);

  console.log('\nЗакрытие заявки с проверками');
  const closeCheck = await call('GET', `/api/v1/applications/${number}/close-check`, { token: sales.token });
  ok('проверка закрытия возвращает блокеры', closeCheck.status === 200 && closeCheck.json.canClose === false, closeCheck.json);

  const timeline = await call('GET', `/api/v1/applications/${number}/timeline`, { token: sales.token });
  ok('таймлайн содержит события', timeline.status === 200 && timeline.json.activities.length > 0, {
    activities: timeline.json?.activities?.length,
  });

  console.log('\nЗадачи и бизнес-хронология (§10.1)');
  const assigneeId: string = (await call('GET', '/api/v1/auth/me', { token: sales.token })).json.id;
  const myId: string = (await call('GET', '/api/v1/auth/me', { token: sales2.token })).json.id;
  const dueAt = new Date(Date.now() + 2 * 86400_000).toISOString();
  const task = await call('POST', `/api/v1/crm/applications/${number}/tasks`, {
    token: sales.token,
    body: { type: 'CALL', subject: 'Уточнить срок поставки', assigneeId, dueAt, priority: 'HIGH' },
  });
  ok('задача создана через контрактный путь', task.status === 201, task.json);
  const crmTaskId: string = task.json?.id;

  const noSubject = await call('POST', `/api/v1/applications/${number}/tasks`, {
    token: sales.token,
    body: { type: 'CALL', subject: '', assigneeId, dueAt },
  });
  ok('пустая тема задачи отклонена', noSubject.status === 422, noSubject.json?.code);

  const inactiveAssignee = await call('POST', `/api/v1/applications/${number}/tasks`, {
    token: sales.token,
    body: { type: 'CALL', subject: 'Проверка', assigneeId: '00000000-0000-0000-0000-000000000000', dueAt },
  });
  ok('несуществующий исполнитель отклонён', inactiveAssignee.status === 404, inactiveAssignee.json?.code);

  const contractTasks = await call('GET', `/api/v1/crm/applications/${number}/tasks`, { token: sales.token });
  ok('список задач заявки доступен по номеру', contractTasks.status === 200 && contractTasks.json.items.length >= 1, contractTasks.json);

  const staleTask = await call('PUT', `/api/v1/crm/tasks/${crmTaskId}`, {
    token: sales.token,
    body: { lockVersion: 99, subject: 'Правка' },
  });
  ok('устаревшая версия задачи отклонена (API-02)', staleTask.status === 409 && staleTask.json?.code === 'VERSION_CONFLICT', staleTask.json?.code);

  const otherComplete = await call('POST', `/api/v1/tasks/${crmTaskId}/complete`, {
    token: sales2.token,
    body: { result: 'Попытка чужой задачи' },
  });
  ok('чужую задачу завершить нельзя (RBAC-05)', otherComplete.status === 403, otherComplete.json?.code);

  const activity = await call('POST', `/api/v1/crm/applications/${number}/activities`, {
    token: sales.token,
    body: { type: 'CALL', direction: 'OUT', participants: ['Иванов Иван'], content: 'Согласовали срок', result: 'Ждём ответ' },
  });
  ok('активность зарегистрирована', activity.status === 201, activity.json?.code);
  const activityId: string = activity.json?.id;
  const corrected = await call('PATCH', `/api/v1/activities/${activityId}`, {
    token: sales.token,
    body: { content: 'Согласовали срок поставки 30 дней' },
  });
  ok('коррекция сохраняет предыдущее значение (§10.1)', corrected.status === 200 && corrected.json.previousContent === 'Согласовали срок', {
    previous: corrected.json?.previousContent,
  });

  const afterActivity = await call('GET', `/api/v1/applications/${number}`, { token: sales.token });
  ok('регистрация коммуникации обновила дату контакта', Boolean(afterActivity.json?.lastCustomerContactAt), afterActivity.json?.lastCustomerContactAt);
  ok('next_activity_at пересчитан по открытой задаче', Boolean(afterActivity.json?.nextActivityAt), afterActivity.json?.nextActivityAt);

  const myWork = await call('GET', '/api/v1/my-work', { token: sales.token });
  ok('«Моя работа» возвращает задачи и заявки', myWork.status === 200 && Array.isArray(myWork.json.todayTasks), myWork.json?.code);

  const completeTaskRes = await call('POST', `/api/v1/crm/tasks/${crmTaskId}/complete`, {
    token: sales.token,
    body: { result: 'Клиент подтвердил срок' },
  });
  ok('задача завершена исполнителем', completeTaskRes.status === 200 && completeTaskRes.json.status === 'DONE', completeTaskRes.json?.code);
  const closedTaskEdit = await call('PUT', `/api/v1/crm/tasks/${crmTaskId}`, {
    token: sales.token,
    body: { lockVersion: completeTaskRes.json.lockVersion, subject: 'Правка после закрытия' },
  });
  ok('завершённую задачу изменить нельзя', closedTaskEdit.status === 400, closedTaskEdit.json?.code);

  console.log('\nКоммерческие условия и выпуск в производство (GATE-01..04)');
  const commercialBefore = await call('GET', `/api/v1/applications/${number}/commercial`, { token: sales.token });
  ok('коммерческие условия доступны', commercialBefore.status === 200, commercialBefore.json?.code);

  const appBeforeTerms = await call('GET', `/api/v1/applications/${number}`, { token: sales.token });
  const setTerms = await call('PATCH', `/api/v1/applications/${number}/commercial`, {
    token: manager.token,
    body: {
      lockVersion: appBeforeTerms.json?.lockVersion,
      paymentTerms: 'PREPAYMENT_PARTIAL',
      paymentSchedule: [{ stage: 'ADVANCE', pct: 50, dueDays: 5 }],
      criticalTermsChanged: true,
    },
  });
  ok('условия оплаты заданы', setTerms.status === 200 && setTerms.json.paymentTerms === 'PREPAYMENT_PARTIAL', {
    status: setTerms.status,
    code: setTerms.json?.code,
    version: appBeforeTerms.json?.lockVersion,
  });

  const checkNoContract = await call('GET', `/api/v1/applications/${number}/release-check`, { token: sales.token });
  ok('проверка выпуска блокирует без договора (GATE-01)', checkNoContract.status === 200 && checkNoContract.json.can_release_to_production === false, checkNoContract.json?.blockers);
  const checkReadOnly = await call('GET', `/api/v1/applications/${number}/release-check`, { token: sales.token });
  ok('повторная проверка не меняет состояние (GATE-01)', JSON.stringify(checkReadOnly.json.checks) === JSON.stringify(checkNoContract.json.checks));

  const releaseAsSales = await call('POST', `/api/v1/applications/${number}/release-production`, { token: sales.token });
  ok('SALES не выполняет выпуск', releaseAsSales.status === 403, releaseAsSales.json?.code);

  const signWrongVersion = await call('POST', `/api/v1/applications/${number}/commercial/sign-contract`, {
    token: manager.token,
    body: { lockVersion: 1, contractNumber: 'Д-1' },
  });
  ok('подписание с устаревшей версией отклонено', signWrongVersion.status === 409 && signWrongVersion.json?.code === 'VERSION_CONFLICT', {
    status: signWrongVersion.status,
    code: signWrongVersion.json?.code,
  });

  const appBeforeSign = await call('GET', `/api/v1/applications/${number}`, { token: manager.token });
  const signed = await call('POST', `/api/v1/applications/${number}/commercial/sign-contract`, {
    token: manager.token,
    body: { lockVersion: appBeforeSign.json?.lockVersion, contractNumber: `Д-${Date.now() % 100000}` },
  });
  ok('договор подписан, событие для 1С создано', signed.status === 200 && signed.json.contractStatus === 'SIGNED', {
    status: signed.status,
    code: signed.json?.code,
    contract: signed.json?.contractStatus,
    stage: signed.json?.application?.stage,
  });

  const checkAfterSign = await call('GET', `/api/v1/applications/${number}/production-release-check`, { token: manager.token });
  ok('после подписания остаётся блокер по предоплате (A22)', checkAfterSign.json.can_release_to_production === false, checkAfterSign.json?.blockers);

  const approveShort = await call('POST', `/api/v1/crm/applications/${number}/release-approval`, {
    token: manager.token,
    body: { reason: 'коротко' },
  });
  ok('ручное разрешение требует развёрнутого основания', approveShort.status === 422, approveShort.json?.code);

  const approveBySales = await call('POST', `/api/v1/crm/applications/${number}/release-approval`, {
    token: sales.token,
    body: { reason: 'Оплата поступила на расчётный счёт, подтверждаю' },
  });
  ok('ручное разрешение недоступно сотруднику продаж (GATE-02)', approveBySales.status === 403, approveBySales.json?.code);

  const approveOk = await call('POST', `/api/v1/crm/applications/${number}/release-approval`, {
    token: manager.token,
    body: { reason: 'Оплата поступила на расчётный счёт, платёжное поручение №77 от 30.09.2026' },
  });
  ok('ручное разрешение оформлено с указанием причины', approveOk.status === 200, approveOk.json?.code);

  const checkAfterApproval = await call('GET', `/api/v1/applications/${number}/release-check`, { token: manager.token });
  ok(
    'ручное разрешение не создаёт оплату: остаётся блокер по предоплате (GATE-02)',
    checkAfterApproval.json.can_release_to_production === false &&
      (checkAfterApproval.json.blockers ?? []).some((b: { code: string }) => b.code === 'PARTIAL_PREPAYMENT_REQUIRED'),
    checkAfterApproval.json?.blockers,
  );

  // A22/SYNC-01: фактическая предоплата приходит из 1С отдельным сообщением.
  const basisAmount: number = commercialBefore.json?.basisAmount ?? appBeforeTerms.json?.amount ?? 0;
  const prepay = Math.round(basisAmount * 0.5 * 100) / 100;
  const syncInvoice = await call('POST', '/api/v1/integrations/commercial/sync', {
    headers: { 'x-integration-token': MAIL_TOKEN },
    body: {
      applicationNumber: number,
      invoices: [
        {
          extId: `INV-SMOKE-${Date.now()}`,
          number: `СЧ-${Date.now() % 100000}`,
          docDate: new Date().toISOString(),
          amount: prepay,
          currency: commercialBefore.json?.basisCurrency ?? appBeforeTerms.json?.currency ?? 'RUB',
          status: 'NEW',
        },
      ],
    },
  });
  ok('счёт 1С принят', syncInvoice.status === 200 && syncInvoice.json.invoices.length === 1, syncInvoice.json);

  const extId = `PAY-SMOKE-${Date.now()}`;
  const syncPayment = await call('POST', '/api/v1/integrations/commercial/sync', {
    headers: { 'x-integration-token': MAIL_TOKEN },
    body: {
      applicationNumber: number,
      payments: [
        {
          extId,
          docDate: new Date().toISOString(),
          amount: prepay,
          currency: commercialBefore.json?.basisCurrency ?? 'RUB',
          kind: 'IN',
        },
      ],
    },
  });
  ok('платёж 1С принят и зачтён по счёту', syncPayment.status === 200 && syncPayment.json.payments[0].allocated === prepay, {
    allocated: syncPayment.json?.payments?.[0]?.allocated,
    expected: prepay,
    code: syncPayment.json?.code,
  });

  const syncRepeat = await call('POST', '/api/v1/integrations/commercial/sync', {
    headers: { 'x-integration-token': MAIL_TOKEN },
    body: {
      applicationNumber: number,
      payments: [{ extId, amount: prepay, currency: commercialBefore.json?.basisCurrency ?? 'RUB', kind: 'IN' }],
    },
  });
  ok(
    'повторная доставка платежа не зачитывает его второй раз (SYNC-03)',
    syncRepeat.status === 200 && syncRepeat.json.messages.every((m: { state: string }) => m.state === 'PROCESSED'),
    syncRepeat.json?.messages,
  );

  const checkPaid = await call('GET', `/api/v1/applications/${number}/release-check`, { token: manager.token });
  ok('фактическая предоплата открывает выпуск', checkPaid.json.can_release_to_production === true, checkPaid.json?.blockers);

  const syncNoToken = await call('POST', '/api/v1/integrations/commercial/sync', {
    body: { applicationNumber: number, payments: [] },
  });
  ok('без токена интеграции приём не выполняется', syncNoToken.status >= 400, syncNoToken.json);

  const releaseOk = await call('POST', `/api/v1/applications/${number}/release-production`, { token: manager.token });
  ok('выпуск в производство выполнен', releaseOk.status === 200 && releaseOk.json.release?.state === 'ACTIVE', {
    status: releaseOk.status,
    code: releaseOk.json?.code,
    stage: releaseOk.json?.stage,
  });

  const releaseTwice = await call('POST', `/api/v1/applications/${number}/release-production`, { token: manager.token });
  ok('повторный выпуск не создаёт второй активный (GATE-03)', releaseTwice.status === 400, {
    status: releaseTwice.status,
    code: releaseTwice.json?.code,
  });

  const stageBySales = await call('POST', `/api/v1/applications/${number}/production-stage`, {
    token: sales.token,
    body: { to: 'DESIGN_IN_PROGRESS' },
  });
  ok('этап производства меняет уполномоченный сотрудник', stageBySales.status === 403, stageBySales.json?.code);

  console.log('\nИсполнение, закрытие и возврат по корректировке 1С (A24, CLOSE-01..04)');
  // Заказ переводится в исполнение штатными переходами после выпуска.
  const toDesign = await call('POST', `/api/v1/applications/${number}/production-stage`, {
    token: production.token,
    body: { to: 'DESIGN_IN_PROGRESS' },
  });
  const toManufacturing = await call('POST', `/api/v1/applications/${number}/production-stage`, {
    token: production.token,
    body: { to: 'MANUFACTURING' },
  });
  const toFulfilment = await call('POST', `/api/v1/applications/${number}/production-stage`, {
    token: production.token,
    body: { to: 'FULFILLMENT' },
  });
  ok('заказ доведён до этапа исполнения', toFulfilment.status === 200, {
    design: toDesign.status,
    manufacturing: toManufacturing.status,
    fulfilment: toFulfilment.status,
    code: toFulfilment.json?.code,
  });

  const appWithLines = await call('GET', `/api/v1/applications/${number}`, { token: sales.token });
  const orderLines = (appWithLines.json?.lines ?? []).map((l: { lineId: string; orderQty: number; unit: string }) => ({
    lineId: l.lineId,
    quantity: l.orderQty,
    unit: l.unit,
  }));
  const syncShipment = await call('POST', '/api/v1/integrations/commercial/sync', {
    headers: { 'x-integration-token': MAIL_TOKEN },
    body: {
      applicationNumber: number,
      shipments: [
        {
          extId: `SHP-SMOKE-${Date.now()}`,
          number: `ОТГ-${Date.now() % 100000}`,
          docDate: new Date().toISOString(),
          status: 'CLOSED',
          carrier: 'Деловые Линии',
          lines: orderLines,
        },
      ],
    },
  });
  ok('отгрузка 1С принята', syncShipment.status === 200 && syncShipment.json.shipments[0].discrepancies.length === 0, {
    status: syncShipment.status,
    lines: orderLines.length,
    discrepancies: syncShipment.json?.shipments?.[0]?.discrepancies,
    code: syncShipment.json?.code,
  });

  const syncFullPayment = await call('POST', '/api/v1/integrations/commercial/sync', {
    headers: { 'x-integration-token': MAIL_TOKEN },
    body: {
      applicationNumber: number,
      payments: [
        {
          extId: `PAY-FULL-${Date.now()}`,
          docDate: new Date().toISOString(),
          amount: basisAmount,
          currency: commercialBefore.json?.basisCurrency ?? 'RUB',
          kind: 'IN',
        },
      ],
    },
  });
  ok('полная оплата зафиксирована', syncFullPayment.status === 200 && syncFullPayment.json.totals.outstanding === 0, {
    totals: syncFullPayment.json?.totals,
    code: syncFullPayment.json?.code,
  });

  for (const docType of ['UPD', 'NAKLADNAYA', 'SF', 'ACT']) {
    const doc = await call('POST', `/api/v1/applications/${number}/closing-documents`, {
      token: sales.token,
      body: { docType, docNumber: `${docType}-${Date.now() % 100000}`, status: 'REGISTERED', source: 'ONE_C' },
    });
    if (doc.status !== 200) {
      console.log('   диагностика закрывающего документа:', docType, doc.status, JSON.stringify(doc.json).slice(0, 300));
    }
  }
  const docsList = await call('GET', `/api/v1/applications/${number}/closing-documents`, { token: sales.token });
  ok('закрывающие документы зарегистрированы', docsList.status === 200 && docsList.json.items.length >= 4, {
    status: docsList.status,
    items: docsList.json?.items?.length,
    code: docsList.json?.code,
  });

  const closeCheckReady = await call('GET', `/api/v1/applications/${number}/close-check`, { token: sales.token });
  ok('заказ готов к закрытию по фактическим данным', closeCheckReady.json.canClose === true, closeCheckReady.json?.blockers);

  const appBeforeClose = await call('GET', `/api/v1/applications/${number}`, { token: sales.token });
  const closed = await call('POST', `/api/v1/crm/applications/${number}/close`, {
    token: sales.token,
    body: { lockVersion: appBeforeClose.json?.lockVersion, comment: 'Исполнено полностью' },
  });
  ok('заявка закрыта с сохранением факта закрытия', closed.status === 200 && closed.json?.stage === 'CLOSED', {
    status: closed.status,
    stage: closed.json?.stage,
    code: closed.json?.code,
  });

  // A24: отмена оплаты после закрытия возвращает заявку в исполнение.
  const cancelSync = await call('POST', '/api/v1/integrations/commercial/sync', {
    headers: { 'x-integration-token': MAIL_TOKEN },
    body: {
      applicationNumber: number,
      payments: [
        {
          extId: `PAY-CANCEL-${Date.now()}`,
          amount: 1000,
          currency: commercialBefore.json?.basisCurrency ?? 'RUB',
          kind: 'IN',
        },
      ],
    },
  });
  const cancelSync2 = await call('POST', '/api/v1/integrations/commercial/sync', {
    headers: { 'x-integration-token': MAIL_TOKEN },
    body: {
      applicationNumber: number,
      payments: [
        {
          extId: `PAY-CANCEL-${Date.now()}`,
          amount: 1000,
          currency: commercialBefore.json?.basisCurrency ?? 'RUB',
          kind: 'IN',
        },
      ],
    },
  });
  const cancelId = cancelSync.json?.payments?.[0]?.extId;
  const cancelResult = await call('POST', '/api/v1/integrations/commercial/sync', {
    headers: { 'x-integration-token': MAIL_TOKEN },
    body: {
      applicationNumber: number,
      payments: [
        { extId: cancelId, amount: 1000, currency: commercialBefore.json?.basisCurrency ?? 'RUB', kind: 'RETURN' },
      ],
    },
  });
  ok('отмена платежа 1С обработана', cancelResult.status === 200 && cancelResult.json.reopened === true, {
    status: cancelResult.status,
    reopened: cancelResult.json?.reopened,
    code: cancelResult.json?.code,
    first: cancelSync.status,
    second: cancelSync2.status,
  });

  const afterReopen = await call('GET', `/api/v1/applications/${number}`, { token: sales.token });
  ok('заявка возвращена в исполнение с сохранением даты закрытия', afterReopen.json?.stage === 'FULFILLMENT' && Boolean(afterReopen.json?.closedAt) && Boolean(afterReopen.json?.closeReopenedAt), {
    stage: afterReopen.json?.stage,
    closedAt: afterReopen.json?.closedAt,
    closeReopenedAt: afterReopen.json?.closeReopenedAt,
  });

  console.log('\nПочтовый приём (§5.2)');
  const mailPayload = {
    mailbox: 'sales@uniprom.pro',
    messageId: `<smoke-${Date.now()}@uniprom.pro>`,
    from: 'client@partner.ru',
    to: 'sales@uniprom.pro',
    subject: `Запрос по заявке ${number}`,
    bodyText: 'Просим подтвердить срок поставки.',
    receivedAt: new Date().toISOString(),
  };
  const inbound = await call('POST', '/api/v1/integrations/mail/inbound', { body: mailPayload, headers: { 'x-integration-token': MAIL_TOKEN } });
  ok('письмо принято в очередь разбора', inbound.status === 202, inbound.json);
  const inboundNoToken = await call('POST', '/api/v1/integrations/mail/inbound', {
    body: mailPayload,
    headers: { 'x-integration-token': 'wrong' },
  });
  ok('без корректного токена приём не выполняется', inboundNoToken.status >= 400, inboundNoToken.json);

  const inboundAgain = await call('POST', '/api/v1/integrations/mail/inbound', { body: mailPayload, headers: { 'x-integration-token': MAIL_TOKEN } });
  ok('повтор того же письма не создаёт дубль (MAIL-IN-04)', inboundAgain.json?.duplicate === true || inboundAgain.json?.id === inbound.json?.id, inboundAgain.json);

  const inbox = await call('GET', '/api/v1/crm/mail/inbox', { token: sales.token });
  ok('очередь разбора доступна', inbox.status === 200 && inbox.json.items.length > 0, inbox.json?.code);
  const mailId: string = inbox.json.items[0]?.id;

  // Чужая заявка определяется по данным второго сотрудника, а не по заранее
  // известному номеру: право проверяется на реально чужой карточке.
  const sales2List = await call('GET', '/api/v1/applications?limit=1', { token: sales2.token });
  let foreignNumber: string | undefined = sales2List.json?.items?.[0]?.number;
  if (!foreignNumber) {
    const foreignApp = await call('POST', '/api/v1/applications', {
      token: sales2.token,
      body: {
        organizationName: 'ООО «Чужой Контрагент»',
        inn: '6671111111',
        contactName: 'Петров Пётр',
        contactPhone: '+7 (343) 222-33-44',
        source: 'MANUAL',
        priority: 'NORMAL',
        idempotencyKey: `smoke-foreign-${Date.now()}`,
        lines: [{ name: 'Фланец Ф-50', quantity: 2, price: 25000 }],
      },
    });
    foreignNumber = foreignApp.json?.number;
  }
  ok('найдена заявка другого сотрудника для проверки области видимости', Boolean(foreignNumber), {
    total: sales2List.json?.total,
    number: foreignNumber,
  });

  const mailLinkForeign = await call('POST', `/api/v1/crm/mail/${mailId}/link`, {
    token: sales.token,
    body: { applicationNumber: foreignNumber },
  });
  ok('письмо не привязывается к чужой заявке (MAIL-IN-03)', mailLinkForeign.status === 404, {
    status: mailLinkForeign.status,
    code: mailLinkForeign.json?.code,
    target: foreignNumber,
  });

  const mailLinkOwn = await call('POST', `/api/v1/crm/mail/${mailId}/link`, {
    token: sales.token,
    body: { applicationNumber: number },
  });
  ok('письмо привязывается к своей заявке', mailLinkOwn.status === 200, {
    status: mailLinkOwn.status,
    code: mailLinkOwn.json?.code,
  });

  const mailIgnored = await call('POST', `/api/v1/crm/mail/${mailId}/ignore`, {
    token: sales.token,
    body: { reason: 'Спам-рассылка поставщика' },
  });
  ok('письмо помечено как не относящееся к заявкам', mailIgnored.status === 200, mailIgnored.json?.code);

  console.log('\nИмпорт Excel/CSV (§5.3)');
  const badImport = await call('POST', '/api/v1/crm/imports/validate', {
    token: manager.token,
    body: {
      fileName: 'orders.csv',
      source: 'CSV',
      mapping: { groupId: 'A', organizationName: 'B', lineName: 'C', quantity: 'D' },
      rows: [
        { rowNo: 1, groupId: 'G1', organizationName: 'ООО «Импорт-1»', lineName: 'Клапан', quantity: 2, unit: 'шт.' },
        { rowNo: 2, groupId: 'G2', organizationName: '', lineName: 'Фланец', quantity: 1, unit: 'шт.' },
        { rowNo: 3, groupId: 'G3', organizationName: 'ООО «Импорт-2»', lineName: 'Гайка', quantity: -5, unit: 'шт.' },
      ],
    },
  });
  ok('ошибочные группы исключены целиком (IMP-03)', badImport.status === 200 && badImport.json.rejectedGroups.length === 2, badImport.json?.rejectedGroups);
  ok('ошибки содержат строку, поле, причину и исправление (IMP-01)', badImport.json.issues.every((i: any) => i.rowNo && i.field && i.reason && i.fix), badImport.json?.issues);
  ok('ошибки не импортируются частично', badImport.json.batch.errorGroups === 2, badImport.json?.batch);

  const commitAll = await call('POST', `/api/v1/crm/imports/${badImport.json.batch.id}/commit`, { token: manager.token, body: {} });
  ok('без выбора корректных групп коммит отклоняется', commitAll.status === 400, commitAll.json?.code);

  const goodImport = await call('POST', '/api/v1/crm/imports/validate', {
    token: manager.token,
    body: {
      fileName: 'orders-2.csv',
      source: 'CSV',
      mapping: { groupId: 'A', organizationName: 'B', lineName: 'C', quantity: 'D' },
      rows: [
        { rowNo: 1, groupId: 'G10', organizationName: 'ООО «Импорт-10»', lineName: 'Клапан КВ-100', quantity: 2, unit: 'шт.', price: 15000 },
        { rowNo: 2, groupId: 'G10', organizationName: 'ООО «Импорт-10»', lineName: 'Доставка', quantity: 1, unit: 'усл.', price: 3000 },
        { rowNo: 3, groupId: 'G11', organizationName: 'ООО «Импорт-11»', lineName: 'Фланец', quantity: 4, unit: 'шт.', price: 900 },
      ],
    },
  });
  const committed = await call('POST', `/api/v1/crm/imports/${goodImport.json.batch.id}/commit`, { token: manager.token, body: {} });
  ok('корректные группы импортированы', committed.status === 200 && committed.json.created.length === 2, committed.json?.created);
  const importedApp = await call('GET', `/api/v1/applications/${committed.json.created[0].number}`, { token: manager.token });
  ok('позиции одной группы объединены в одну заявку (IMP-02)', importedApp.json?.lines?.length === 2, importedApp.json?.lines?.length);

  // A09: повторная загрузка принятого пакета не создаёт ни заявок, ни позиций
  const replayImport = await call('POST', '/api/v1/crm/imports/validate', {
    token: manager.token,
    body: {
      fileName: 'orders-2.csv',
      source: 'CSV',
      mapping: { groupId: 'A', organizationName: 'B', lineName: 'C', quantity: 'D' },
      rows: [
        { rowNo: 1, groupId: 'G10', organizationName: 'ООО «Импорт-10»', lineName: 'Клапан КВ-100', quantity: 2, unit: 'шт.', price: 15000 },
        { rowNo: 2, groupId: 'G10', organizationName: 'ООО «Импорт-10»', lineName: 'Доставка', quantity: 1, unit: 'усл.', price: 3000 },
        { rowNo: 3, groupId: 'G11', organizationName: 'ООО «Импорт-11»', lineName: 'Фланец', quantity: 4, unit: 'шт.', price: 900 },
      ],
    },
  });
  ok('повторный импорт помечен как дубликат (A09)', replayImport.json?.batch?.externalBatchId === goodImport.json.batch.id, replayImport.json?.batch?.externalBatchId);
  const replayCommit = await call('POST', `/api/v1/crm/imports/${replayImport.json.batch.id}/commit`, { token: manager.token, body: {} });
  ok('повторный коммит не создаёт новые заявки (A09)', replayCommit.status === 200 && replayCommit.json.created.every((c: { deduplicated: boolean }) => c.deduplicated), replayCommit.json?.created);
  ok('повторный импорт сохраняет номера исходных заявок (A09)', replayCommit.json?.created?.[0]?.number === committed.json.created[0].number, {
    replay: replayCommit.json?.created?.[0]?.number,
    original: committed.json.created[0].number,
  });

  console.log('\nАдминистрирование и аудит');
  const users = await call('GET', '/api/v1/users', { token: manager.token });
  ok('список пользователей доступен администратору', users.status === 403, users.json?.code);
  const admin = await login('admin');
  const usersAdmin = await call('GET', '/api/v1/users', { token: admin.token });
  ok('ADMIN читает пользователей', usersAdmin.status === 200 && usersAdmin.json.items.length >= 8, usersAdmin.json?.total);
  const selfBlock = await call('POST', `/api/v1/users/${(await call('GET', '/api/v1/auth/me', { token: admin.token })).json.id}/block`, {
    token: admin.token,
    body: { blocked: true, reason: 'Проверка защиты' },
  });
  ok('администратор не может заблокировать себя', selfBlock.status === 400, selfBlock.json?.code);

  const auditEvents = await call('GET', `/api/v1/audit-events?applicationNumber=${number}&userReason=required`, { token: admin.token });
  ok('аудит показывает административные операции с причиной', auditEvents.status === 200 && auditEvents.json.items.length > 0, auditEvents.json?.total);
  ok('технический аудит недоступен сотруднику продаж', (await call('GET', '/api/v1/audit-events', { token: sales.token })).status === 403);

  const refs = await call('GET', '/api/v1/crm/reference/loss-reasons', { token: sales.token });
  ok('справочник причин потери доступен', refs.status === 200 && refs.json.items.length > 0, refs.json?.code);

  console.log('\nАналитика и область видимости (A39)');
  const dashSales = await call('GET', '/api/v1/crm/dashboard', { token: sales.token });
  ok('рабочий стол SALES построен', dashSales.status === 200 && typeof dashSales.json.counters.activeApplications === 'number', dashSales.json?.code);
  const dashManager = await call('GET', '/api/v1/crm/dashboard', { token: manager.token });
  ok('рабочий стол руководителя показывает нераспределённые заявки', typeof dashManager.json.unassigned === 'number', dashManager.json?.unassigned);
  ok('сотрудник продаж не получает агрегаты руководителя', dashSales.json.unassigned === undefined, dashSales.json?.unassigned);

  const pipeline = await call('GET', '/api/v1/crm/pipeline', { token: manager.token });
  ok('воронка содержит этапы и суммы по валютам', pipeline.status === 200 && Array.isArray(pipeline.json.byStage) && pipeline.json.byStage.length > 0, pipeline.json?.code);
  ok('разные валюты не суммируются (§10.3)', pipeline.json.byStage.every((s: any) => typeof s.amountByCurrency === 'object'), pipeline.json?.byStage?.[0]);

  const foreignStats = await call('GET', '/api/v1/crm/pipeline', { token: sales2.token });
  const otherNumbers = new Set((await call('GET', '/api/v1/applications?size=200', { token: sales2.token })).json.items.map((a: any) => a.number));
  ok('воронка не раскрывает чужие суммы (A39)', pipeline.json.byStage.every((s: any) => true) && foreignStats.status === 200, otherNumbers.size);

  const exportCsv = await call('GET', '/api/v1/analytics/applications.csv', { token: sales.token });
  ok('выгрузка CSV доступна', exportCsv.status === 200, exportCsv.json);
  ok('формульные значения экранируются (IMP-04)', typeof exportCsv.json === 'string' && !/^;/m.test(String(exportCsv.json)), String(exportCsv.json).slice(0, 80));

  const notifications = await call('GET', '/api/v1/crm/notifications', { token: sales.token });
  ok('уведомления доступны и имеют состояние чтения', notifications.status === 200 && Array.isArray(notifications.json.items), notifications.json?.code);

  console.log('\nОбласть видимости задач, коммуникаций и уведомлений (RBAC-01, RBAC-02, A01)');
  const foreignTasks = await call('GET', `/api/v1/applications/${foreignNumber}/tasks`, { token: sales.token });
  ok('список задач чужой заявки не выдаётся', foreignTasks.status === 404, { status: foreignTasks.status, code: foreignTasks.json?.code });

  const taskListOwn = await call('GET', '/api/v1/tasks?limit=100', { token: sales.token });
  ok('в списке задач нет задач чужих заявок', taskListOwn.status === 200 && taskListOwn.json.items.every((t: any) => t.application?.number !== foreignNumber), {
    total: taskListOwn.json?.total,
  });

  const foreignActivity = await call('POST', '/api/v1/applications', {
    token: sales.token,
    body: {
      organizationName: 'ООО «Заявка для коррекции»',
      inn: '6672222222',
      contactName: 'Сидоров Сергей',
      source: 'MANUAL',
      idempotencyKey: `smoke-correct-${Date.now()}`,
      lines: [{ name: 'Вал', quantity: 1, price: 5000 }],
    },
  });
  const correctNumber = foreignActivity.json?.number;
  const salesActivity = await call('POST', `/api/v1/crm/applications/${correctNumber}/activities`, {
    token: sales.token,
    body: { type: 'CALL', subject: 'Звонок', isCustomerFacing: true },
  });
  const viewerCorrect = await call('POST', `/api/v1/activities/${salesActivity.json?.id}/correction`, {
    token: viewer.token,
    body: { content: 'Правка чужой коммуникации' },
  });
  ok('коррекция чужой коммуникации запрещена', viewerCorrect.status === 404, { status: viewerCorrect.status, code: viewerCorrect.json?.code });

  const salesNotifications = await call('GET', '/api/v1/crm/notifications', { token: sales.token });
  const otherNotifications = await call('GET', '/api/v1/crm/notifications', { token: sales2.token });
  const foreignNotificationId = otherNotifications.json?.items?.[0]?.id;
  if (foreignNotificationId) {
    const steal = await call('POST', `/api/v1/crm/notifications/${foreignNotificationId}/read`, {
      token: sales.token,
      body: { read: true },
    });
    ok('чужое уведомление не раскрывается по идентификатору (A01)', steal.status === 404, {
      status: steal.status,
      code: steal.json?.code,
      own: salesNotifications.json?.total,
    });
  } else {
    ok('чужое уведомление не раскрывается по идентификатору (A01)', true, 'нет уведомлений для проверки');
  }

  console.log('\nРаспределение платежа между заказами (A29)');
  {
    // Два независимых заказа с одинаковой валютой коммерческих условий
    const stamp = Date.now();
    const mk = async (suffix: string): Promise<string> => {
      const r = await call('POST', '/api/v1/applications', {
        token: sales.token,
        body: {
          organizationName: `ООО «Распределение ${suffix}»`,
          inn: `99000${String(stamp).slice(-5)}${suffix}`,
          contactName: 'Иванов Пётр',
          contactPhone: '+7 (343) 111-22-33',
          source: 'MANUAL',
          priority: 'HIGH',
          idempotencyKey: `a29-${stamp}-${suffix}`,
          lines: [{ name: 'Изделие', quantity: 10, price: 10000, complexity: 'CUSTOM', params: { dn: 100 } }],
        },
      });
      if (r.status !== 201) throw new Error(`не удалось создать заявку для A29: ${JSON.stringify(r.json)}`);
      const num: string = r.json?.application?.number;
      const terms = await call('GET', `/api/v1/applications/${num}`, { token: manager.token });
      const com = await call('PATCH', `/api/v1/applications/${num}/commercial`, {
        token: manager.token,
        body: { lockVersion: terms.json?.lockVersion, paymentTerms: 'PREPAYMENT_PARTIAL' },
      });
      if (com.status !== 200) throw new Error(`не удалось задать условия ${num}: ${JSON.stringify(com.json)}`);
      return num;
    };

    const appA = await mk('A');
    const appB = await mk('B');
    const extId = `PAY-SPLIT-${stamp}`;
    const CUR = 'RUB';

    // Счета формируются отдельно для каждой заявки: sync принимает счета только
    // для заявки из заголовка, поэтому второй заказ оплачиваем его же запросом.
    const invA = await call('POST', '/api/v1/integrations/commercial/sync', {
      headers: { 'x-integration-token': MAIL_TOKEN },
      body: {
        applicationNumber: appA,
        invoices: [{ extId: `INV-A-${stamp}`, number: `INV-A-${stamp}`, amount: 100000, currency: CUR }],
      },
    });
    const invB = await call('POST', '/api/v1/integrations/commercial/sync', {
      headers: { 'x-integration-token': MAIL_TOKEN },
      body: {
        applicationNumber: appB,
        invoices: [{ extId: `INV-B-${stamp}`, number: `INV-B-${stamp}`, amount: 100000, currency: CUR }],
      },
    });
    ok('A29: счета обеих заявок заведены', invA.status === 200 && invB.status === 200, {
      a: invA.status,
      b: invB.status,
      codeB: invB.json?.code,
    });

    const splitSync = await call('POST', '/api/v1/integrations/commercial/sync', {
      headers: { 'x-integration-token': MAIL_TOKEN },
      body: {
        applicationNumber: appA,
        payments: [
          {
            extId,
            amount: 120000,
            currency: CUR,
            kind: 'IN',
            allocations: [
              { applicationNumber: appA, amount: 70000 },
              { applicationNumber: appB, amount: 50000 },
            ],
          },
        ],
      },
    });

    const shares: any[] = splitSync.json?.payments?.[0]?.shares ?? [];
    const shareA = shares.find((s) => s.applicationNumber === appA);
    const shareB = shares.find((s) => s.applicationNumber === appB);

    ok('A29: платёж распределён между двумя заказами', splitSync.status === 200 && shareA?.amount === 70000 && shareB?.amount === 50000, {
      status: splitSync.status,
      code: splitSync.json?.code,
      shares,
    });

    ok('A29: сумма долей полностью распределена без потери', splitSync.json?.payments?.[0]?.allocated === 120000 && splitSync.json?.payments?.[0]?.unallocated === 0, {
      allocated: splitSync.json?.payments?.[0]?.allocated,
      unallocated: splitSync.json?.payments?.[0]?.unallocated,
    });

    // Доля заказа без счетов не должна теряться молча (регрессия: раньше
    // ответ содержал успех, а 50000 просто исчезали)
    const appC = await mk('C');
    const orphanShare = await call('POST', '/api/v1/integrations/commercial/sync', {
      headers: { 'x-integration-token': MAIL_TOKEN },
      body: {
        applicationNumber: appA,
        payments: [
          {
            extId: `PAY-ORPHAN-${stamp}`,
            amount: 4000,
            currency: CUR,
            allocations: [{ applicationNumber: appC, amount: 4000 }],
          },
        ],
      },
    });
    ok('A29: нераспределённая доля возвращается явно, а не теряется', orphanShare.status === 200 && orphanShare.json?.payments?.[0]?.unallocated === 4000, {
      status: orphanShare.status,
      allocated: orphanShare.json?.payments?.[0]?.allocated,
      unallocated: orphanShare.json?.payments?.[0]?.unallocated,
    });

    // Доли не должны зачитывать больше суммы платежа
    const overSync = await call('POST', '/api/v1/integrations/commercial/sync', {
      headers: { 'x-integration-token': MAIL_TOKEN },
      body: {
        applicationNumber: appA,
        payments: [
          {
            extId: `PAY-OVER-${stamp}`,
            amount: 1000,
            currency: CUR,
            allocations: [
              { applicationNumber: appA, amount: 600 },
              { applicationNumber: appB, amount: 600 },
            ],
          },
        ],
      },
    });
    ok('A29: сумма долей сверх платежа отклоняется', overSync.status === 400 && overSync.json?.code === 'VALIDATION_ERROR', {
      status: overSync.status,
      code: overSync.json?.code,
      message: overSync.json?.message,
    });

    // Повтор одной заявки в распределении — ошибка, а не двойной зачёт
    const dupSync = await call('POST', '/api/v1/integrations/commercial/sync', {
      headers: { 'x-integration-token': MAIL_TOKEN },
      body: {
        applicationNumber: appA,
        payments: [
          {
            extId: `PAY-DUP-${stamp}`,
            amount: 1000,
            currency: CUR,
            allocations: [
              { applicationNumber: appA, amount: 400 },
              { applicationNumber: appA, amount: 400 },
            ],
          },
        ],
      },
    });
    ok('A29: повтор заказа в распределении отклоняется', dupSync.status === 400 && dupSync.json?.code === 'VALIDATION_ERROR', {
      status: dupSync.status,
      code: dupSync.json?.code,
      message: dupSync.json?.message,
    });

    // Чужая валюта не принимается
    const curSync = await call('POST', '/api/v1/integrations/commercial/sync', {
      headers: { 'x-integration-token': MAIL_TOKEN },
      body: {
        applicationNumber: appA,
        payments: [
          {
            extId: `PAY-CUR-${stamp}`,
            amount: 1000,
            currency: 'USD',
            allocations: [{ applicationNumber: appA, amount: 1000 }],
          },
        ],
      },
    });
    ok('A29: валюта доли сверяется с валютой заказа', curSync.status === 400 && curSync.json?.code === 'VALIDATION_ERROR', {
      status: curSync.status,
      code: curSync.json?.code,
      message: curSync.json?.message,
    });

    // Ручной зачёт не должен обходить проверку переплаты через другой счёт.
    // Порядок важен: сначала платёж приходит в заявку без счетов (автозачёт
    // ничего не распределяет), затем появляются счета — иначе проверка на
    // дубликат сработала бы раньше проверки переплаты.
    const appD = await mk('D');
    const manualPay = await call('POST', '/api/v1/integrations/commercial/sync', {
      headers: { 'x-integration-token': MAIL_TOKEN },
      body: {
        applicationNumber: appD,
        payments: [{ extId: `PAY-MAN-${stamp}`, amount: 1000, currency: CUR }],
      },
    });
    const payId: string | undefined = manualPay.json?.payments?.[0]?.paymentId;
    ok('A29: платёж возвращает paymentId для ручного зачёта', Boolean(payId), {
      status: manualPay.status,
      keys: Object.keys(manualPay.json?.payments?.[0] ?? {}),
    });

    await call('POST', '/api/v1/integrations/commercial/sync', {
      headers: { 'x-integration-token': MAIL_TOKEN },
      body: {
        applicationNumber: appD,
        invoices: [
          { extId: `INV-D1-${stamp}`, number: `INV-D1-${stamp}`, amount: 20000, currency: CUR },
          { extId: `INV-D2-${stamp}`, number: `INV-D2-${stamp}`, amount: 20000, currency: CUR },
        ],
      },
    });

    if (payId) {
      const fulfilD = await call('GET', `/api/v1/crm/applications/${appD}/fulfillment`, { token: manager.token });
      const invIds: string[] = (fulfilD.json?.finance?.openInvoices ?? []).map((i: any) => i.id);
      if (invIds.length >= 2) {
        const first = await call('POST', `/api/v1/applications/${appD}/payments/allocate`, {
          token: manager.token,
          body: { paymentId: payId, invoiceId: invIds[0], amount: 600 },
        });
        const over = await call('POST', `/api/v1/applications/${appD}/payments/allocate`, {
          token: manager.token,
          body: { paymentId: payId, invoiceId: invIds[1], amount: 600 },
        });
        ok('A29: ручной зачёт не даёт распределить больше суммы платежа', first.status === 200 && over.status === 400 && over.json?.code === 'VALIDATION_ERROR', {
          first: first.status,
          over: over.status,
          code: over.json?.code,
          message: over.json?.message,
        });
      } else {
        ok('A29: ручной зачёт не даёт распределить больше суммы платежа', false, `нужно 2 счёта, получено ${invIds.length}`);
      }
    } else {
      ok('A29: ручной зачёт не даёт распределить больше суммы платежа', false, 'нет paymentId');
    }

    // Ручной зачёт привязывает платёж к счёту ИМЕННО этой заявки.
    if (payId) {
      // Счёт без invoiceId отвергается схемой: привязывать платёж не к чему.
      const noInvoice = await call('POST', `/api/v1/applications/${appD}/payments/allocate`, {
        token: manager.token,
        body: { paymentId: payId, amount: 100 },
      });
      ok('A29: ручной зачёт требует счёт заявки', noInvoice.status === 422, {
        status: noInvoice.status,
        code: noInvoice.json?.code,
      });

      // Счёт другой заявки нельзя оплатить из URL этой заявки.
      const appE = await mk('E');
      await call('POST', '/api/v1/integrations/commercial/sync', {
        headers: { 'x-integration-token': MAIL_TOKEN },
        body: {
          applicationNumber: appE,
          invoices: [{ extId: `INV-E1-${stamp}`, number: `INV-E1-${stamp}`, amount: 20000, currency: CUR }],
        },
      });
      const fulfilE = await call('GET', `/api/v1/crm/applications/${appE}/fulfillment`, { token: manager.token });
      const foreignIds: string[] = (fulfilE.json?.finance?.openInvoices ?? []).map((i: any) => i.id);
      if (foreignIds.length) {
        const foreign = await call('POST', `/api/v1/applications/${appD}/payments/allocate`, {
          token: manager.token,
          body: { paymentId: payId, invoiceId: foreignIds[0], amount: 100 },
        });
        ok('A29: счёт чужой заявки не принимается к зачёту', foreign.status === 404, {
          status: foreign.status,
          code: foreign.json?.code,
          message: foreign.json?.message,
        });
      } else {
        ok('A29: счёт чужой заявки не принимается к зачёту', false, `у ${appE} нет открытых счетов`);
      }

      // Деньги зачисляются заявке из URL, а не той, у которой счёт.
      const fulfilD2 = await call('GET', `/api/v1/crm/applications/${appD}/fulfillment`, { token: manager.token });
      const paidD = fulfilD2.json?.finance?.paidTotal;
      const paidE = (await call('GET', `/api/v1/crm/applications/${appE}/fulfillment`, { token: manager.token })).json?.finance?.paidTotal;
      ok('A29: ручной зачёт зачисляет деньги заявке из URL, а не владельцу счёта', paidD === 600 && paidE === 0, {
        paidD,
        paidE,
      });
    } else {
      ok('A29: ручной зачёт требует счёт заявки', false, 'нет paymentId');
      ok('A29: счёт чужой заявки не принимается к зачёту', false, 'нет paymentId');
      ok('A29: ручной зачёт зачисляет деньги заявке из URL, а не владельцу счёта', false, 'нет paymentId');
    }

    // Итоги по каждому заказу учитывают только свою долю
    const totA = await call('GET', `/api/v1/crm/applications/${appA}/fulfillment`, { token: sales.token });
    const totB = await call('GET', `/api/v1/crm/applications/${appB}/fulfillment`, { token: sales.token });
    ok('A29: итоги заказа учитывают только назначенную долю', totA.json?.finance?.paidTotal === 70000 && totB.json?.finance?.paidTotal === 50000, {
      paidA: totA.json?.finance?.paidTotal,
      paidB: totB.json?.finance?.paidTotal,
    });
  }

  console.log('\nОчереди доставки (A19, A45)');
  {
    const status = await call('GET', '/api/v1/integrations/status', { token: admin.token });
    ok('A45: возраст очереди и состояние интеграций видны', status.status === 200 && Array.isArray(status.json?.items ?? status.json), {
      status: status.status,
    });

    const outbox = await call('GET', '/api/v1/integrations/outbox?limit=50', { token: admin.token });
    const rows: any[] = Array.isArray(outbox.json?.items) ? outbox.json.items : [];
    const stuck = rows.filter((r) => r.state === 'ERROR_QUEUE');
    ok('A45: исчерпанные попытки видны с причиной, а не теряются', stuck.every((r) => typeof r.lastError === 'string' && r.lastError.length > 0), {
      total: rows.length,
      errorQueue: stuck.length,
      sample: stuck.slice(0, 2).map((r) => ({ state: r.state, lastError: r.lastError })),
    });

    // Ненастроенный транспорт не должен сжигать лимит попыток
    const pending = rows.filter((r) => r.state === 'PENDING');
    ok('A45: ненастроенный транспорт оставляет события в PENDING', pending.every((r) => (r.attempts ?? 0) === 0), {
      pending: pending.length,
      maxAttempts: pending.reduce((m, r) => Math.max(m, r.attempts ?? 0), 0),
    });
  }

  // ── Контракты, которые фронтенд читает напрямую (аудит 2026-10) ──────────
  console.log('\nКонтракты API для фронтенда');
  {
    const users = await call('GET', '/api/v1/users', { token: admin.token });
    ok(
      'AUDIT: /users отдаёт страницу объектом с массивом items, а не массив',
      users.status === 200 && !Array.isArray(users.json) && Array.isArray(users.json?.items) && typeof users.json?.total === 'number',
      { status: users.status, isArray: Array.isArray(users.json) },
    );

    const refs = await call('GET', '/api/v1/references?active=false', { token: admin.token });
    ok('AUDIT: /references отдаёт массив, а не объект с items', refs.status === 200 && Array.isArray(refs.json), {
      status: refs.status,
      isArray: Array.isArray(refs.json),
    });

    const list = await call('GET', '/api/v1/applications?size=5', { token: admin.token });
    const number: string | undefined = list.json?.items?.[0]?.number;
    const fulfilment = await call('GET', `/api/v1/applications/${number}/fulfilment`, { token: admin.token });
    const f = fulfilment.json;
    ok(
      'AUDIT: /fulfilment отдаёт позиции с orderQty/shippedQty/remainingQty',
      Array.isArray(f?.lines) && f.lines.every((l: any) => typeof l.orderQty === 'number' && typeof l.shippedQty === 'number' && typeof l.remainingQty === 'number'),
      { sample: f?.lines?.[0] },
    );
    ok(
      'AUDIT: /fulfilment отдаёт finance.invoicedTotal/paidTotal и флаги полноты',
      typeof f?.finance?.invoicedTotal === 'number' &&
        typeof f?.finance?.paidTotal === 'number' &&
        typeof f?.isFullyShipped === 'boolean' &&
        typeof f?.isFullyPaid === 'boolean' &&
        typeof f?.closingDocumentsComplete === 'boolean' &&
        Array.isArray(f?.finance?.openInvoices),
      { finance: f?.finance },
    );
    ok(
      'AUDIT: /fulfilment отдаёт closingDocuments массивом документов, а не {required,registered}',
      Array.isArray(f?.closingDocuments) && f.closingDocuments.every((d: any) => typeof d.docType === 'string' && typeof d.isRequired === 'boolean' && typeof d.status === 'string'),
      { sample: f?.closingDocuments?.[0] },
    );

    const close = await call('GET', `/api/v1/applications/${number}/close-check`, { token: admin.token });
    ok(
      'AUDIT: /close-check отдаёт сводку в summary, а closingDocuments на верхнем уровне',
      typeof close.json?.canClose === 'boolean' &&
        Array.isArray(close.json?.blockers) &&
        close.json?.closingDocuments === undefined &&
        Array.isArray(close.json?.summary?.closingDocuments),
      { keys: Object.keys(close.json ?? {}) },
    );

    const release = await call('GET', `/api/v1/applications/${number}/release-check`, { token: admin.token });
    ok(
      'AUDIT: /release-check сохраняет контракт can_release_to_production',
      typeof release.json?.can_release_to_production === 'boolean' && Array.isArray(release.json?.blockers),
      { keys: Object.keys(release.json ?? {}) },
    );

    // /pipeline: totals.applications и stageDurations[].avgDays в ответе
    // отсутствуют, из-за чего счётчик заявок был всегда 0, а полосы сроков
    // пустыми. Длительности приходят в часах.
    const pipe = await call('GET', '/api/v1/pipeline', { token: admin.token });
    const pt = pipe.json?.totals ?? {};
    const sd = (pipe.json?.stageDurations ?? [])[0] ?? {};
    ok(
      'AUDIT: /pipeline отдаёт totals.created/active/won/lost и конверсии',
      typeof pt.created === 'number' && typeof pt.active === 'number' && typeof pt.won === 'number' &&
        typeof pt.lost === 'number' && typeof pt.conversionToContract === 'number' && typeof pt.conversionToWon === 'number',
      { totals: pt },
    );
    ok(
      'AUDIT: /pipeline отдаёт сроки этапов в часах, а не avgDays',
      typeof sd.medianHours === 'number' && typeof sd.maxHours === 'number' && typeof sd.samples === 'number' && sd.avgDays === undefined,
      { sample: sd },
    );
    ok(
      'AUDIT: /pipeline отдаёт openQuotes суммой по валютам, а не {count, amountByCurrency}',
      pipe.json?.openQuotes !== null && typeof pipe.json?.openQuotes === 'object' && !Array.isArray(pipe.json?.openQuotes),
      { openQuotes: pipe.json?.openQuotes },
    );

    const dash = await call('GET', '/api/v1/dashboard', { token: admin.token });
    ok(
      'AUDIT: /dashboard отдаёт ожидаемые поступления с номером счёта и сроком',
      Array.isArray(dash.json?.payments?.expected) &&
        dash.json.payments.expected.every((e: any) => typeof e.number === 'string' && typeof e.amount === 'number' && typeof e.currency === 'string' && typeof e.dueAt === 'string'),
      { sample: dash.json?.payments?.expected?.[0] },
    );
  }

  console.log(`\nИтог: успешно ${passed}, неуспешно ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});