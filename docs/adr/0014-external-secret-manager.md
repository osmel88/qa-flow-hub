# 0014 — Integration credentials live in an external secret manager

Status: accepted
Date: 2026-10-04
Related: [0013](0013-row-level-security-with-non-owning-role.md)

## Context

Every real integration on the roadmap needs a credential the product does not
own: a GitHub token (Post-S2 GitHub Real), a Jira or TestRail API key, an email
provider key, S3 access keys. `IntegrationConnection` already stores a
`secretRef` — a pointer — and never a value, but nothing resolves the pointer.
S2-F10 has to decide where the values live before the first real integration
writes one.

What a credential store must survive:

- **A database dump.** Backups are copied, restored into drills and handed to
  support. A dump must not yield a customer's GitHub token.
- **A tenant writing its own `secretRef`.** The reference is tenant data; it
  must not be able to name another tenant's credential or the API's own keys.
- **Rotation without a deploy**, and an audit trail of who read what.

## Options

**A. External secret manager, behind a `SecretResolver` port.** AWS Secrets
Manager, GCP Secret Manager, Azure Key Vault or HashiCorp Vault, chosen when
the hosting provider is. The database keeps `secretRef` only. Rotation,
access audit and encryption at rest are the manager's job, done by people
whose job it is. Cost: one more runtime dependency and a network call (cached)
on the first use of a credential.

**B. `integration_credentials` table, AES-256-GCM, key from the environment.**
No new dependency. But the encryption key and the ciphertext end up readable by
the same process and, in practice, in the same backups and the same
environment; key rotation needs a re-encryption migration; and every access
audit is ours to build. It moves the problem rather than solving it.

**C. Environment variables only.** Fine for the platform's own secrets, fixed
at deploy time; impossible for per-tenant credentials created at runtime.

## Decision

**A.** Credentials live in an external secret manager; the database stores
`secretRef` only.

S2-F10 ships the seam, not the integration:

- `SecretResolver` (`apps/api/src/secrets/secret-resolver.ts`):
  `resolve(secretRef, { organizationId }) → Promise<string | null>`, bound
  under `SECRET_RESOLVER` by `SecretsModule`.
- `EnvSecretResolver`: resolves `env:QAFLOW_SECRET_<ORGANIZATION_ID>_<NAME>`.
  The `QAFLOW_SECRET_` prefix keeps `env:JWT_ACCESS_SECRET` or
  `env:DATABASE_URL` unreachable, and the organization segment keeps tenant A
  from naming tenant B's variable. Only alphanumeric organization ids are
  accepted, so no id can normalise into another's prefix. It is the
  development and single-tenant provider.
- No table, no migration, no consumer yet.

The concrete manager, its client library, caching and the first caller arrive
with **GitHub Real**, the first phase that stores a token.

## Consequences

- A database dump never contains integration credentials — by construction,
  not by encryption.
- The resolver is the only code that sees a value. It must never log it, never
  return it in a response and never include it in an error message (the unit
  tests assert the last).
- `secretRef` validation is the resolver's job, scoped by organization: a
  provider that resolved any reference would turn tenant data into a
  confused deputy.
- Until GitHub Real, `EnvSecretResolver` is the only implementation; it cannot
  hold per-tenant credentials created at runtime, which is acceptable because
  no feature creates them yet.
- Choosing the manager is tied to choosing the host; this ADR deliberately does
  not pick a vendor.
