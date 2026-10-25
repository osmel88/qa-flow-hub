# 0021 — Account-level TOTP MFA with an organization policy

Status: accepted
Date: 2026-11-29
Related: [0006](0006-multi-tenancy-strategy.md),
[0013](0013-row-level-security-with-non-owning-role.md),
[0017](0017-project-visibility-through-grants.md)

## Context

Roadmap item 3.2 asks for multi-factor authentication. Enterprise buyers also
want to *require* it for everybody in their organization. SSO/SAML (3.1)
needs an external identity provider and is out of scope; MFA must work with
no third party at all.

## Options evaluated

| Option                       | Third party | Phishing resistant | Cost                                    |
| ---------------------------- | ----------- | ------------------ | --------------------------------------- |
| SMS / email one-time codes   | Yes         | No                 | Provider, SIM-swap risk                 |
| **TOTP (RFC 6238)**          | No          | No                 | Small, no dependency (`node:crypto`)    |
| WebAuthn / passkeys          | No          | Yes                | Browser ceremony, a library, more UI    |
| A library (otplib, speakeasy)| No          | No                 | A dependency for ~80 lines of RFC code  |

## Decision

1. **TOTP, implemented on `node:crypto`**, verified against the RFC 6238
   SHA-1 test vectors. ±1 step of clock drift.
2. **Account-level.** A factor belongs to a `User`, like the password: one
   enrolment applies in every organization. The tables carry no
   `organizationId` and therefore no RLS, like `users` and `sessions`.
3. **Secrets sealed, codes hashed.** AES-256-GCM with the user id as AAD for
   the TOTP secret (it must be read back); HMAC-SHA256 for recovery codes and
   challenge tokens (they only need comparing). Both keyed by
   `MFA_ENCRYPTION_KEY`, required in production.
4. **Two-step login.** A correct password for an MFA account returns a
   single-use, short-lived challenge and no session. `POST /auth/mfa/verify`
   exchanges it plus a TOTP or recovery code for a session marked
   `mfaAuthenticated`. Refresh rotation keeps the mark.
5. **Replay and races are solved in SQL.** The challenge row is locked
   `FOR UPDATE`; the TOTP step is consumed with a conditional update on
   `lastUsedStep`; a recovery code with `usedAt IS NULL`. Failures are returned
   from the transaction, not thrown, so the attempt counter is committed.
6. **Policy per organization.** `organizations.requireMfa`, owner-only, refused
   from a session without MFA. `ActiveOrganizationGuard` enforces it per
   request after the membership check, so non-members learn nothing.
   `/auth/mfa/*` skips the organization guard so blocked members can comply.

## Consequences

- No new dependency, no new infrastructure, one additive migration.
- Rotating `MFA_ENCRYPTION_KEY` invalidates every factor (debt 43).
- TOTP is phishable; WebAuthn remains the upgrade path and fits the same
  `Session.mfaAuthenticated` contract.
