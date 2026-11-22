# Frontend architecture

The backend course documents the API. This document does the same job for
`apps/web`: what it is, the four decisions that shape it, and what it deliberately
does not do. The frontend is intentionally thin — the API owns every rule — but
"thin" is not the same as "careless", and the parts that are subtle are subtle for
reasons worth recording.

## What it is

React 19 with Vite, React Router, TanStack Query for server state, React Hook Form
with the shared Zod schemas for input, and `packages/ui` for accessible primitives
(`Button`, `TextField`, `TextAreaField`, `SelectField`, `Badge`, `DataState`).
Fifteen screens under `apps/web/src/pages`, covering login and registration, organizations, dashboard,
projects and project access, requirements, suites/sections/cases, the step editor,
runs and execution, defects, traceability and profile.

```
apps/web/src/
  api/         http-client.ts, endpoints.ts, session-store.ts
  auth/        AuthProvider: session, organizations, active organization
  project/     ProjectProvider: active project per organization
  app/         router, layout, navigation
  components/  composed, product-specific pieces
  pages/       one file per screen
```

## Decision 1: no client-side state library, because there is no client state

Everything on screen is server state: a list of requirements, a run's progress, a
matrix. TanStack Query owns it — cache key, refetch, invalidation on mutation — and
the only genuinely local state is the active organization and the active project.
Those two live in context providers, because they change what every query means.

The consequence to know: **a mutation must invalidate the right keys or the UI
lies**. That is the frontend's equivalent of forgetting a tenant filter, and the
reason a mutation invalidates the list key (`['cases']`) and not only the detail key
(`['case', id]`): editing a case changes what the list shows too.

## Decision 2: one shared refresh promise

```ts
/**
 * A single in-flight refresh, shared by every caller.
 */
let refreshInFlight: Promise<boolean> | null = null;
```

A dashboard fires several queries at once. If the access token has expired, every
one of them gets a `401` and every one of them would refresh — with the same
credential. The API rotates refresh tokens and treats a second use as a replay,
which **revokes the whole family**: the user is logged out for doing nothing wrong.

So the client serialises it: the first `401` starts the refresh, the rest await the
same promise, and all of them retry once. This is the single most important piece of
code in `apps/web`, and it exists because of a server-side security decision (ADR
0008), not because of a UI concern. It has its own unit tests.

## Decision 3: the client stores no credential

The refresh token is an `HttpOnly` cookie (ADR 0012), so the client never sees it.
`credentials: 'include'` is what makes it travel; the access token lives in memory
only. On load, the app restores a session by asking for a refresh — a `401` there is
how it learns it has no session.

Nothing sensitive is in `localStorage`, and an E2E test asserts it after a reload.
The only thing persisted is the id of the active organization, which is a preference,
not a credential.

## Decision 4: the same Zod schemas as the server

Forms validate with the schemas from `packages/shared` (ADR 0011), so the message a
user sees for a too-long title is produced by the same rule the API enforces. The
client cannot be more permissive, and it cannot be _stricter_ either — which is the
failure people forget: a client that rejects what the API accepts is an invisible
feature removal.

The API still validates everything. Client-side validation here is a latency
optimisation and a UX affordance, never a control.

## Permissions in the UI are honest, not decorative

The screens compute the user's **effective** role — organization role, overridden by
a per-project grant where one exists — and disable what it does not allow, with the
reason attached via `aria-describedby`. The invitation form only offers roles at or
below the actor's own level.

This is deliberately _not_ authorization: the API decides, and the same request from
`curl` gets the same `403`. The UI's job is to not offer an action it knows will be
refused, because a button that fails is worse than a button that is not there.

## Loading, error and empty states are a component

`DataState` wraps the three, so a screen cannot forget one — the most common way a
React app ships a blank page that looks broken. Empty states say what to do next,
not "no data".

## What it deliberately does not do

- **No optimistic updates.** In a tool whose value is a trustworthy record, showing
  a result that has not been persisted is the wrong default.
- **No offline support, no service worker.** A QA tool used next to a browser under
  test does not need it.
- **No design system beyond primitives.** `packages/ui` holds what is reused;
  everything else is plain CSS in `styles/`.
- **No SSR.** There is nothing public to index; the app is behind a login.
- **No i18n library.** The translation layer is ~100 lines of our own (see
  § Internationalization); a library would add plural rules and ICU syntax the
  product does not need yet.

## Testing

Component tests (Vitest and Testing Library) cover the pieces where a mistake is
invisible: the http client's refresh behaviour, the login form, the dashboard's
states, the members and project-access screens' disabled controls. The full flow —
register → organization → project → requirement → suite → case → run → failed
execution → defect → dashboard → matrix — is a Playwright E2E against the real API
and PostgreSQL, plus a reload check that no credential is reachable from script.

What is not covered: visual regression, and the screens whose logic is a thin form
over a tested endpoint. That is a deliberate allocation of effort, not an oversight.

## Branding and avatars

The product name and logo live in `src/branding.ts` (logo file under
`public/brand/`) and are rendered only by `components/Brand.tsx`, which the
public `AuthScreen` and the app header use. Nothing else hardcodes the name,
so a future brand is a two-file change. `index.html` holds `%BRAND_NAME%`,
`%BRAND_DESCRIPTION%` and `%BRAND_FAVICON%` placeholders that the
`brandingHtml` plugin in `vite.config.ts` fills from the same `BRANDING`
object at dev and build time, so the tab title and favicon follow too.
`components/Avatar.tsx` shows a
user's `avatarUrl` and falls back to initials when there is none or the image
fails to load (for example, a host the CSP does not allow).

## Related

- [`../README.md`](../README.md) — how to run it
- [`api-conventions.md`](api-conventions.md) — the API this client consumes
- [`adr/0011-shared-zod-contracts.md`](adr/0011-shared-zod-contracts.md), [`adr/0012-refresh-token-cookie-transport.md`](adr/0012-refresh-token-cookie-transport.md)

## Internationalization

`apps/web/src/i18n` holds a dependency-free layer:

- `locales.ts` lists the supported languages (`en`, `es`). Adding Portuguese
  is one entry there plus `messages/pt.ts`; a catalog may be partial because
  every missing key falls back to English (`messages/en.ts` is the source).
- `I18nProvider` keeps the locale in state, persists it in `localStorage`
  (`qaflow.locale`) and sets `<html lang>`. Without a provider (isolated
  component tests) everything renders in English.
- `useI18n().t('key', { name })` looks keys up; keys are typed, so a typo is a
  compile error, and a unit test checks that `es` has every English key.
- `LanguageSelector` is shown in the app header and in `AuthScreen`, the frame
  of the public authentication pages. Pages are never duplicated per language.

- Catalogs are split by screen: `messages/en/<namespace>.ts` (source) and
  `messages/es/<namespace>.ts`, merged in `messages/<locale>/index.ts`. Keys
  are `<namespace>.<camelCaseOfTheEnglishText>`; `{name}` placeholders carry
  the dynamic parts, so a sentence is never assembled from fragments with
  per-language word order baked in.
- A module-level `t()` reads the active locale, so plain functions (mutation
  error handlers, column definitions, validators) translate without a hook.
  The provider remounts the routed tree when the locale changes, so every
  screen re-renders in the new language.
- Domain values (statuses, types, roles, severities) are data, not keys:
  `humanize(value)` (in `components/status.ts`) calls `valueLabel()`, which
  looks up `value.<raw>` in the active catalog and otherwise shows the raw
  value with spaces. Adding an enum value needs no change to render; it is
  translated when `es/values.ts` gains the entry.
- `packages/ui` does not depend on the Web i18n: its default strings
  (`DataState` loading/error/empty, `PasswordField` show/hide) come from a
  `UiStringsProvider` context that `I18nProvider` fills.
- Validation messages from the shared Zod schemas stay in English in the
  schemas (the API uses the same ones). `i18n/validation.ts` maps the known
  messages to `validation.*` keys in one place; unknown ones pass through.
- `intlLocale()` returns the BCP 47 tag for `Intl` formatting.

Never translated: project keys, readable IDs, names and any text a user typed,
URLs, API paths and technical values. API error messages are shown as the API
sends them (English); see technical debt 69.

Translated: every product page and shared component listed in the
navigation, plus Login, Register and password recovery. Tests:
`i18n/i18n.test.tsx` (coverage of every English key in Spanish, fallback,
switching, persistence, login), `i18n/screens.test.tsx` (Projects and Test
plans in Spanish, value labels, validation mapping) and
`e2e/i18n.e2e.spec.ts`.
