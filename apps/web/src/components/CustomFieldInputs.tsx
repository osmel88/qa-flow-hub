import type {
  CustomFieldEntity,
  CustomFieldValue,
  CustomFieldValues,
  CustomFieldView,
} from '@qa-flow-hub/shared';
import { useQuery } from '@tanstack/react-query';
import { customFieldsApi } from '../api/endpoints';

/** Values being edited: `null` marks a field the user cleared. */
export type CustomFieldDraft = Record<string, CustomFieldValue | null>;

export function useCustomFields(
  projectId: string | null,
  entityType: CustomFieldEntity,
): CustomFieldView[] {
  const fields = useQuery({
    queryKey: ['custom-fields', projectId, entityType],
    queryFn: () => customFieldsApi.list(projectId ?? '', entityType),
    enabled: projectId !== null,
  });
  return fields.data ?? [];
}

/** Readable value of one field, resolving option ids to labels. */
export function formatCustomValue(field: CustomFieldView, value: CustomFieldValue): string {
  const label = (id: string): string =>
    field.options.find((option) => option.id === id)?.label ?? id;
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (field.type === 'select' && typeof value === 'string') return label(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function CustomFieldSummary({
  fields,
  values,
}: {
  fields: CustomFieldView[];
  values: CustomFieldValues;
}): React.JSX.Element | null {
  const shown = fields.filter((field) => values[field.id] !== undefined);
  if (shown.length === 0) return null;
  return (
    <span className="muted">
      {shown
        .map(
          (field) =>
            `${field.label}: ${formatCustomValue(field, values[field.id] as CustomFieldValue)}`,
        )
        .join(' · ')}
    </span>
  );
}

interface CustomFieldInputsProps {
  fields: CustomFieldView[];
  values: CustomFieldValues;
  draft: CustomFieldDraft;
  onChange: (draft: CustomFieldDraft) => void;
}

/**
 * One input per active definition. The server validates again; this only
 * keeps the form from offering what it would refuse.
 */
export function CustomFieldInputs({
  fields,
  values,
  draft,
  onChange,
}: CustomFieldInputsProps): React.JSX.Element | null {
  if (fields.length === 0) return null;
  const current = (id: string): CustomFieldValue | null =>
    id in draft ? (draft[id] ?? null) : (values[id] ?? null);
  const set = (id: string, value: CustomFieldValue | null): void => {
    onChange({ ...draft, [id]: value });
  };

  return (
    <fieldset className="custom-fields">
      <legend>Custom fields</legend>
      {fields.map((field) => {
        const value = current(field.id);
        const inputId = `cf-${field.id}`;
        const label = `${field.label}${field.required ? ' *' : ''}`;
        const chosen = new Set(
          Array.isArray(value) ? value : value === null ? [] : [String(value)],
        );
        const options = field.options.filter((option) => !option.archived || chosen.has(option.id));
        return (
          <div key={field.id} className="ui-field">
            <label className="ui-field__label" htmlFor={inputId}>
              {label}
            </label>
            {field.type === 'boolean' ? (
              <select
                id={inputId}
                className="ui-input"
                value={value === null ? '' : String(value)}
                onChange={(event) => {
                  set(field.id, event.target.value === '' ? null : event.target.value === 'true');
                }}
              >
                <option value="">—</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : field.type === 'select' ? (
              <select
                id={inputId}
                className="ui-input"
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => {
                  set(field.id, event.target.value === '' ? null : event.target.value);
                }}
              >
                <option value="">—</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === 'multi_select' ? (
              <select
                id={inputId}
                className="ui-input"
                multiple
                value={[...chosen]}
                onChange={(event) => {
                  const selected = [...event.target.selectedOptions].map((option) => option.value);
                  set(field.id, selected.length === 0 ? null : selected);
                }}
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={inputId}
                className="ui-input"
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                value={value === null ? '' : String(value)}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw === '') set(field.id, null);
                  else set(field.id, field.type === 'number' ? Number(raw) : raw);
                }}
              />
            )}
            {field.description !== null && <p className="ui-field__hint">{field.description}</p>}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Drops cleared fields on create, where there is nothing to clear. */
export function draftForCreate(draft: CustomFieldDraft): CustomFieldValues {
  return Object.fromEntries(
    Object.entries(draft).filter((entry): entry is [string, CustomFieldValue] => entry[1] !== null),
  );
}
