import { Button } from '@qa-flow-hub/ui';
import { useMutation } from '@tanstack/react-query';
import { saveBlob } from './download';

/**
 * Downloads a CSV export through the authenticated fetch (a plain link would
 * not carry the bearer token). The file name comes from the API.
 */
export function ExportButton({
  label,
  fallbackName,
  download,
}: {
  label: string;
  fallbackName: string;
  download: () => Promise<{ blob: Blob; fileName: string | null }>;
}): React.JSX.Element {
  const exportCsv = useMutation({
    mutationFn: download,
    onSuccess: ({ blob, fileName }) => {
      saveBlob(blob, fileName ?? fallbackName);
    },
  });

  return (
    <span className="export-button">
      <Button
        type="button"
        variant="secondary"
        disabled={exportCsv.isPending}
        onClick={() => {
          exportCsv.mutate();
        }}
      >
        {exportCsv.isPending ? 'Exporting…' : label}
      </Button>
      {exportCsv.error !== null && (
        <span className="ui-field__error" role="alert">
          {exportCsv.error.message}
        </span>
      )}
    </span>
  );
}
