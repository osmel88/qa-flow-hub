import type { BadgeTone } from '@qa-flow-hub/ui';

/**
 * One mapping from domain status to colour, shared by every screen. Defined
 * once so "failed" is never red on one page and orange on another, which is
 * the kind of inconsistency that makes a report unreadable.
 */
const TONES: Record<string, BadgeTone> = {
  passed: 'success',
  failed: 'danger',
  blocked: 'warning',
  skipped: 'neutral',
  untested: 'neutral',
  active: 'success',
  archived: 'neutral',
  approved: 'success',
  draft: 'neutral',
  ready: 'info',
  in_review: 'info',
  obsolete: 'neutral',
  deprecated: 'neutral',
  planned: 'info',
  in_progress: 'info',
  completed: 'success',
  aborted: 'danger',
  open: 'danger',
  triaged: 'warning',
  resolved: 'info',
  closed: 'neutral',
  rejected: 'neutral',
  reopened: 'danger',
  blocker: 'danger',
  critical: 'danger',
  major: 'warning',
  minor: 'neutral',
  trivial: 'neutral',
};

export function toneFor(status: string): BadgeTone {
  return TONES[status] ?? 'neutral';
}

export function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}
