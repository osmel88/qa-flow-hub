# 73 — Password recovery: single-use secrets without leaking accounts

Code: `apps/api/src/modules/auth/password-reset.service.ts`, the routes in
`auth.controller.ts`, `packages/shared/src/auth/password-reset.contracts.ts`
and the migration `20270502100000_password_reset`.

## 1. The token is a password, so store it like one

`randomBytes(32)` gives 256 bits; the link carries the base64url text and
the database keeps `sha256(token)`. A dump of `password_reset_tokens` lets
nobody reset anything. SHA-256 (not argon2) is enough because the input is
random, not a human password: there is nothing to brute-force.

## 2. Same answer for everyone

`forgot` returns 202 `{ accepted: true }` whether the address exists, is
inactive or is throttled. The only exception is the mock mode below.

## 3. Single use under concurrency

`reset` runs in one transaction and spends the token with

```ts
tx.passwordResetToken.updateMany({
  where: { id, consumedAt: null, invalidatedAt: null, expiresAt: { gt: now } },
  data: { consumedAt: now },
});
```

In PostgreSQL's READ COMMITTED, a second transaction with the same token
blocks on the row, re-evaluates the `WHERE` after the first commits and
updates 0 rows, so exactly one request wins. The integration test fires two
resets at once to prove it.

## 4. A reset is a security event

The transaction also sets the password, clears `failedLoginAttempts` and
`lockedUntil`, invalidates other links and revokes every session. After it,
the service audits (organization `null`, so `createMany` under RLS) and
publishes `user.password.changed`, which emails the owner of the account.

## 5. Mock mode

Without a real mail provider a staging tester would be stuck. The invitation
flow already shows the accept link to the inviter; recovery mirrors it by
returning `mockResetUrl` when `EMAIL_PROVIDER=mock` and not in production.
That mode reveals account existence by design; see debt 68.

## Exercises

1. Add a sweeper that deletes tokens expired for more than a day.
2. Equalize the response time of known and unknown addresses.
