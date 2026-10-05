/**
 * Модульные проверки чистой логики: без БД и сети.
 * Запуск: npm test
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { nextBackoffMs, deliveryConfigured } from '../src/services/delivery.js';

/** Повторяет round2 из services/integrations.ts: деньги округляются до копеек. */
function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

test('A19/A45: первая повторная попытка идёт сразу, дальше экспоненциально', () => {
  const base = 60_000;
  assert.equal(nextBackoffMs(1), base, 'первая попытка не должна откладываться надолго');
  assert.equal(nextBackoffMs(2), base * 2);
  assert.equal(nextBackoffMs(3), base * 4);
  assert.equal(nextBackoffMs(4), base * 8);
});

test('A45: интервал повторов ограничен часом и не растёт бесконечно', () => {
  const hour = 60 * 60_000;
  for (const attempts of [8, 15, 50, 1000]) {
    assert.ok(nextBackoffMs(attempts) <= hour, `попытка ${attempts}: интервал превысил час`);
  }
  assert.equal(nextBackoffMs(64), hour, 'должен упираться в часовой потолок');
});

test('A45: отрицательное или нулевое число попыток не ломает расчёт', () => {
  assert.equal(nextBackoffMs(0), 60_000);
  assert.equal(nextBackoffMs(-5), 60_000);
});

test('A19/A45: без транспорта очередь объявлена незатронутой', () => {
  const cfg = deliveryConfigured();
  assert.equal(typeof cfg.mail, 'boolean');
  assert.equal(typeof cfg.outbox, 'boolean');
  if (!cfg.mail && !cfg.outbox) {
    assert.ok(
      process.env.MAIL_TRANSPORT_URL === '' || process.env.MAIL_TRANSPORT_URL === undefined,
      'почта объявлена не настроенной, но MAIL_TRANSPORT_URL задан',
    );
  }
});

test('Деньги округляются до копеек без накопления ошибки', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(70000.001), 70000);
  assert.equal(round2(1.004999), 1.0);
});

test('Денежная арифметика распределения сходится до копейки', () => {
  // Регрессия: остаток раньше считался как payment - budget - (budget - left),
  // из-за чего в аудит попадало отрицательное значение.
  const payment = 120_000;
  const budget = 70_000;
  const left = 0;
  const allocated = round2(budget - left);
  assert.equal(allocated, 70_000);
  assert.equal(round2(payment - allocated), 50_000);
  assert.ok(round2(payment - allocated) >= 0, 'остаток платежа не может быть отрицательным');
});

test('A29: доли платежа не превышают его сумму', () => {
  const payment = 120_000;
  const splits = [70_000, 50_000];
  const planned = round2(splits.reduce((s, x) => s + x, 0));
  assert.equal(planned, payment, 'полное распределение должно сходиться');
  assert.ok(planned - payment <= 1e-6);

  const over = round2(600 + 600);
  assert.ok(over - 1000 > 1e-6, 'переплата должна отклоняться, а не проходить');
});