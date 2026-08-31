import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  /**
   * While true the button is disabled and announces the busy state to screen
   * readers. A spinner alone tells a sighted user something is happening and
   * leaves everyone else guessing.
   */
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={['ui-button', `ui-button--${variant}`, `ui-button--${size}`, className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </button>
  );
}
