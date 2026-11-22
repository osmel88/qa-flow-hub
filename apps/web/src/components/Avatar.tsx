import { useState } from 'react';

/** Up to two initials from a full name, or from the email when there is none. */
export function initialsOf(name: string | null | undefined, email?: string | null): string {
  const source = (name ?? '').trim();
  if (source !== '') {
    const words = source.split(/\s+/);
    const first = words[0]?.[0] ?? '';
    const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
    return `${first}${last}`.toUpperCase();
  }
  return (email ?? '').trim().slice(0, 1).toUpperCase() || '?';
}

/**
 * The user's picture, or their initials when there is no `avatarUrl` or the
 * image cannot be loaded (for example, a host the content security policy
 * does not allow). The name is shown next to it, so it is decorative.
 */
export function Avatar({
  name,
  email,
  avatarUrl,
  size = 'sm',
}: {
  name: string | null | undefined;
  email?: string | null | undefined;
  avatarUrl?: string | null | undefined;
  size?: 'sm' | 'lg';
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const showImage = avatarUrl !== null && avatarUrl !== undefined && avatarUrl !== '' && !failed;
  return (
    <span className={`avatar avatar--${size}`} aria-hidden="true" data-testid="avatar">
      {showImage ? (
        <img className="avatar__image" src={avatarUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        initialsOf(name, email)
      )}
    </span>
  );
}
