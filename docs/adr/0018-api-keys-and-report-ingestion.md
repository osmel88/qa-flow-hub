# 0018 — Project API keys and atomic report ingestion

Status: accepted
Date: 2026-11-08
Related: [0006](0006-multi-tenancy-strategy.md),
[0009](0009-test-case-snapshots-in-runs.md),
[0013](0013-row-level-security-with-non-owning-role.md),
[0017](0017-project-visibility-through-grants.md)

## Context

CI needs to push automated results (JUnit XML, Playwright JSON) into a project
without a user session. A refresh token is the wrong credential for that (debt
20): it belongs to a person, lives 30 days, and can do everything that person
can do. The upload endpoint also receives files nobody reviewed, from machines
that retry.

## Options evaluated

| Option                                    | Credential                         | Cost                                                                 |
| ----------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| Service-account users with sessions       | A refresh token of a fake user     | A seat per pipeline, a session lifecycle a machine cannot follow     |
| Organization-wide API keys                | One key for every project          | A leaked key writes into every project, including hidden ones        |
| **Project API keys with explicit scopes** | `qfh_<prefix>_<secret>`, hash only | One table, a public prefix lookup before RLS, a scope per capability |

| Option for the report parser   | XML safety                                | Cost                                |
| ------------------------------ | ----------------------------------------- | ----------------------------------- |
| DOM parser (`fast-xml-parser`) | Depends on options; whole tree in memory  | Memory proportional to the file     |
| **SAX parser (`saxes@6.0.0`)** | No DTD support at all, and we refuse them | Streaming, explicit depth/count     |
| `libxmljs`                     | Native, entity expansion configurable     | Native build, larger attack surface |

## Decision

1. **A key belongs to one project of one organization** and carries scopes;
   the only scope today is `results:ingest`. Managing keys is a human
   permission, `api_keys.manage` (project manager and above, overridable).
2. **Only a SHA-256 hash of the full token is stored.** The token is 32 random
   bytes (base64url) after a 12-character public prefix; it is returned once by
   `POST /projects/:id/api-keys` and never again. A high-entropy random secret
   does not need a slow KDF; SHA-256 plus `timingSafeEqual` is enough.
3. **Tenant resolution before RLS uses a single `SECURITY DEFINER` function**,
   `api_key_organization_for_prefix(prefix)`, that maps a prefix to an
   organization and nothing else. Hash, revocation, expiry, scope and project
   are checked afterwards, with RLS active for that organization.
4. **Revocation is immediate**: the ingestion transaction re-reads the key
   `FOR SHARE`; revoking takes `FOR UPDATE` first and timestamps afterwards, so
   once revoke returns, no report can be recorded with the key and no recorded
   report is newer than `revokedAt`.
5. **Ingestion is all or nothing.** The report is parsed before any write; one
   transaction under a per-project advisory lock creates or reuses the run, its
   run cases, the results, the `ingestion_reports` row, `lastUsedAt` and the
   audit entry.
6. **Idempotency** is `(projectId, Idempotency-Key)`, defaulting to
   `sha256:<checksum>`. A replay answers the stored report with
   `duplicate: true`; the same key with other bytes answers 409.
7. **Matching is by case key** (`WEB-C-12`) found in names, class names, tags,
   annotations or properties. Unmatched tests are reported, never created.

## Consequences

- A leaked key can only add results to one project and is revoked in one call.
- The public prefix is enough to learn that a key exists in some organization,
  not which one: an unknown, revoked or tampered token gets the same 401.
- Results arrive as `executedById: null`; the audit entry names the key.
- Rate limiting is per key prefix and per instance (debt 36), not global.

See [technical-debt.md](../technical-debt.md) entry 40.
