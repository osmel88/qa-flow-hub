# 49 — Custom fields and a configurable workflow

Phase S3-F7 (roadmap item 3.3, ADR 0022). Read the code alongside:
`packages/shared/src/customization/`, `apps/api/src/modules/customization/`
and the `customFields` handling in the requirements, test-design and defects
services.

## 1. The trap: letting customers change your schema

Every QA tool eventually needs "one more field". The two naive answers both
hurt: adding a column per customer request turns migrations into a support
queue, and an entity-attribute-value table (`entity_id, field, value`) turns
every list into N joins and every write into N rows that must stay
consistent. qa-flow-hub keeps **definitions** as rows and **values** as one
JSONB object per entity.

```text
custom_field_definitions          defects.customFields (JSONB)
id=cf_1 key=browser type=select   { "cf_1": "opt_a", "cf_2": "1.4.2" }
id=cf_2 key=build   type=text
```

Exercise for later: list the operations that become harder with JSONB than
with columns (hint: foreign keys, `NOT NULL`, per-value indexes).

## 2. Why the key is the id, not the label

Labels change ("Browser" → "Browser / client"), keys are human-chosen and
options get renamed. If values were keyed by label, a rename would have to
rewrite every row in a transaction. Keying by the opaque definition id and
option id (`opt_…`) makes renames free and archived options harmless.

The same choice is a security property: a definition id from another project
or tenant is simply _unknown_ to the validator. It is refused exactly like a
made-up id, so the error reveals nothing.

## 3. Validation belongs to the service, once

`CustomFieldValuesService.resolve()` is the single entry point for every
write. Within the transaction it:

1. loads the active definitions of the project and entity **`FOR SHARE`**, so
   nobody archives a field or option between the check and the write;
2. refuses unknown ids and archived fields;
3. runs `checkCustomFieldValue()` from the shared package (the web uses the
   same code to shape its inputs), which normalises text, rejects
   `2026-02-30`, `NaN` and out-of-range numbers, and only accepts active
   options — unless the value was already stored;
4. merges the patch into the stored map (`null` clears a key);
5. enforces `required` on the merged result.

Merging matters for concurrency: the entity row is locked `FOR UPDATE` before
reading the stored map, so two people editing different fields at the same
time both keep their change. The integration test
`does not lose either of two concurrent patches` fails without the lock.

## 4. Archive, never delete

Deleting a definition would either orphan values or require rewriting
history. Instead definitions and options carry `archivedAt` / `archived`; the
app role has no `DELETE` on the tables. Old values keep rendering, new writes
cannot target them, and restoring a field brings everything back.

## 5. A workflow is data plus invariants

The defect workflow used to be a constant (`ALLOWED_TRANSITIONS`). It is now
a list of transitions stored per project, falling back to the same graph when
no row exists, so existing projects see no change. Data provided by users
needs invariants the constant had by construction:

- no self-loops and no duplicates;
- every status must be able to reach `closed` or `rejected`
  (`workflowProblems()` runs a reverse graph search) — otherwise a defect
  could be trapped forever;
- required fields must be active defect fields of the same project.

Each transition can also demand `defects.manage` and a set of filled fields.
`DefectWorkflowService.assertTransition()` locks the defect `FOR UPDATE` and
the workflow `FOR SHARE`, then checks the move, the permission and the fields.
Two concurrent moves of the same defect therefore have one winner, and a
workflow being saved mid-request is seen either entirely before or entirely
after.

## 6. Optimistic concurrency for configuration

Two admins editing the workflow should not silently overwrite each other.
The client sends the `version` it read; the service updates `WHERE version =
:read` and answers 409 when the row moved on. The very first save races on
the unique `projectId`: one insert wins, the others get 409. Compare this with
the pessimistic locks of section 5 — locks suit short server-side critical
sections, versions suit edits that span a human thinking.

## 7. Exercises

1. Add a `url` field type end to end: shared contract, validation, input,
   summary, and a unit test for invalid URLs.
2. The filter supports one field. Extend it to several (`AND`), add a GIN
   index on `customFields` and compare the `EXPLAIN` plans before and after.
3. Move the "reach a terminal status" check into a database trigger. What do
   you gain, and what becomes harder to test?
4. Make the requirement status workflow configurable reusing
   `workflowProblems()`. What would you generalise first?
