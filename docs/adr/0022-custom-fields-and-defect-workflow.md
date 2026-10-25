# 0022 — Custom fields as JSONB values and a per-project defect workflow

Status: accepted
Date: 2026-12-06
Related: [0006](0006-multi-tenancy-strategy.md),
[0013](0013-row-level-security-with-non-owning-role.md),
[0017](0017-project-visibility-through-grants.md)

## Context

Roadmap item 3.3: enterprise QA processes never match the defaults. Teams want
their own fields on requirements, test cases and defects (browser, build,
risk, root cause…) and their own rules for moving a defect between statuses.
The roadmap warns this is the feature most likely to rot the data model.

## Options evaluated

| Option                               | Reads / filters  | Schema churn | Cost                                |
| ------------------------------------ | ---------------- | ------------ | ----------------------------------- |
| Entity-attribute-value table         | A join per field | None         | Slow lists, hard to keep atomic     |
| A column per field (DDL at runtime)  | Native           | Every field  | Migrations per tenant: unacceptable |
| **JSONB values + typed definitions** | JSON path filter | None         | Validation lives in the service     |
| Free-form JSON without definitions   | Native           | None         | No types, no required, no options   |

## Decision

1. **Definitions are rows** (`custom_field_definitions`): per project and
   entity type (`requirement`, `test_case`, `defect`), with a `key` unique per
   project and entity, a type (`text`, `number`, `boolean`, `date`, `select`,
   `multi_select`), `required` and, for selects, options with stable ids
   (`opt_…`). Up to 50 active definitions per project and entity.
2. **Values are a JSONB map on the entity** (`customFields`), keyed by the
   definition **id**, never the label or key, so renaming a field or an
   option never rewrites data. A CHECK keeps the column an object; the
   `?customField=&customFieldValue=` filter is a JSON path condition inside
   the project's own rows.
3. **The service validates every write** against the definitions, locked
   `FOR SHARE` in the same transaction: unknown or foreign ids are refused
   (so another tenant's id is "unknown", never a value), the type must match,
   dates are real calendar days, options must be active. A value already
   chosen keeps validating after its option is archived; new writes cannot
   pick it.
4. **Nothing is deleted.** Definitions and options are archived; values stay
   and are shown as before. The app role has no `DELETE` on the new tables.
   Type and key are immutable after creation.
5. **Patches merge.** A write only touches the ids it names (`null` clears);
   the entity row is locked `FOR UPDATE` so two concurrent patches of
   different fields both survive. Changes are audited field by field.
6. **The defect workflow is a project row** (`defect_workflows`) holding the
   transitions (`from`, `to`, permission `defects.create` or
   `defects.manage`, required field ids). Without a row the built-in graph
   applies, so existing projects behave exactly as before. A saved workflow
   must let every status reach `closed` or `rejected`, cannot repeat or
   self-loop, and may only require active defect fields of the same project.
7. **Concurrency.** Saving uses the `version` the client read (optimistic,
   409 when stale; the unique `projectId` decides the first save). A status
   change locks the defect `FOR UPDATE` and the workflow `FOR SHARE`, so two
   concurrent moves have one winner and a move never uses half a workflow.
8. **Permission** `customization.manage` (project manager and above) defines
   fields and workflows; reading them follows project visibility (ADR 0017).

## Consequences

- No migration per field and no tenant DDL.
- Lists stay a single query; filtering by a field is one JSON path condition,
  scanned within the project (no index yet, debt 44).
- Validation is in TypeScript, not in the database; a raw SQL writer could
  store an invalid value (debt 44).
- The workflow only governs defects; requirements and test cases keep their
  fixed statuses.
