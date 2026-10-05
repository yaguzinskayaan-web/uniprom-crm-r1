import type { FastifyInstance } from 'fastify';
import { ctx, requireAuth } from './context.js';
import { exportApplications, getDashboard, getPipeline, getPlanFact } from '../services/analytics.js';

/**
 * Рабочий стол и аналитика (§10.3). Агрегаты и экспорт используют ту же
 * область видимости, что и списки: чужие данные не раскрываются ни через
 * сводку, ни через выгрузку (A39).
 */
export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  app.get('/api/v1/dashboard', auth, async (req) => {
    const { principal } = ctx(req);
    return getDashboard(req.query as Record<string, unknown>, principal);
  });

  app.get('/api/v1/pipeline', auth, async (req) => {
    const { principal } = ctx(req);
    return getPipeline(req.query as Record<string, unknown>, principal);
  });

  app.get('/api/v1/analytics/plan-fact', auth, async (req) => {
    const { principal } = ctx(req);
    return getPlanFact(req.query as Record<string, unknown>, principal);
  });

  app.get('/api/v1/analytics/applications.csv', auth, async (req, reply) => {
    const { principal } = ctx(req);
    const data = await exportApplications(req.query as Record<string, unknown>, principal);
    const csv = toCsv(data.rows);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="applications.csv"')
      .send(csv);
  });
}

/** IMP-04: значения, начинающиеся с формульного префикса, безопасно экранируются. */
function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const first = rows[0]!;
  const columns: string[] = [];
  for (const [k, v] of Object.entries(first)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const sub of Object.keys(v as Record<string, unknown>)) columns.push(`${k}.${sub}`);
    } else {
      columns.push(k);
    }
  }
  const header = columns.map(escapeCsv).join(';');
  const body = rows
    .map((row) =>
      columns
        .map((col) => {
          const [k, sub] = col.split('.');
          const v = row[k!];
          if (sub) return escapeCsv((v as Record<string, unknown> | null)?.[sub]);
          return escapeCsv(v);
        })
        .join(';'),
    )
    .join('\r\n');
  return `\uFEFF${header}\r\n${body}`;
}
