# 0012 — Refresh tokens travel as an HttpOnly cookie

Status: accepted
Date: 2026-08-16
Amends: [0008](0008-jwt-and-refresh-tokens.md)

## Context

ADR 0008 chose opaque, rotating refresh tokens and recorded a known limitation: the
token was returned in the response body, so the browser had to store it, and it
ended up in `localStorage`. That is a thirty-day credential readable by any script
on the page — one XSS turns an incident into a persistent breach.

The limitation was accepted because the SPA and the API are on different origins in
development. That reason does not survive review: the deployment serves both from a
single origin through a proxy, which makes a path-scoped cookie viable.

## Options

**Keep the body transport and mitigate XSS.** Relies on never shipping an XSS in a
React app for the rest of the product's life. Not a control.

**`sessionStorage` instead of `localStorage`.** Shorter exposure window, same
reachability from script. Cosmetic.

**`HttpOnly` cookie for every client.** Correct for browsers and broken for clients
without a cookie jar — the integration suite, CI scripts, a future server-to-server
caller.

**`HttpOnly` cookie by default, body transport on explicit request.** Chosen.

## Decision

On register, login and refresh, the API sets `qafh_refresh` with `httpOnly: true`,
`sameSite: 'strict'`, `secure` in production, `path: /api/v1/auth`, and `maxAge`
equal to the refresh TTL. Logout and "log out everywhere" expire it.

The response body carries `refreshToken: null` for browsers: the value **never**
reaches the client. A caller that needs it inline asks with `X-Refresh-Transport:
body`.

The default is the safe one deliberately. Forgetting the header costs a confusing
failure in a script; defaulting the other way would silently hand a thirty-day
credential back to every browser — a failure nobody notices.

Four details that are the decision, not configuration:

- **`Strict`, not `Lax`**: nothing in this product is a cross-site navigation that
  must arrive authenticated, and `Strict` removes CSRF on the refresh endpoint
  without an anti-CSRF token.
- **`secure` only in production**: over plain HTTP in development the browser would
  drop the cookie and the session would silently never restore.
- **`path` scoped to `/auth`**: a cookie on `/` rides along on every request,
  including the ones with no use for it.
- **Session restore is a refresh**: the client stores nothing and, on load, asks the
  API to rotate the cookie.

## Consequences

**Good.** An XSS payload can act while the tab is open but cannot exfiltrate the
credential. Nothing sensitive is in `localStorage`, and an E2E test asserts exactly
that after a reload. CSRF on refresh is handled by `SameSite`.

**Bad.** The API and the web client must be same-site; a genuinely cross-site
deployment would have to relax to `Lax` and add CSRF protection (recorded in
`deployment.md`). Cookies also make `curl` sessions slightly more awkward, which is
what the header escape hatch is for.

**Bad, and open.** The body transport still exists for machine clients, so a CI
script can hold a thirty-day session credential in a variable. The right answer for
those callers is an API key with its own lifecycle and scopes, not a session refresh
token; it is new functionality and is tracked as technical debt 20.
