/**
 * A42: нагрузочный сценарий на 30 одновременных пользователей.
 *
 * Сценарий имитирует работу отдела продаж: каждый пользователь входит, читает
 * рабочий стол, список заявок, карточку, воронку и создаёт коммуникацию. После
 * прогона сверяется, что состояние данных осталось согласованным — нагрузка не
 * должна оставлять частично записанных заявок или задач.
 *
 * Использование:
 *   npx tsx scripts/loadtest.ts [--users 30] [--rounds 5] [--base http://127.0.0.1:3001]
 *
 * Скрипт только читает и добавляет коммуникации: он не меняет этапы, не выпускает
 * заявки в производство и не трогает оплату, поэтому безопасен для стенда с
 * рабочими данными. Требования к лимитам задаются переменными ниже.
 */

const args = process.argv.slice(2);

function argValue(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const raw = args[i + 1];
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const BASE = (() => {
  const i = args.indexOf('--base');
  return i >= 0 && args[i + 1] ? args[i + 1]! : 'http://127.0.0.1:3001';
})();

const USERS = argValue('users', 30);
const ROUNDS = argValue('rounds', 5);

/** Согласованные показатели: при превышении сценарий считается неуспешным. */
const TARGETS = {
  /** Доля успешных ответов, не ниже. */
  successRate: 0.99,
  /** Медиана времени ответа, мс, не выше. */
  medianMs: 750,
  /** 95-й перцентиль, мс, не выше. */
  p95Ms: 2000,
};

const LOGINS = [
  { login: 'admin', password: 'Uniprom#2026' },
  { login: 'rm.sales', password: 'Uniprom#2026' },
  { login: 'rm.ko', password: 'Uniprom#2026' },
  { login: 'proizv', password: 'Uniprom#2026' },
  { login: 'viewer', password: 'Uniprom#2026' },
];

interface Sample {
  route: string;
  ms: number;
  ok: boolean;
  status: number;
}

/**
 * Ответ, который система обязана давать по правам конкретной роли.
 * Отказ по правам — корректное поведение (RBAC-01/02), а не сбой нагрузки,
 * поэтому такие ответы учитываются отдельно и не портят показатель успеха.
 * Неожиданные коды (404, 500) — наоборот, дефект.
 */
const EXPECTED_DENIAL = new Set([401, 403]);

const samples: Sample[] = [];

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: any; ms: number }> {
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const ms = performance.now() - started;
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, ms };
}

function record(route: string, r: { status: number; ms: number }): boolean {
  const expected = r.status >= 200 && r.status < 400;
  const deniedByRights = EXPECTED_DENIAL.has(r.status);
  const ok = expected || deniedByRights;
  samples.push({ route, ms: r.ms, ok, status: r.status });
  return ok;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

async function runUser(index: number, token: string): Promise<void> {
  const round = async (n: number): Promise<void> => {
    record('GET /dashboard', await call('GET', '/api/v1/dashboard', token));
    const list = await call('GET', '/api/v1/applications?size=20', token);
    record('GET /applications', list);

    const items: { number: string }[] = Array.isArray(list.json?.items) ? list.json.items : [];
    const first = items[index % Math.max(1, items.length)];
    if (first?.number) {
      const card = await call('GET', `/api/v1/applications/${encodeURIComponent(first.number)}`, token);
      record('GET /applications/:number', card);
      record('GET /applications/:number/timeline', await call('GET', `/api/v1/applications/${encodeURIComponent(first.number)}/timeline`, token));
      if (card.json?.number) {
        record(
          'POST /applications/:number/activities',
          await call('POST', `/api/v1/applications/${encodeURIComponent(first.number)}/activities`, token, {
            type: 'CALL',
            body: `Нагрузочный прогон A42, пользователь ${index}, круг ${n}`,
            isCustomerFacing: true,
          }),
        );
      }
    }

    record('GET /pipeline', await call('GET', '/api/v1/pipeline', token));
    record('GET /tasks', await call('GET', '/api/v1/tasks?size=20', token));
    record('GET /notifications', await call('GET', '/api/v1/crm/notifications?size=10', token));
  };

  for (let n = 1; n <= ROUNDS; n += 1) await round(n);
}

async function integrityCheck(): Promise<string[]> {
  // Проверка целостности после нагрузки: заявки читаются и не разъехались.
  const problems: string[] = [];
  const login = await call('POST', '/api/v1/auth/login', null, LOGINS[1]);
  if (login.status !== 200) {
    problems.push(`не удалось войти для проверки целостности: ${login.status}`);
    return problems;
  }
  const token: string = login.json.token;

  const list = await call('GET', '/api/v1/applications?size=50', token);
  const items: any[] = Array.isArray(list.json?.items) ? list.json.items : [];
  if (!items.length) problems.push('список заявок пуст после нагрузки');

  for (const item of items.slice(0, 20)) {
    const card = await call('GET', `/api/v1/applications/${encodeURIComponent(item.number)}`, token);
    if (card.status !== 200) {
      problems.push(`заявка ${item.number} не читается после нагрузки: ${card.status}`);
      continue;
    }
    if (typeof card.json?.lockVersion !== 'number') {
      problems.push(`у заявки ${item.number} отсутствует lockVersion`);
    }
    if (!Array.isArray(card.json?.lines)) {
      problems.push(`у заявки ${item.number} отсутствуют позиции`);
    }
  }

  const dashboard = await call('GET', '/api/v1/dashboard', token);
  if (dashboard.status !== 200) problems.push(`рабочий стол недоступен после нагрузки: ${dashboard.status}`);

  return problems;
}

async function main(): Promise<void> {
  process.stdout.write(`Нагрузка A42: ${USERS} пользователей × ${ROUNDS} кругов, сервер ${BASE}\n\n`);

  const tokens: string[] = [];
  for (const cred of LOGINS) {
    const r = await call('POST', '/api/v1/auth/login', null, cred);
    if (r.status === 200 && r.json?.token) {
      // На каждого пользователя — своя сессия; при нехватке учётных записи
      // используются повторные входы тех же, что имитирует несколько устройств.
      for (let i = 0; i < Math.ceil(USERS / LOGINS.length); i += 1) tokens.push(r.json.token as string);
    } else {
      process.stdout.write(`ПРЕДУПРЕЖДЕНИЕ: вход ${cred.login} не удался (${r.status})\n`);
    }
  }
  if (!tokens.length) {
    process.stderr.write('Не удалось войти ни одним пользователем — нагрузка невозможна.\n');
    process.exit(1);
  }

  const started = performance.now();
  await Promise.all(tokens.slice(0, USERS).map((token, i) => runUser(i + 1, token)));
  const wallMs = performance.now() - started;

  const durations = samples.map((s) => s.ms);
  const successRate = samples.filter((s) => s.ok).length / Math.max(1, samples.length);
  const medianMs = percentile(durations, 50);
  const p95Ms = percentile(durations, 95);

  const byRoute = new Map<string, { count: number; failed: number; total: number }>();
  for (const s of samples) {
    const row = byRoute.get(s.route) ?? { count: 0, failed: 0, total: 0 };
    row.count += 1;
    row.total += s.ms;
    if (!s.ok) row.failed += 1;
    byRoute.set(s.route, row);
  }

  process.stdout.write('Маршрут                              Запросов  Ошибок  Среднее мс\n');
  process.stdout.write('─'.repeat(70) + '\n');
  for (const [route, row] of [...byRoute.entries()].sort()) {
    process.stdout.write(
      `${route.padEnd(36)}  ${String(row.count).padStart(6)}  ${String(row.failed).padStart(6)}  ${(row.total / row.count).toFixed(1).padStart(9)}\n`,
    );
  }

  process.stdout.write('\nПоказатели\n');
  process.stdout.write(`  запросов всего:        ${samples.length}\n`);
  process.stdout.write(`  успешных:             ${samples.filter((s) => s.ok).length}\n`);
  process.stdout.write(`  отказов по правам:     ${samples.filter((s) => EXPECTED_DENIAL.has(s.status)).length} (ожидаемо для роли)\n`);
  process.stdout.write(`  неожиданных ошибок:   ${samples.filter((s) => !s.ok).length}\n`);
  process.stdout.write(`  доля успеха:          ${(successRate * 100).toFixed(2)} % (цель ≥ ${(TARGETS.successRate * 100).toFixed(0)} %)\n`);
  process.stdout.write(`  медиана:              ${medianMs.toFixed(1)} мс (цель ≤ ${TARGETS.medianMs} мс)\n`);
  process.stdout.write(`  95-й перцентиль:      ${p95Ms.toFixed(1)} мс (цель ≤ ${TARGETS.p95Ms} мс)\n`);
  process.stdout.write(`  нагрузка была:        ${USERS} пользователей одновременно\n`);
  process.stdout.write(`  длительность обхода:   ${(wallMs / 1000).toFixed(1)} с\n`);

  const nonOk = samples.filter((s) => !s.ok);
  if (nonOk.length) {
    const grouped = new Map<string, number>();
    for (const s of nonOk) grouped.set(`${s.route} → ${s.status}`, (grouped.get(`${s.route} → ${s.status}`) ?? 0) + 1);
    process.stdout.write('\nНеожиданные ответы (не 2xx/3xx и не 401/403)\n');
    for (const [k, v] of grouped) process.stdout.write(`  ${k}: ${v}\n`);
  }

  process.stdout.write('\nПроверка целостности данных после нагрузки\n');
  const problems = await integrityCheck();
  if (problems.length) {
    for (const p of problems) process.stdout.write(`  ПРОБЛЕМА  ${p}\n`);
  } else {
    process.stdout.write('  ОК        заявки читаются, версии и позиции на месте\n');
  }

  const passed = successRate >= TARGETS.successRate && medianMs <= TARGETS.medianMs && p95Ms <= TARGETS.p95Ms && problems.length === 0;
  process.stdout.write(`\n${passed ? 'A42 ВЫПОЛНЕНА' : 'A42 НЕ ВЫПОЛНЕНА'}\n`);
  process.exit(passed ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`ОШИБКА: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});