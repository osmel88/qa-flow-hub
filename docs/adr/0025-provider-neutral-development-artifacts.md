# 0025 — Provider-neutral development artifacts linked to work items

Status: accepted
Date: 2027-01-17
Related: [0023](0023-work-items-ranked-hierarchy.md)

## Context

Work items must relate to branches, commits, pull requests, builds and
deployments before any real Git or CI provider is connected, and later
GitHub, GitLab or Azure DevOps must be able to feed the same data.

## Decision

- One table, `development_artifacts`, with a `kind` and the reference fields
  of every kind, instead of one table per kind: the five kinds share
  linking, filtering, permissions and history, and differ only in their
  reference and allowed statuses (CHECK constraints plus Zod).
- `provider` and `externalId` are plain columns. Uniqueness is per
  (project, provider, kind, natural key) and per (project, provider, kind,
  externalId) among live rows, so an adapter can upsert by external id and a
  local record never collides with a synced one.
- Adapters implement the `DevelopmentActivitySource` port and call the
  domain service; the domain never imports a provider SDK. None is
  registered yet.
- Artifacts are soft-deleted; links are rows that unlinking deletes, with
  link and unlink in the audit log (as in S4-F4).

## Consequences

- Adding a kind means a new enum value, its reference rule and statuses.
- Provider-specific fields that do not fit stay out until an adapter needs
  them (debt 52).
