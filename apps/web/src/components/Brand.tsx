import { BRANDING } from '../branding';

/**
 * Logo and product name. The logo is decorative: the name next to it is the
 * accessible text, so screen readers do not hear the brand twice.
 */
export function Brand({ size = 'md' }: { size?: 'md' | 'lg' }): React.JSX.Element {
  return (
    <span className={`brand brand--${size}`} data-testid="brand">
      <img className="brand__logo" src={BRANDING.logoUrl} alt="" aria-hidden="true" />
      <span className="brand__name">{BRANDING.name}</span>
    </span>
  );
}
