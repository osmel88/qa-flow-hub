# 0023 — Work items with a ranked hierarchy and composite references

Status: accepted
Date: 2026-12-13
Related: [0006](0006-multi-tenancy-strategy.md),
[0017](0017-project-visibility-through-grants.md),
[0019](0019-release-as-an-entity.md)

## Context

The product scope widens (Stage 4) from QA management to the whole delivery
lifecycle: Requirements → Planning → Work Items/Backlog → Sprints →
Development → CI → QA → Defects → Releases → Analytics. The first brick is a
backlog: epics, features, stories, tasks, bugs, improvements and spikes, with a
parent/child hierarchy and an optional release.

## Options evaluated

| Topic         | Option                                    | Verdict                                         |
| ------------- | ----------------------------------------- | ----------------------------------------------- |
| Hierarchy     | Free tree + cycle detection on every move | Recursive queries, races between two moves      |
|               | Closure / path table                      | Extra table to keep consistent, overkill now    |
|               | **Ranked types, parent must rank higher** | Cycles impossible by construction, depth ≤ 4    |
| Cross-project | Service check only                        | One forgotten check is a leak                   |
|               | **Composite FKs (x, projectId)**          | The database refuses it, like test runs (0019)  |
| Lost updates  | Last write wins                           | Silent overwrites between two editors           |
|               | **`version` column, optional in `PATCH`** | 409 when stale; old clients keep working        |
| Bug vs defect | One entity                                | Mixes QA findings with planned development work |
|               | **Separate `bug` work item type**         | Defects stay the QA record; linking comes later |

## Decision

1. **`work_items`** per project, key `PROJ-W-n` from a project counter
   reserved in the same transaction (like requirements and defects).
2. **Ranked hierarchy**: epic (0) → feature (1) → story, bug, improvement,
   spike (2) → task (3). A parent must rank strictly above its child, so a
   cycle cannot exist and the tree is at most four levels deep. Changing a
   type must keep the parent above and every child below.
3. **Tree changes are serialised per project** with a transaction advisory
   lock taken before any row lock: creating under a parent, moving, retyping
   and deleting. Two individually valid concurrent changes can therefore never
   combine into an invalid tree, and a child is never created under a parent
   being deleted.
4. **Composite foreign keys** `(parentId, projectId)` and `(releaseId,
projectId)`: the database refuses a parent or release of another project
   (and therefore of another tenant). The service answers those ids exactly
   like ids that do not exist.
5. **Releases**: only open releases accept items (`FOR SHARE`, ADR 0019), and
   an item cannot leave a shipped or archived release.
6. **Statuses** `backlog, ready, in_progress, blocked, in_review, done,
cancelled`, free moves; `completedAt` is set on done/cancelled and cleared
   when reopened. Configurable workflows (like defects, ADR 0022) come later.
7. **Permissions**: `work_items.read` (every role), `work_items.write` (tester
   and above), `work_items.manage` (delete; project manager and above). The
   assignee must be a member who can see the project.
8. **Soft delete only**, refused while the item has live children; RLS by
   organization and no `DELETE` for the app role.

## Consequences

- No recursive SQL: ancestors are a bounded walk (≤ 4 reads) and children one
  query.
- The rank forbids some shapes teams may want (a task directly under an
  epic is allowed, a story under a story is not); see debt 45.
- One advisory lock per project serialises hierarchy edits; plain edits
  (title, status, estimate) do not take it.
