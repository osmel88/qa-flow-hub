# API conventions

Rules the whole API follows. A client that learns them once should be able to
guess how any new endpoint behaves.

## Base path and versioning

```
/api/v1/<resource>
```

Version is in the URI. It is the only scheme a caller can use from a browser
address bar or a `curl` line without extra ceremony, and the cost — a new prefix
for a breaking change — only arrives once there is an external consumer.

`GET /health` is deliberately outside both the prefix and the version. A probe
should not break because the API version changed.

## Authentication

```
Authorization: Bearer <access token>
X-Organization-Id: <organization uuid>
```

The access token identifies the **user**. The header identifies the **active
organization**, and it is not in the token on purpose: switching organizations
needs no new token, and removing somebody's membership takes effect on the next
request instead of when their token expires.

Endpoints that a user must be able to call before belonging to anywhere —
creating an organization, listing their own, accepting an invitation — do not
require the header.

## Resource naming

- plural nouns: `/projects`, `/organizations`;
- nesting only where the child cannot exist alone: `/projects/:id/archive`;
- the active organization is `/organizations/current`, never
  `/organizations/:id`. The active tenant already travels in a verified header;
  putting it in the path too would create a second source of truth.

## Methods and state transitions

| Method | Use |
| --- | --- |
| `GET` | Read. Never changes state |
| `POST` | Create, or perform a named transition |
| `PATCH` | Partial update of editable fields |
| `DELETE` | Soft delete |

Transitions with rules are `POST /resource/:id/<verb>`, not a writable `status`
field:

```
POST /projects/:id/archive
POST /projects/:id/restore
POST /organizations/current/invitations/:id/resend
```

The reason is not style. Archiving sets `archivedAt` and makes the project
read-only; a writable `status` would make "archived" a label that any client
could set without the side effects, and the audit log would record a field diff
instead of an intent.

## Status codes

| Code | Meaning here |
| --- | --- |
| 200 | Success with a body |
| 201 | Created |
| 204 | Success with no body (delete, revoke) |
| 400 | Failed schema validation |
| 401 | Missing, invalid or revoked credentials |
| 403 | Authenticated, but the role or membership does not allow it |
| 404 | Does not exist **or belongs to another organization** |
| 409 | Conflicts with current state (duplicate, expired, wrong state) |
| 429 | Rate limited or account locked |
| 500 | Our fault |

The 403/404 split is a security rule, not a preference: returning 403 for
another tenant's resource would confirm that it exists. See
[`security-model.md`](security-model.md).

## Error envelope

Every error, without exception:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request failed validation",
    "requestId": "0f8c1e2a-...",
    "details": [{ "path": "key", "message": "Use 2 to 8 characters..." }]
  }
}
```

- `code` is stable and meant to be branched on. `message` is for humans and may
  change without notice.
- `requestId` appears in the response and in every log line for that request.
  Quote it in a support ticket and the operator can find everything.
- `details` exists only for validation errors and contains field paths and
  messages — never the submitted values, which may be a password.

Codes: `VALIDATION_ERROR`, `UNAUTHENTICATED`, `UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `DUPLICATE_RESOURCE`, `RATE_LIMITED`,
`TOKEN_REUSE_DETECTED`, `INTERNAL_ERROR`.

## Pagination

```
GET /projects?page=1&pageSize=20
```

```json
{
  "data": [ ... ],
  "meta": { "page": 1, "pageSize": 20, "total": 57, "totalPages": 3 }
}
```

Defaults are `page=1`, `pageSize=20`, and `pageSize` is capped at 100 — a cap
that is enforced with a 400, not silently clamped, so a client asking for 100000
learns it was wrong instead of quietly getting something else.

Offset pagination is a deliberate MVP choice: it supports "page 7", which the UI
uses. Cursor pagination becomes necessary when a list is both large and
frequently appended to; test results are the first candidate.

## Filtering and search

- filters are explicit query parameters with an enum of accepted values
  (`?status=archived`);
- `?search=` is a case-insensitive substring match over the fields that make
  sense for the resource;
- unknown query parameters are ignored, not rejected.

## Request and response bodies

- JSON only, UTF-8;
- unknown properties are **stripped**, not rejected: this is what makes mass
  assignment a non-issue, since a client sending `organizationId` or
  `testCaseCounter` simply loses those keys in the pipe;
- responses are explicit projections (`toProjectView`), never Prisma entities,
  so adding a column cannot publish it;
- timestamps are ISO 8601 strings in UTC;
- absent optional values are `null`, not missing keys.

## Idempotency

`GET`, `PATCH` with the same body, and `DELETE` are idempotent. `POST` is not.
Operations whose repetition would be harmful are protected by state rather than
by an idempotency key: accepting an invitation twice fails because the second
attempt no longer finds it pending.

An `Idempotency-Key` header is future work, listed in
[`technical-debt.md`](technical-debt.md).

## Rate limiting

Global per-IP limits, plus a stricter per-account lockout on authentication.
Exceeding either returns 429. The limiter is in-process, so limits are per API
instance until there is a shared store.

## OpenAPI

`/docs` in non-production environments, generated from the code. Where a body is
validated by Zod, the schema is the source of truth and the Swagger annotation
documents intent — keeping them in sync automatically is future work.
