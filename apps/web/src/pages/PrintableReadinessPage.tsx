import { DataState } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { releasesApi } from '../api/endpoints';
import { ReadinessReport } from '../components/ReleaseReadiness';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';
import { PrintToolbar } from './PrintableMatrixPage';

/** Print-friendly release readiness report (S7-F8), from the same API view as Release Detail. */
export function PrintableReadinessPage(): React.JSX.Element {
  const { releaseId = '' } = useParams();
  const readiness = useQuery({
    queryKey: ['releases', 'readiness', releaseId],
    queryFn: () => releasesApi.readiness(releaseId),
  });
  const view = readiness.data;

  return (
    <main className="print-page">
      <PrintToolbar />
      <DataState isPending={readiness.isPending} error={readiness.error}>
        {view !== undefined && (
          <>
            <h1>
              {t('releaseReadiness.printTitle')}: {view.release.name} · {view.release.version}
            </h1>
            <p className="muted">
              {t('releaseReadiness.project')}: {view.project.key} · {view.project.name} ·{' '}
              {t('releaseReadiness.generated')} {formatDateTime(view.computedAt)}
            </p>
            <ReadinessReport view={view} />
          </>
        )}
      </DataState>
    </main>
  );
}
