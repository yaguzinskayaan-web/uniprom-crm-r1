/**
 * Сценарии CRM, которые изменяют данные, в настоящем браузере.
 *
 * Зачем: `ui-check.mjs` только читает экраны, а дефекты чаще всего живут именно
 * в действиях — форма не отправляется, значение не уходит в запрос, ответ
 * разбирается неверно, действие молча ничего не делает. Здесь эти пути
 * проходятся по-настоящему: форма заполняется, кнопка нажимается, результат
 * проверяется и на экране, и через API.
 *
 * Про состояние данных и откат:
 *   - заявку удалить через API нельзя, `DELETE /applications/:number` не существует,
 *     поэтому после успешного прогона мусор убирает backend-скрипт
 *     `npm run test:cleanup`: он трогает только организации с меткой `UI-CHECK`
 *     в названии и ничего больше;
 *   - задача откатывается штатным доменным действием `POST /tasks/:id/cancel`
 *     (в интерфейсе кнопки отмены нет, поэтому откат делается через API);
 *   - при провале сценариев чистка НЕ выполняется: данные оставлены как улика,
 *     удалить их потом можно той же командой вручную.
 *
 * Зависимостей нет: CDP поверх встроенного в Node `WebSocket`.
 *
 * Использование:
 *   cd frontend && npm run ui:flows
 *   npm run ui:flows -- --keep     оставить заявку для разбора, без чистки
 *
 * Переменные окружения те же, что у `ui-check.mjs`: SMOKE_BASE, SMOKE_PASSWORD,
 * UI_CHECK_LOGIN, UI_CHECK_APP_URL, UI_CHECK_CHROME.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, requireServer, sleep, clickTab, clickByText, fillField, fillPlaceholder } from './lib/browser.mjs';

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const APP = value('app', process.env.UI_CHECK_APP_URL ?? 'http://127.0.0.1:5174');
const ORIGIN = value('api', process.env.SMOKE_BASE ?? 'http://127.0.0.1:3001');
const API = `${ORIGIN}/api/v1`;
const LOGIN = value('login', process.env.UI_CHECK_LOGIN ?? 'admin');
const PASSWORD = value('password', process.env.SMOKE_PASSWORD ?? 'Uniprom#2026');
const SETTLE = Number(value('settle', process.env.UI_CHECK_SETTLE ?? '3200'));

let failures = 0;
let checks = 0;

function report(name, problems, extra = '') {
  if (problems.length) failures++;
  console.log(`${problems.length ? 'FAIL' : ' ok '} ${name}${extra}`);
  for (const p of problems) console.log(`       -> ${p}`);
}

async function collect(page, problems, list, timeoutMs = 6000) {
  const { failed, total } = await page.expect(list, timeoutMs);
  checks += total;
  problems.push(...failed);
}

/** Заливка значения в поле по подсказке, как у строк позиций. */
async function fill(page, placeholder, text) {
  const result = await fillPlaceholder(page, placeholder, text);
  if (result !== 'ok') throw new Error(result);
}

/**
 * Количество строки позиции: у неё нет ни подписи, ни placeholder, поэтому
 * берём её по соседству с полем наименования внутри той же строки.
 */
function fillQuantity(page, value) {
  return page.eval(`(() => {
    const name = document.querySelector('input[placeholder="Наименование"]');
    if (!name) return 'нет строки позиции';
    const row = name.closest('div');
    const el = row && row.querySelector('input[type="number"]');
    if (!el) return 'нет поля количества';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
}

async function main() {
  await requireServer(`${ORIGIN}/api/v1/health`, 'Запустите backend: cd backend && npm run dev');
  await requireServer(APP, 'Запустите фронтенд: cd frontend && npm run dev');

  const auth = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  });
  if (!auth.ok) throw new Error(`Не удалось войти ${LOGIN}: HTTP ${auth.status}. Проверьте SMOKE_PASSWORD.`);
  const { token } = await auth.json();
  const api = async (method, path, body) => {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status}: ${JSON.stringify(json)}`);
    return json;
  };

  const stamp = Date.now().toString(36);
  const orgName = `UI-CHECK Проверка ${stamp}`;
  const lineName = `UI-CHECK Клапан ${stamp}`;
  const tag = 'ui-check';
  const taskSubject = `UI-CHECK Задача ${stamp}`;

  const { page, close, chromePath } = await launchBrowser({ settle: SETTLE });
  console.log(`Сценарии с изменением данных: ${APP} (браузер ${chromePath})`);

  await page.goto(`${APP}/login`);
  await page.eval(`localStorage.setItem('uniprom.token', ${JSON.stringify(token)}); true`);

  let created;
  let taskId;

  try {
    // --- Сценарий 1: создание заявки через настоящую форму -------------------
    await page.goto(`${APP}/applications/new`);
    const problems = page.problems(await page.dom());

    for (const [label, value] of [
      ['Организация', orgName],
      ['Контакт', 'UI-CHECK Иванов'],
      ['Телефон', '+7 900 000-00-00'],
      ['E-mail', `ui-check-${stamp}@example.com`],
      ['Вероятность, %', '55'],
      ['Метки через запятую', `${tag}, автотест`],
      ['Комментарий', 'Заявка создана браузерным сценарием проверки.'],
    ]) {
      const result = await fillField(page, label, value);
      if (result !== 'ok') problems.push(`не заполнено поле «${label}»: ${result}`);
    }
    await fill(page, 'Наименование', lineName);
    const quantity = await fillQuantity(page, '3');
    if (quantity !== 'ok') problems.push(`количество позиции: ${quantity}`);
    await fill(page, 'Цена', '12500.50');
    await fill(page, 'Артикул', 'UI-CHECK-ART');

    await collect(page, problems, [
      [
        'значения дошли до полей формы',
        `(() => {
          const byLabel = (t) => {
            const l = Array.from(document.querySelectorAll('label.field')).find((x) => (x.innerText || '').includes(t));
            const el = l && l.querySelector('input, textarea, select');
            return el ? el.value : null;
          };
          return byLabel('Организация') === ${JSON.stringify(orgName)}
            && byLabel('Метки через запятую') === ${JSON.stringify(`${tag}, автотест`)}
            && document.querySelector('input[placeholder="Наименование"]').value === ${JSON.stringify(lineName)};
        })()`,
      ],
      [
        'кнопка создания активна',
        '!Array.from(document.querySelectorAll("button")).find((b) => (b.innerText || "").includes("Создать заявку")).disabled',
      ],
    ]);

    const clicked = await clickByText(page, 'button', 'Создать заявку');
    if (!clicked) problems.push('не нажата кнопка «Создать заявку»');

    // После успешного ответа форма уходит в карточку созданной заявки.
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !/\/applications\/UPC-/.test(await page.url())) await sleep(300);
    created = (await page.url()).match(/\/applications\/(UPC-[\w-]+)/)?.[1];
    if (!created) {
      problems.push(`после отправки не открылась карточка заявки, адрес: ${await page.url()}`);
      report('сценарий 1: создание заявки через форму', problems);
    } else {
      await sleep(1200);
      const dom = await page.dom();
      problems.push(...page.problems(dom));
      await collect(page, problems, [
        ['карточка показывает организацию из формы', `document.body.innerText.includes(${JSON.stringify(orgName)})`],
        ['номер заявки присвоен сервером и показан в карточке', `document.body.innerText.includes(${JSON.stringify(created)})`],
      ]);

      // Проверяем результат ещё и через API: так ловится рассинхрон формы и
      // контракта, который на экране может выглядеть правильно.
      const detail = await api('GET', `/applications/${created}`);
      checks += 1;
      if (detail.organization?.name !== orgName) {
        problems.push(`API вернул организацию «${detail.organization?.name}» вместо «${orgName}»`);
      }
      if (!Array.isArray(detail.tags)) problems.push(`метки пришли не массивом: ${JSON.stringify(detail.tags)}`);
      else if (!detail.tags.includes(tag)) problems.push(`в метках нет «${tag}»: ${JSON.stringify(detail.tags)}`);
      if ((detail.lines ?? []).length !== 1 || detail.lines[0].name !== lineName) {
        problems.push(`позиция не сохранилась: ${JSON.stringify(detail.lines)}`);
      }
      report('сценарий 1: создание заявки через форму', problems, ` — создана ${created}`);
    }
  } catch (e) {
    failures++;
    console.log(`FAIL сценарий 1: создание заявки через форму — ${e.message}`);
  }

  if (created) {
    try {
      // --- Сценарий 2: задача через интерфейс и откат через API -------------
      page.resetBucket();
      await page.goto(`${APP}/applications/${created}`);
      await clickTab(page, 'Задачи');
      await sleep(1000);

      const problems = page.problems(await page.dom());
      if (!(await clickByText(page, 'button', 'Новая задача'))) problems.push('не нажата кнопка «Новая задача»');
      await sleep(800);

      for (const [label, value] of [
        ['Тема', taskSubject],
        ['Срок', '2026-12-31T18:00'],
      ]) {
        const result = await fillField(page, label, value);
        if (result !== 'ok') problems.push(`не заполнено поле «${label}»: ${result}`);
      }
      if (!(await clickByText(page, 'button', 'Создать задачу'))) problems.push('не нажата кнопка «Создать задачу»');

      await collect(page, problems, [
        ['задача появилась в таблице', `document.body.innerText.includes(${JSON.stringify(taskSubject)})`],
        [
          'модальное окно закрылось после отправки',
          'document.querySelector(".modal") === null',
        ],
      ]);

      const detail = await api('GET', `/applications/${created}`);
      const task = (detail.tasks ?? []).find((t) => t.subject === taskSubject);
      if (!task) problems.push('задача не появилась в ответе API');
      else {
        taskId = task.id;
        // Откат: в интерфейсе кнопки отмены нет, отменяем штатным доменным действием.
        // Причина обязательна по контракту, иначе сервер отвечает 422.
        await api('POST', `/tasks/${taskId}/cancel`, { reason: 'Откат браузерного сценария проверки' });
        const after = await api('GET', `/applications/${created}`);
        const cancelled = (after.tasks ?? []).find((t) => t.id === taskId);
        checks += 1;
        if (cancelled?.status !== 'CANCELLED') problems.push(`откат не сработал, статус задачи: ${cancelled?.status}`);
      }
      report(
        'сценарий 2: задача через интерфейс с откатом',
        problems,
        taskId ? ` — задача ${taskId} отменена через API` : '',
      );
    } catch (e) {
      failures++;
      console.log(`FAIL сценарий 2: задача через интерфейс — ${e.message}`);
    }
  }

  console.log(`\nИтог: сценариев с дефектами ${failures}; проверок ${checks}`);

  await close();
  await cleanup(failures, created, orgName);
  process.exit(failures ? 1 : 0);
}

/**
 * Убирает созданную заявку через backend-скрипт: в API удаления нет, а мусор в
 * базе — это тоже дефект процесса. При провале сценариев данные остаются как
 * улика, иначе нечего будет разбирать.
 */
async function cleanup(failures, created, orgName) {
  if (!created) {
    console.log('Заявка не создана, чистка не требуется.');
    return;
  }
  if (failures) {
    console.log(`Сценарии провалены, данные оставлены для разбора: ${created} («${orgName}»).`);
    console.log(`Удалить позже: cd backend && npm run test:cleanup -- --marker=UI-CHECK`);
    return;
  }
  if (KEEP) {
    console.log(`--keep: заявка ${created} («${orgName}») оставлена.`);
    return;
  }

  const cwd = fileURLToPath(new URL('../../backend', import.meta.url));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log(`\nЧистка тестовых данных (${created})…`);
  const code = await new Promise((resolve) => {
    const child = spawn(npm, ['run', 'test:cleanup', '--', '--marker=UI-CHECK'], {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', () => resolve(-1));
    child.on('close', resolve);
  });
  if (code !== 0) {
    console.warn(`ВНИМАНИЕ: чистка не удалась (код ${code}). Заявка ${created} осталась в базе.`);
    console.warn('Удалить вручную: cd backend && npm run test:cleanup -- --marker=UI-CHECK');
  }
}

main().catch((e) => {
  console.error(`СБОЙ: ${e.message}`);
  process.exit(1);
});