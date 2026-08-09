import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';

interface FieldShellProps {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/**
 * One shell for every control. The label is always a real `<label for>`, the
 * error is announced through `aria-describedby` and `aria-invalid`, and the id
 * comes from `useId` so a form can render the same field twice without
 * colliding. Placeholder-as-label is the single most common accessibility bug
 * in admin UIs and this makes it impossible here.
 */
function FieldShell({ label, error, hint, children }: FieldShellProps): React.JSX.Element {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy =
    [error === undefined ? undefined : errorId, hint === undefined ? undefined : hintId]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy, invalid: error !== undefined })}
      {hint !== undefined && (
        <p className="ui-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p className="ui-field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
};

export function TextField({ label, error, hint, ...rest }: TextFieldProps): React.JSX.Element {
  return (
    <FieldShell label={label} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <input
          {...rest}
          id={id}
          className="ui-input"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      )}
    </FieldShell>
  );
}

export type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
};

export function TextAreaField({
  label,
  error,
  hint,
  ...rest
}: TextAreaFieldProps): React.JSX.Element {
  return (
    <FieldShell label={label} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <textarea
          {...rest}
          id={id}
          className="ui-input ui-input--textarea"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      )}
    </FieldShell>
  );
}

export type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  options: Array<{ value: string; label: string }>;
};

export function SelectField({
  label,
  error,
  hint,
  options,
  ...rest
}: SelectFieldProps): React.JSX.Element {
  return (
    <FieldShell label={label} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <select
          {...rest}
          id={id}
          className="ui-input ui-select"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}
