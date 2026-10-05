import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * What a caller-supplied request id may look like: the characters a UUID, a
 * ULID or a load balancer trace id use, and short enough to be a label. Anything
 * else — newlines, quotes, kilobytes of text — would end up verbatim in every
 * log line and audit row of the request, so it is replaced, not escaped.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * The request id for an incoming request: the caller's when it is safe to
 * reuse, a fresh UUID otherwise. Idempotent, which is what lets Fastify and the
 * request-context middleware call it independently and agree.
 */
export function resolveRequestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && SAFE_REQUEST_ID.test(header) ? header : randomUUID();
}
