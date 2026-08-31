# 0008 — JWT access tokens with opaque, rotating refresh tokens

Status: accepted
Date: 2026-07-31

## Context

The API is stateless HTTP consumed by a single-page application on another
origin, and it will later be consumed by CI jobs pushing automated results. It
needs a session mechanism where:

- logging out actually ends access;
- an administrator can remove somebody and have it take effect now;
- a stolen credential is detectable rather than silently permanent.

## Options

**Server-side sessions with a cookie.** Simple and revocable. Awkward for a
cross-origin SPA and for machine clients, and it makes CSRF a first-class
concern on every mutating request.

**Long-lived JWT only.** Trivial to implement and impossible to revoke. Logout
becomes "delete the token in the browser and hope".

**Short JWT access token + long JWT refresh token.** The common pattern. The
refresh token is still self-validating, so it survives logout until it expires.

**Short JWT access token + opaque, rotating, stored refresh token.** Chosen.

## Decision

Access token: JWT, HS256, 15 minutes, carrying `sub`, `sid` and `email`.
Deliberately no roles: roles change, and a token cannot be un-issued.

Refresh token: 32 bytes from `randomBytes`, base64url, opaque. Stored as
HMAC-SHA256 keyed with `JWT_REFRESH_SECRET` — the secret acts as a pepper, so a
stolen database is not a list of usable sessions. Argon2 would be pointless
here: the input is 256 bits of entropy, not a guessable human password.

The refresh token is *not* a JWT because a JWT's defining property — validating
without touching the server — is the wrong property for a thirty-day credential.
It would remain valid after logout. And since every refresh must write to the
database anyway in order to rotate, carrying claims buys nothing.

**Rotation with families.** Each refresh revokes the presented token and issues
a successor with the same `familyId`, in one transaction. Presenting an
already-rotated token revokes the entire family: the token only works once, so
victim and thief necessarily collide, and the second one to use it presents a
rotated token. That is the detection signal. We cannot tell which party is the
thief, so both re-authenticate.

**Per-request session check.** The authentication guard loads the session row on
every request. This is one indexed read in exchange for immediate effect of
logout, "log out everywhere" and password changes — instead of up to fifteen
minutes of stale access.

## Consequences

**Good.** Logout, session revocation and forced logout after a password change
are real and immediate. A stolen refresh token becomes a detectable event. The
`Session` table gives users a device list they can inspect and revoke, and gives
audit entries a session to name.

**Bad.** One extra database read per request; mitigation, if it ever matters, is
a revocation cache, not removing the check. Rotation means a client that loses
the response to a refresh (a dropped connection at the wrong moment) is logged
out — a rare, correct-by-design failure, and the reason refresh must never be
called concurrently by the same client.

**Known limitation.** The refresh token is returned in the response body rather
than an `HttpOnly` cookie, because the SPA is on a different origin in
development. A cookie plus CSRF protection is the intended end state and is a
breaking change for clients, so it belongs before the first paying customer.
Recorded in `docs/security-model.md` and `docs/technical-debt.md`.
