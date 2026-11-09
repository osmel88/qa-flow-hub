import { PARAMETER_TYPES, formatParameterValue, parseParameterCell } from '@qa-flow-hub/shared';
import type {
  ParameterType,
  ParameterValue,
  ReplaceParametersInput,
  TestCaseDetailView,
} from '@qa-flow-hub/shared';
import { Button, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { testDesignApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { ExportButton } from '../components/ExportButton';

interface DraftParameter {
  name: string;
  type: ParameterType;
  required: boolean;
  defaultText: string;
}

interface DraftRow {
  id?: string;
  label: string;
  cells: Record<string, string>;
}

function draftOf(detail: TestCaseDetailView): { parameters: DraftParameter[]; rows: DraftRow[] } {
  return {
    parameters: detail.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      required: parameter.required,
      defaultText: formatParameterValue(parameter.defaultValue),
    })),
    rows: detail.dataset.map((row) => ({
      id: row.id,
      label: row.label,
      cells: Object.fromEntries(
        Object.entries(row.values).map(([name, value]) => [name, formatParameterValue(value)]),
      ),
    })),
  };
}

/** Turns the text the editor holds into typed values, or the first problem found. */
function toInput(
  parameters: DraftParameter[],
  rows: DraftRow[],
  version: number,
): ReplaceParametersInput | string {
  const typed: ReplaceParametersInput['parameters'] = [];
  for (const parameter of parameters) {
    const parsed = parseParameterCell(parameter.type, parameter.defaultText);
    if ('error' in parsed) {
      return `The default of ${parameter.name || 'a parameter'} ${parsed.error}`;
    }
    typed.push({
      name: parameter.name.trim(),
      type: parameter.type,
      required: parameter.required,
      defaultValue: parsed.value,
    });
  }
  const typedRows: ReplaceParametersInput['rows'] = [];
  for (const [index, row] of rows.entries()) {
    const values: Record<string, ParameterValue | null> = {};
    for (const parameter of parameters) {
      const parsed = parseParameterCell(parameter.type, row.cells[parameter.name] ?? '');
      if ('error' in parsed) {
        return `Row ${index + 1}: ${parameter.name} ${parsed.error}`;
      }
      values[parameter.name.trim()] = parsed.value;
    }
    typedRows.push({
      ...(row.id === undefined ? {} : { id: row.id }),
      ...(row.label.trim() === '' ? {} : { label: row.label.trim() }),
      values,
    });
  }
  return { parameters: typed, rows: typedRows, version };
}

/**
 * Parameters and dataset of a case (S7-F3). They are saved as one definition
 * and bump the case version; runs created before keep the values they froze.
 */
export function TestCaseParameters({
  detail,
  canImport,
  canExport,
}: {
  detail: TestCaseDetailView;
  canImport: boolean;
  canExport: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [parameters, setParameters] = useState<DraftParameter[]>([]);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const draft = draftOf(detail);
    setParameters(draft.parameters);
    setRows(draft.rows);
  }, [detail]);

  const onSaved = async (updated: TestCaseDetailView, what: string) => {
    setError(null);
    setSaved(`${what} as version ${updated.version}.`);
    queryClient.setQueryData(['case', detail.id], updated);
    await queryClient.invalidateQueries({ queryKey: ['cases'] });
  };
  const onError = (cause: unknown) => {
    setSaved(null);
    setError(cause instanceof ApiError ? describe(cause) : 'Could not save the dataset.');
  };

  const save = useMutation({
    mutationFn: (input: ReplaceParametersInput) =>
      testDesignApi.replaceParameters(detail.id, input),
    onSuccess: (updated) => onSaved(updated, 'Parameters saved'),
    onError,
  });
  const importCsv = useMutation({
    mutationFn: (csv: string) =>
      testDesignApi.importDataset(detail.id, { csv, version: detail.version }),
    onSuccess: (updated) => onSaved(updated, 'Dataset imported'),
    onError,
  });

  const touch = () => {
    setSaved(null);
  };
  const updateParameter = (index: number, patch: Partial<DraftParameter>) => {
    touch();
    setParameters((current) =>
      current.map((parameter, position) =>
        position === index ? { ...parameter, ...patch } : parameter,
      ),
    );
  };
  const updateCell = (index: number, name: string, text: string) => {
    touch();
    setRows((current) =>
      current.map((row, position) =>
        position === index ? { ...row, cells: { ...row.cells, [name]: text } } : row,
      ),
    );
  };

  return (
    <section className="card" aria-label="Parameters and dataset">
      <h2>Parameters and dataset</h2>
      <p className="muted">
        A run executes this case once per dataset row and keeps the values it used.
      </p>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {saved !== null && (
        <p className="ui-state" role="status">
          {saved}
        </p>
      )}

      {parameters.length === 0 && <p className="muted">No parameters: the case runs once.</p>}
      <ul className="plain-list">
        {parameters.map((parameter, index) => (
          <li key={index} className="row-actions">
            <TextField
              label={`Parameter ${index + 1} name`}
              value={parameter.name}
              onChange={(event) => {
                const previous = parameter.name;
                const name = event.target.value;
                updateParameter(index, { name });
                setRows((current) =>
                  current.map((row) => {
                    const { [previous]: text = '', ...rest } = row.cells;
                    return { ...row, cells: { ...rest, [name]: text } };
                  }),
                );
              }}
            />
            <label className="ui-field">
              <span className="ui-field__label">{`Parameter ${index + 1} type`}</span>
              <select
                value={parameter.type}
                onChange={(event) => {
                  updateParameter(index, { type: event.target.value as ParameterType });
                }}
              >
                {PARAMETER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={parameter.required}
                onChange={(event) => {
                  updateParameter(index, { required: event.target.checked });
                }}
              />{' '}
              {`Parameter ${index + 1} required`}
            </label>
            <TextField
              label={`Parameter ${index + 1} default`}
              value={parameter.defaultText}
              onChange={(event) => {
                updateParameter(index, { defaultText: event.target.value });
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                touch();
                setParameters((current) => current.filter((_, position) => position !== index));
              }}
            >
              Remove parameter {index + 1}
            </Button>
          </li>
        ))}
      </ul>

      {parameters.length > 0 && (
        <table aria-label="Dataset">
          <thead>
            <tr>
              <th>Row</th>
              {parameters.map((parameter, index) => (
                <th key={index}>
                  {parameter.name} <span className="muted">({parameter.type})</span>
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id ?? `new-${index}`}>
                <td>
                  <input
                    aria-label={`Row ${index + 1} label`}
                    value={row.label}
                    onChange={(event) => {
                      touch();
                      setRows((current) =>
                        current.map((entry, position) =>
                          position === index ? { ...entry, label: event.target.value } : entry,
                        ),
                      );
                    }}
                  />
                </td>
                {parameters.map((parameter, column) => (
                  <td key={column}>
                    <input
                      aria-label={`Row ${index + 1} ${parameter.name}`}
                      value={row.cells[parameter.name] ?? ''}
                      onChange={(event) => {
                        updateCell(index, parameter.name, event.target.value);
                      }}
                    />
                  </td>
                ))}
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      touch();
                      setRows((current) => current.filter((_, position) => position !== index));
                    }}
                  >
                    Remove row {index + 1}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row-actions">
        <Button
          variant="secondary"
          onClick={() => {
            touch();
            setParameters((current) => [
              ...current,
              { name: '', type: 'string', required: false, defaultText: '' },
            ]);
          }}
        >
          Add parameter
        </Button>
        <Button
          variant="secondary"
          disabled={parameters.length === 0}
          onClick={() => {
            touch();
            setRows((current) => [...current, { label: '', cells: {} }]);
          }}
        >
          Add row
        </Button>
        <Button
          loading={save.isPending}
          onClick={() => {
            const input = toInput(parameters, rows, detail.version);
            if (typeof input === 'string') {
              setSaved(null);
              setError(input);
            } else {
              save.mutate(input);
            }
          }}
        >
          Save parameters
        </Button>
        {canExport && detail.parameters.length > 0 && (
          <ExportButton
            label="Export dataset CSV"
            fallbackName={`${detail.key}-dataset.csv`}
            download={() => testDesignApi.exportDataset(detail.id)}
          />
        )}
        {canImport && detail.parameters.length > 0 && (
          <label>
            Import dataset CSV{' '}
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Import dataset CSV"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file !== undefined) {
                  void file.text().then((csv) => {
                    importCsv.mutate(csv);
                  });
                }
              }}
            />
          </label>
        )}
      </div>
    </section>
  );
}

function describe(cause: ApiError): string {
  const details = (cause as ApiError & { details?: unknown }).details;
  if (Array.isArray(details)) {
    const messages = details
      .map((entry) =>
        typeof entry === 'object' && entry !== null && 'message' in entry
          ? String((entry as { message: unknown }).message)
          : null,
      )
      .filter((message): message is string => message !== null);
    if (messages.length > 0) {
      return messages.join('; ');
    }
  }
  return cause.message;
}
