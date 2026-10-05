/**
 * The port through which the API reads a credential it does not store.
 *
 * Integration rows keep a `secretRef` — a pointer — and never the secret
 * itself (ADR 0014). Whatever holds the value, environment variables today and
 * an external secret manager when GitHub Real lands, sits behind this
 * interface, so the service that calls a provider never learns where the
 * secret lives.
 *
 * A reference always resolves *for an organization*. `secretRef` is tenant
 * data; a resolver that accepted any reference would let one organization
 * point its connection at another organization's credential, or at the
 * API's own signing keys.
 */
export interface SecretResolver {
  /** The scheme this resolver answers for, the part of `secretRef` before `:`. */
  readonly scheme: string;

  /**
   * The secret value, or `null` when the reference is well formed and owned
   * by the organization but nothing is stored under it. Throws
   * `InvalidSecretReferenceError` for a malformed or foreign reference.
   */
  resolve(secretRef: string, scope: { organizationId: string }): Promise<string | null>;
}

export const SECRET_RESOLVER = Symbol('SecretResolver');

/**
 * Deliberately says nothing about the value or the variable it would have
 * read: the message can reach a log line.
 */
export class InvalidSecretReferenceError extends Error {
  constructor(reason: string) {
    super(`Invalid secret reference: ${reason}`);
    this.name = 'InvalidSecretReferenceError';
  }
}
