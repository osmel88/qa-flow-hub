import { BRANDING } from '../branding';

/**
 * The brand. Large (public screens): the full logo, which already contains the
 * name. Default (header): the symbol next to the name. The images are
 * decorative and the name is always present as text (visually hidden when the
 * logo shows it), so screen readers hear the brand exactly once.
 */
export function Brand({ size = 'md' }: { size?: 'md' | 'lg' }): React.JSX.Element {
  if (size === 'lg' && BRANDING.logoUrl !== null) {
    return (
      <span className="brand brand--lg" data-testid="brand">
        <img className="brand__wordmark" src={BRANDING.logoUrl} alt="" aria-hidden="true" />
        <span className="visually-hidden">{BRANDING.name}</span>
      </span>
    );
  }
  return (
    <span className={`brand brand--${size}`} data-testid="brand">
      {BRANDING.markUrl !== null && (
        <img className="brand__logo" src={BRANDING.markUrl} alt="" aria-hidden="true" />
      )}
      <span className="brand__name">{BRANDING.name}</span>
    </span>
  );
}
