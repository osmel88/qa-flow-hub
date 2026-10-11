import type { LimitedResource } from '@qa-flow-hub/shared';

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export function formatStorage(bytes: number): string {
  const GB = 1024 ** 3;
  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 2)} GB`;
  }
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function formatUsage(resource: LimitedResource, value: number): string {
  return resource === 'storage' ? formatStorage(value) : String(value);
}

export function formatDate(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' });
}

export const RESOURCE_LABELS: Record<LimitedResource, string> = {
  projects: 'Projects',
  members: 'Members and pending invitations',
  storage: 'Evidence storage',
};

/** A meter turns into a warning at 80% of the limit. */
export const APPROACHING_RATIO = 0.8;
