import type { NotificationType } from '@qa-flow-hub/shared';
import type { EmailTemplateVars } from './email-templates';

/**
 * Template variables as they are stored in `notifications.payload`, so the
 * outbox worker can render a retry exactly as the first attempt was rendered.
 *
 * JSON has no dates, and a row read back from the database is untrusted
 * input: `VAR_SHAPES` lists every variable of every template with its kind,
 * and `fromPayload` refuses anything that does not match it exactly. The
 * mapped type makes the compiler reject a shape that forgets or invents a
 * variable, so adding one to a template forces this table to follow.
 */
type VarKind = 'string' | 'number' | 'date';

type Shape<V> = {
  readonly [K in keyof V]-?: V[K] extends Date ? 'date' : V[K] extends number ? 'number' : 'string';
};

export const VAR_SHAPES: { readonly [T in NotificationType]: Shape<EmailTemplateVars[T]> } = {
  organization_invitation: {
    organizationName: 'string',
    inviterName: 'string',
    role: 'string',
    acceptUrl: 'string',
    expiresAt: 'date',
  },
  password_changed: { fullName: 'string', changedAt: 'date', loginUrl: 'string' },
  test_run_assignment: {
    assigneeName: 'string',
    assignedByName: 'string',
    organizationName: 'string',
    projectName: 'string',
    runName: 'string',
    assignedCases: 'number',
    runUrl: 'string',
  },
  defect_assignment: {
    assigneeName: 'string',
    assignedByName: 'string',
    organizationName: 'string',
    projectName: 'string',
    defectTitle: 'string',
    severity: 'string',
    defectUrl: 'string',
  },
  defect_status_changed: {
    recipientName: 'string',
    changedByName: 'string',
    organizationName: 'string',
    projectName: 'string',
    defectTitle: 'string',
    fromStatus: 'string',
    toStatus: 'string',
    defectUrl: 'string',
  },
  test_run_failed: {
    recipientName: 'string',
    completedByName: 'string',
    organizationName: 'string',
    projectName: 'string',
    runName: 'string',
    failedCases: 'number',
    blockedCases: 'number',
    totalCases: 'number',
    runUrl: 'string',
  },
};

export type StoredPayload = Record<string, string | number>;

function shapeOf(type: NotificationType): Readonly<Record<string, VarKind>> {
  return VAR_SHAPES[type];
}

/** Dates become ISO strings; nothing outside the template's shape is kept. */
export function toPayload<T extends NotificationType>(
  type: T,
  vars: EmailTemplateVars[T],
): StoredPayload {
  const payload: StoredPayload = {};
  for (const [key, value] of Object.entries(vars)) {
    const kind = shapeOf(type)[key];
    if (kind === 'date' && value instanceof Date) payload[key] = value.toISOString();
    else if (kind === 'number' && typeof value === 'number') payload[key] = value;
    else if (kind === 'string' && typeof value === 'string') payload[key] = value;
  }
  return payload;
}

/**
 * The inverse of `toPayload`, or null when the stored value is not exactly a
 * payload of this template (missing, extra or mistyped variable, bad date).
 */
export function fromPayload<T extends NotificationType>(
  type: T,
  payload: unknown,
): EmailTemplateVars[T] | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const shape = shapeOf(type);
  const entries = Object.entries(payload);
  if (entries.length !== Object.keys(shape).length) return null;
  const vars: Record<string, string | number | Date> = {};
  for (const [key, value] of entries) {
    const kind = shape[key];
    if (kind === undefined) return null;
    if (kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      vars[key] = value;
    } else if (typeof value !== 'string') {
      return null;
    } else if (kind === 'date') {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return null;
      vars[key] = date;
    } else {
      vars[key] = value;
    }
  }
  // Every key and kind was checked against VAR_SHAPES[type] above.
  return vars as unknown as EmailTemplateVars[T];
}
