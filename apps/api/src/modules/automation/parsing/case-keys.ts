/**
 * Finds the case keys of one project (`WEB-C-12`) in free text. The key must
 * stand alone: `XWEB-C-12`, `WEB-C-12a` and `WEB-C-123` never match
 * `WEB-C-12`, and another project's keys never match at all.
 */
export function caseKeysIn(projectKey: string, texts: readonly string[]): string[] {
  const escaped = projectKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![A-Za-z0-9-])${escaped}-C-(\\d{1,9})(?![A-Za-z0-9])`, 'g');
  const keys = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      keys.add(`${projectKey}-C-${Number(match[1])}`);
    }
  }
  return [...keys];
}
