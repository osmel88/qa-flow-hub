# CRUD matrix of the main modules

Which lifecycle operations each entity supports, in the API and in the Web,
and why some of them are missing on purpose. Written during the staging
stabilization block; update it with any feature that adds or removes an
operation.

Legend: **API** = route exists; **Web** = the UI exposes it; **—** = not
supported, with the reason below the table. "Soft delete" sets `deletedAt`:
the row leaves every list, coverage and metric, but stays in the database for
the audit log and history.

| Entity              | Create                  | View               | Edit                                     | Archive / Close                        | Restore                | Delete                                  |
| ------------------- | ----------------------- | ------------------ | ---------------------------------------- | -------------------------------------- | ---------------------- | --------------------------------------- |
| Project             | API + Web (owner/admin) | API + Web (Open)   | API + Web (`project.manage`)             | Archive: API + Web                     | API + Web              | — (1)                                   |
| Requirement         | API + Web               | API + Web (detail) | API + Web (detail, versioned)            | Retire (`obsolete`): API + Web         | Status back: API + Web | Soft delete: API + Web (2)              |
| Work item           | API + Web               | API + Web (detail) | API + Web                                | Status / workflow: API + Web           | Status back            | Soft delete: API + Web                  |
| Test case           | API + Web               | API + Web          | API + Web (versioned, restore a version) | Archive: API + Web                     | API + Web              | API only (3)                            |
| Test plan           | API + Web               | API + Web          | API + Web                                | Complete / cancel / archive: API + Web | — (4)                  | — (4)                                   |
| Test cycle          | API + Web               | API + Web          | API + Web                                | Complete / cancel / archive: API + Web | — (4)                  | — (4)                                   |
| Test run            | API + Web               | API + Web          | API (title, release, environment)        | Complete / abort: API + Web            | — (5)                  | Soft delete: API only (5)               |
| Defect              | API + Web               | API + Web          | API + Web (title, severity, priority)    | Status `closed`: API + Web             | Reopen by status       | Soft delete: API only (6)               |
| Release             | API + Web               | API + Web (detail) | API + Web (until archived)               | Released / archive: API + Web          | — (4)                  | — (1)                                   |
| Environment         | API + Web               | API + Web          | API + Web                                | Archive: API + Web                     | API + Web              | Only without deployments: API + Web (7) |
| Build               | API + Web (or CI)       | API + Web          | API (metadata)                           | Status transitions                     | —                      | — (8)                                   |
| Deployment          | API + Web (or CI)       | API + Web          | API (metadata)                           | Status transitions, rollback           | —                      | — (8)                                   |
| Exploratory session | API + Web               | API + Web          | API + Web                                | Complete / cancel / archive: API + Web | — (4)                  | — (4)                                   |

## Why an operation is missing

1. **No delete for projects and releases.** A project owns requirements, test
   cases, runs, results, defects, releases and the whole QA history; a
   release groups runs and results that quality gates, approvals and reports
   read. Deleting either would cascade through evidence that audits and
   metrics depend on. Archive makes them read-only and is reversible, so it
   is the only "remove" the product offers. A real purge (GDPR, contract end)
   belongs to an organization-level, offline data-retention job, not to a
   button.
2. **Requirements delete softly.** `RequirementsService.remove()` soft-deletes
   the row and, in the same transaction, purges its coverage and
   implementation links, so traceability never points at a hidden
   requirement. Its versions and audit entries are kept. To retire a
   requirement that still matters for history, the UI recommends the
   `obsolete` status instead; there is no `ON DELETE CASCADE`.
3. **Test cases:** archive is the normal removal and keeps results that
   reference the case; the soft delete route exists for API clients and
   imports, and is not offered in the UI because results would lose their
   case in lists.
4. **Plans, cycles, sessions and releases close instead of deleting.** Their
   end states (`completed`, `cancelled`, `archived`, `released`) are
   terminal by design: they are what reports and readiness read, so moving
   back would rewrite history. A new plan or cycle is the way to "reopen".
5. **Test runs:** a run holds executed results. Completing or aborting
   closes it; the soft delete exists for runs created by mistake through the
   API and is not offered in the UI.
6. **Defects:** the lifecycle is the status (`closed`, `rejected`, reopen).
   The soft delete route serves API clients and duplicates; the UI does not
   offer it so that metrics and readiness keep every defect ever found.
7. **Environments:** delete only works when the environment never had a
   deployment; otherwise the API archives it, so deployment history and
   rollbacks keep their target.
8. **Builds and deployments are facts reported by CI or by people.** They
   change state through transitions and are never deleted, because releases,
   pipelines, rollbacks and quality gates point at them.

## Permissions

Every operation above checks the permission listed in
`docs/permissions-matrix.md`. The Web only hides or disables an action to
explain the rule (for example, project creation for roles below
`organization_admin`, which the Web reads from the session's
`capabilities.createProjects`); the API remains the boundary.
