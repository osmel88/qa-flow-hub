import type { LimitedResource } from '@qa-flow-hub/shared';
import { intlLocale, t } from '../i18n/i18n';

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
  return iso === null
    ? '—'
    : new Date(iso).toLocaleDateString(intlLocale(), { dateStyle: 'medium' });
}

export const RESOURCE_LABELS: Record<LimitedResource, string> = {
  get projects() {
    return t('c_billingFormat.projects');
  },
  get members() {
    return t('c_billingFormat.members');
  },
  get storage() {
    return t('c_billingFormat.storage');
  },
};

/** A meter turns into a warning at 80% of the limit. */
export const APPROACHING_RATIO = 0.8;
