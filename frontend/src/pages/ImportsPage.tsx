import { useState } from 'react';
import { http } from '../api/client';
import type { ImportBatch, ImportCommitResult, ImportIssue, ImportValidateResult } from '../api/types';
import { Button, Empty, ErrorMessage, Field, Loading, StatusBadge, formatDateTime, useAsync } from '../components/ui';

const MAPPING_FIELDS: { key: string; label: string; required: boolean }[] = [
  { key: 'groupId', label: 'Идентификатор группы (заявки)', required: true },
  { key: 'organizationName', label: 'Организация', required: true },
  { key: 'lineName', label: 'Номенклатура', required: true },
  { key: 'quantity', label: 'Количество', required: true },
  { key: 'externalNumber', label: 'Внешний номер', required: false },
  { key: 'inn', label: 'ИНН', required: false },
  { key: 'kpp', label: 'КПП', required: false },
  { key: 'contactName', label: 'Контакт', required: false },
  { key: 'contactPhone', label: 'Телефон', required: false },
  { key: 'contactEmail', label: 'E-mail', required: false },
  { key: 'lineId', label: 'Артикул позиции', required: false },
  { key: 'unit', label: 'Единица', required: false },
  { key: 'price', label: 'Цена', required: false },
];

/** Ответ `POST /imports/inspect`: заголовки файла до сопоставления колонок. */
interface InspectResult {
  fileName: string;
  format: 'XLSX' | 'CSV';
  headers: string[];
  rowCount: number;
  limit: number;
  sample: Record<string, string>[];
}

/** Локальный предпросмотр: подтверждение групп, которые уедут в базу. */
interface PreviewState {
  batchId: string;
  fileName: string;
  format: string;
  preview: ImportValidateResult['preview'];
  issues: ImportIssue[];
  rejectedGroups: string[];
  duplicateOf: string | null;
  totalRows: number;
}

/**
 * §5.3 импорт: файл Excel/CSV разбирается на сервере, затем сопоставление
 * колонок → проверка без создания заявок → загрузка корректных групп целиком
 * (IMP-03).
 */
export function ImportsPage() {
  const batches = useAsync((signal) => http.get<ImportBatch[]>('/imports', signal), []);
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [created, setCreated] = useState<ImportCommitResult['created'] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const chooseFile = async (chosen: File) => {
    setError(null);
    setPreview(null);
    setCreated(null);
    setSelected([]);
    setFile(chosen);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', chosen);
      const result = await http.upload<InspectResult>('/imports/inspect', form);
      setInspect(result);
      setMapping(autoMapping(result.headers));
    } catch (err) {
      setInspect(null);
      setFile(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const validate = async () => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('mapping', JSON.stringify(Object.fromEntries(MAPPING_FIELDS.map((f) => [f.key, mapping[f.key] ?? '']))));
      const result = await http.upload<ImportValidateResult>('/imports/upload', form);
      if ('error' in result) throw new Error(String(result.error));
      setPreview({
        batchId: result.batch.id,
        fileName: result.batch.fileName,
        format: result.batch.sourceKey ?? 'CSV',
        preview: result.preview,
        issues: result.issues,
        rejectedGroups: result.rejectedGroups,
        duplicateOf: result.duplicateOf,
        totalRows: result.batch.totalRows,
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (onlyGroupIds?: string[]) => {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const result = await http.post<ImportCommitResult>(`/imports/${preview.batchId}/confirm`, { onlyGroupIds });
      setCreated(result.created);
      setPreview(null);
      setSelected([]);
      batches.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const correctGroups = (preview?.preview ?? []).filter((g) => !preview?.rejectedGroups.includes(g.groupId));
  const rejected = (preview?.preview ?? []).filter((g) => preview?.rejectedGroups.includes(g.groupId));

  return (
    <>
      <div>
        <h1>Импорт заявок</h1>
        <div className="subtle">
          Файлы Excel (.xlsx) и CSV, до 5000 строк; проверка выполняется до создания заявок, половина группы не импортируется (IMP-03)
        </div>
      </div>

      {error && <ErrorMessage error={error} />}

      <div className="card">
        <div className="card__head">
          <h2>Файл</h2>
        </div>
        <div className="row row--wrap">
          <input
            type="file"
            accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen) void chooseFile(chosen);
            }}
          />
          <span className="subtle">
            {busy && !inspect ? 'Разбор файла…' : file?.name || 'файл не выбран'}
          </span>
          {inspect && (
            <span className="subtle">
              {inspect.format === 'XLSX' ? 'Excel' : 'CSV'}, строк: {inspect.rowCount}
              {inspect.rowCount > inspect.limit ? ` (превышен лимит ${inspect.limit})` : ''}
            </span>
          )}
        </div>

        {inspect && inspect.headers.length > 0 && (
          <>
            <div className="divider" />
            <h3>Сопоставление колонок</h3>
            <div className="subtle">
              Обязательные поля отмечены знаком *. Макросы и формулы не исполняются — читается только текст ячеек (IMP-01)
            </div>
            <div className="form-grid">
              {MAPPING_FIELDS.map((field) => (
                <Field key={field.key} label={`${field.label}${field.required ? ' *' : ''}`}>
                  <select
                    value={mapping[field.key] ?? ''}
                    onChange={(e) => setMapping((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  >
                    <option value="">Не использовать</option>
                    {inspect.headers.map((column) => (
                      <option key={column} value={column}>
                        {column}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            {inspect.sample.length > 0 && (
              <>
                <div className="divider" />
                <h3>Первые строки файла</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {inspect.headers.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {inspect.sample.map((row, i) => (
                        <tr key={i}>
                          {inspect.headers.map((column) => (
                            <td key={column}>{row[column]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="form-actions">
              <Button busy={busy} disabled={inspect.rowCount === 0 || inspect.rowCount > inspect.limit} onClick={validate}>
                Проверить файл
              </Button>
              <span className="subtle">Строк в файле: {inspect.rowCount}</span>
            </div>
          </>
        )}
      </div>

      {preview && (
        <div className="card">
          <div className="card__head">
            <h2>Результат проверки</h2>
            <div className="card__spacer" />
            <StatusBadge status="VALIDATED" />
          </div>
          <div className="subtle">
            {preview.fileName} ({preview.format}) — строк: {preview.totalRows}
          </div>

          {preview.duplicateOf && (
            <div className="alert alert--warn" style={{ marginTop: 8 }}>
              Загружаемый пакет совпадает с ранее загруженным (IMP-03). Повторная загрузка ничего не перезаписывает.
            </div>
          )}

          <div className="grid grid--4" style={{ marginTop: 12 }}>
            <div className="stat">
              <div className="stat__label">Строк</div>
              <div className="stat__value">{preview.totalRows}</div>
            </div>
            <div className="stat">
              <div className="stat__label">Групп к импорту</div>
              <div className="stat__value" style={{ color: 'var(--success)' }}>
                {correctGroups.length}
              </div>
            </div>
            <div className="stat">
              <div className="stat__label">Групп с ошибками</div>
              <div className="stat__value" style={{ color: preview.rejectedGroups.length > 0 ? 'var(--danger)' : undefined }}>
                {preview.rejectedGroups.length}
              </div>
            </div>
            <div className="stat">
              <div className="stat__label">Ошибок в строках</div>
              <div className="stat__value" style={{ color: preview.issues.length > 0 ? 'var(--danger)' : undefined }}>
                {preview.issues.length}
              </div>
            </div>
          </div>

          {preview.issues.length > 0 && (
            <>
              <div className="divider" />
              <h3>Ошибки строк</h3>
              <div className="subtle">Группа с любой ошибочной строкой не импортируется целиком (IMP-03)</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="num">Строка</th>
                      <th>Поле</th>
                      <th>Причина</th>
                      <th>Как исправить</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.issues.slice(0, 50).map((item, i) => (
                      <tr key={`${item.rowNo}-${item.field}-${i}`}>
                        <td className="num">{item.rowNo}</td>
                        <td className="mono">{item.field}</td>
                        <td>{item.reason}</td>
                        <td>{item.fix}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {correctGroups.length > 0 && (
            <>
              <div className="divider" />
              <h3>Группы к импорту</h3>
              <div className="row row--wrap" style={{ marginBottom: 8 }}>
                <Button variant="ghost" className="btn--sm" onClick={() => setSelected(correctGroups.map((g) => g.groupId))}>
                  Выбрать все корректные
                </Button>
                <Button variant="ghost" className="btn--sm" onClick={() => setSelected([])}>
                  Снять выбор
                </Button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th />
                      <th>Группа</th>
                      <th>Организация</th>
                      <th className="num">Строк</th>
                      <th className="num">Кол-во</th>
                      <th className="num">Сумма</th>
                      <th>Примечание</th>
                    </tr>
                  </thead>
                  <tbody>
                    {correctGroups.map((group) => (
                      <tr key={group.groupId}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.includes(group.groupId)}
                            onChange={(e) =>
                              setSelected((prev) =>
                                e.target.checked ? [...prev, group.groupId] : prev.filter((g) => g !== group.groupId),
                              )
                            }
                          />
                        </td>
                        <td className="mono">{group.groupId}</td>
                        <td>
                          {group.organizationName}
                          {group.inn ? ` · ИНН ${group.inn}` : ''}
                        </td>
                        <td className="num">{group.rows}</td>
                        <td className="num">{group.totalQty}</td>
                        <td className="num">{group.totalAmount.toLocaleString('ru-RU')}</td>
                        <td className="subtle">{group.duplicateHint ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="form-actions">
                <Button busy={busy} disabled={selected.length === 0} onClick={() => confirm(selected)}>
                  Импортировать выбранные ({selected.length})
                </Button>
                <Button variant="ghost" busy={busy} disabled={preview.rejectedGroups.length > 0} onClick={() => confirm()}>
                  Импортировать все корректные группы
                </Button>
              </div>
              {preview.rejectedGroups.length > 0 && (
                <div className="subtle">
                  Чтобы загрузить все корректные группы разом, сначала исправьте группы с ошибками:{' '}
                  {rejected.map((g) => g.groupId).join(', ')}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {created && (
        <div className="card">
          <div className="card__head">
            <h2>Создано заявок: {created.length}</h2>
          </div>
          {created.length === 0 ? (
            <Empty>Заявок не создано</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Группа</th>
                    <th>Номер заявки</th>
                    <th>Примечание</th>
                  </tr>
                </thead>
                <tbody>
                  {created.map((item) => (
                    <tr key={item.groupId}>
                      <td className="mono">{item.groupId}</td>
                      <td>
                        <a href={`/applications/${item.number}`}>{item.number}</a>
                      </td>
                      <td className="subtle">{item.deduplicated ? 'уже существовала (дубль не создан)' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card__head">
          <h2>История импортов</h2>
        </div>
        {batches.loading ? (
          <Loading />
        ) : (batches.data?.length ?? 0) === 0 ? (
          <Empty>Импортов не было</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Файл</th>
                  <th>Создан</th>
                  <th>Статус</th>
                  <th className="num">Строк</th>
                  <th className="num">Групп</th>
                  <th className="num">Ошибок</th>
                </tr>
              </thead>
              <tbody>
                {batches.data!.map((item) => (
                  <tr key={item.id}>
                    <td>{item.fileName}</td>
                    <td className="nowrap">{formatDateTime(item.createdAt)}</td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="num">{item.totalRows}</td>
                    <td className="num">{item.validGroups}</td>
                    <td className="num" style={{ color: item.errorGroups > 0 ? 'var(--danger)' : undefined }}>
                      {item.errorGroups}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/** Угадывание колонок по типовым заголовкам российских выгрузок. */
function autoMapping(columns: string[]): Record<string, string> {
  const find = (patterns: RegExp) => columns.find((c) => patterns.test(c)) ?? '';
  return {
    groupId: find(/заявк|заказ|group|request/i),
    organizationName: find(/организац|контрагент|клиент|company|customer/i),
    lineName: find(/номенклатур|наименование|товар|позици/i),
    quantity: find(/количество|кол-во|qty|quantity/i),
    externalNumber: find(/внешн|номер заказа|^no$/i),
    inn: find(/^инн$|inn/i),
    kpp: find(/кпп|kpp/i),
    contactName: find(/контакт/i),
    contactPhone: find(/телефон|phone/i),
    contactEmail: find(/email|почт/i),
    lineId: find(/артикул|sku|код/i),
    unit: find(/единиц|unit/i),
    price: find(/цена|price/i),
  };
}