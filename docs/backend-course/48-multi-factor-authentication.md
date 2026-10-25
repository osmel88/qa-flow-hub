# 48 — Multi-factor authentication with TOTP

> Phase S3-F6. ADR 0021. Code: `apps/api/src/modules/auth/mfa`
> (`totp.ts`, `mfa.service.ts`, `mfa.controller.ts`),
> `guards/active-organization.guard.ts`, migration `20261129100000_mfa_totp`.

## 1. What TOTP really is

TOTP is HOTP with a clock. HOTP (RFC 4226) computes
`HMAC-SHA1(secret, counter)`, takes 4 bytes at an offset given by the last
nibble ("dynamic truncation") and keeps 6 decimal digits. TOTP (RFC 6238)
uses `counter = floor(unixSeconds / 30)`. Server and phone share the secret
once (the QR code / setup key) and never talk again.

`totp.ts` implements it in ~80 lines on `node:crypto`; `totp.test.ts` checks
the RFC vectors. Writing it yourself is reasonable *only* because the RFC
ships test vectors — that is what makes the implementation verifiable.

## 2. Three secrets, three treatments

| Value            | Must be read back? | Stored as                         |
| ---------------- | ------------------ | --------------------------------- |
| TOTP secret      | Yes (to compute)   | AES-256-GCM ciphertext            |
| Recovery codes   | No (only compared) | HMAC-SHA256 digest                |
| Login challenge  | No                 | HMAC-SHA256 digest                |

The GCM *additional authenticated data* is the user id. A database attacker
who copies Alice's ciphertext into Mallory's row gets an authentication
failure, not Alice's codes. HMAC rather than plain SHA-256 means a dump of the
table is useless without `MFA_ENCRYPTION_KEY`, even for low-entropy codes.

## 3. The two-step login

```
POST /auth/login   { email, password }
  → 200 { mfaRequired: true, challengeToken, expiresIn: 300 }   (no cookie!)
POST /auth/mfa/verify { challengeToken, code | recoveryCode }
  → 200 AuthSession  (session.mfaAuthenticated = true)
```

The password step deliberately issues nothing usable: a stolen challenge
without the phone is worth five wrong guesses and then nothing.

## 4. Replay and concurrency

A 6-digit code is valid for ~90 s (±1 step). Without care, an attacker who
shoulder-surfs one code can reuse it. The factor stores `lastUsedStep` and the
service consumes a step with:

```ts
tx.mfaTotpFactor.updateMany({
  where: { userId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
  data: { lastUsedStep: step },
});
```

`count === 1` means *this* request won; two concurrent requests with the same
code get one 200 and one 401. Recovery codes use `usedAt: null` the same way,
and the challenge row is locked `FOR UPDATE`, so five parallel verifications
of one challenge create exactly one session (`mfa.int-spec.ts`).

A subtle point: failures are **returned** from the transaction, not thrown.
Throwing would roll back the `attempts + 1` update and give attackers infinite
guesses.

## 5. A per-tenant policy over an account-level factor

The factor is global; the requirement is per organization. The bridge is the
session: `Session.mfaAuthenticated` is read by `JwtAuthGuard` into the request
context, and `ActiveOrganizationGuard` checks
`membership.organization.requireMfa` **after** confirming membership. Order
matters: checking the policy first would let anyone probe which organizations
require MFA.

Two safety rails: the owner cannot enable the policy from a non-MFA session
(they would lock themselves out), and `/auth/mfa/*` skips the organization
guard so a blocked member can still enrol.

## 6. Exercises

1. Add WebAuthn as a second factor type. Which columns move from
   `mfa_totp_factors` to a generic `mfa_factors`?
2. Write a key-rotation job: decrypt with the old key, re-seal with the new,
   in batches. How do you make `open()` accept both during the rollout?
3. Add a grace period to `requireMfa`. Where does the deadline live, and what
   does the guard return before it?
