import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { useId, useState } from 'react';
import { useUiStrings } from './UiStrings';

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

export type PasswordFieldProps = Omit<TextFieldProps, 'type'> & {
  /** Accessible name of the toggle while the password is hidden. */
  showLabel?: string;
  /** Accessible name of the toggle while the password is visible. */
  hideLabel?: string;
};

/**
 * A password input with a show/hide toggle. Only `type` changes, so the value,
 * the form registration and the caret stay as they are. The toggle is a real
 * `<button type="button">` (keyboard reachable, never submits the form) whose
 * name says what pressing it does and whose `aria-pressed` says the state.
 */
export function PasswordField({
  label,
  error,
  hint,
  showLabel,
  hideLabel,
  ...rest
}: PasswordFieldProps): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  const strings = useUiStrings();
  return (
    <FieldShell label={label} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <div className="ui-password">
          <input
            {...rest}
            id={id}
            type={visible ? 'text' : 'password'}
            className="ui-input ui-password__input"
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
          <button
            type="button"
            className="ui-password__toggle"
            aria-label={
              visible ? (hideLabel ?? strings.hidePassword) : (showLabel ?? strings.showPassword)
            }
            aria-pressed={visible}
            aria-controls={id}
            onClick={() => {
              setVisible((current) => !current);
            }}
          >
            <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"
              />
              <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
              {visible && <path stroke="currentColor" strokeWidth="2" d="M3 3l18 18" />}
            </svg>
          </button>
        </div>
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
