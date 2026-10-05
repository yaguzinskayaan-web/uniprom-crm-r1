import { http } from '../../api/client';
import { Button, Empty, ErrorMessage, Loading, useAsync } from '../../components/ui';

interface ReferenceItem {
  id: string;
  kind: string;
  code: string;
  label: string;
  isActive: boolean;
}

/** Справочники: базовая поддержка чтения (администрирование заполняется через API). */
export function AdminReferencesPage() {
  const references = useAsync((signal) => http.get<ReferenceItem[]>('/references?active=false', signal), []);

  return (
    <>
      <div className="row row--wrap">
        <div>
          <h1>Справочники</h1>
          <div className="subtle">Справочники этапов, причин отказов и типов заполняются ядром и выгружаются для чтения</div>
        </div>
        <div className="card__spacer" />
        <Button variant="ghost" onClick={() => references.reload()}>
          Обновить
        </Button>
      </div>

      {references.error ? <ErrorMessage error={references.error} /> : null}

      {references.loading ? (
        <Loading />
      ) : (references.data?.length ?? 0) === 0 ? (
        <Empty>Элементов не найдено</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Вид</th>
                <th>Код</th>
                <th>Название</th>
                <th>Активен</th>
              </tr>
            </thead>
            <tbody>
              {references.data!.map((item) => (
                <tr key={item.id}>
                  <td className="mono">{item.kind}</td>
                  <td className="mono">{item.code}</td>
                  <td>{item.label}</td>
                  <td>{item.isActive ? 'да' : 'нет'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}