# 0011 — Zod contracts shared between API and web client

Status: accepted
Date: 2026-08-16

## Context

The API and the web client are two applications in one repository, and they must
agree on every request and response shape. They also must agree on validation
rules: if the client accepts a 300-character title and the API caps it at 200, the
user meets the rule as a server error after typing.

The options are not "typed or untyped" — TypeScript gives types either way. They are
about **where the single definition lives** and whether it is enforced at runtime.

## Options

**DTO classes with `class-validator`** (the NestJS default). Idiomatic in Nest,
decorator-based, and unusable from the browser bundle: it would drag decorator
metadata and `reflect-metadata` into the client, and the inferred types are weaker
than the schemas.

**OpenAPI as the source of truth, with generated clients.** Correct at scale, and
the toolchain is the cost: a generator step, generated code in review, and a
document that must be regenerated and committed before the client can use it.

**Types shared, validation duplicated.** A shared `interface` plus hand-written
checks on both sides. The types agree and the *rules* drift, which is the failure we
actually care about.

**Zod schemas in a shared package.** Chosen.

## Decision

`packages/shared` holds a Zod schema per request and response, and the TypeScript
types are inferred from them with `z.infer`. The API validates with a pipe that
**replaces** the value with the schema's output; the client imports the same schema
for its forms and the same inferred types for its calls. OpenAPI is generated *from*
the code for documentation, not consumed as the contract.

One definition, three consumers: server validation, client validation, and both
sides' types.

## Consequences

**Good.** A rule cannot drift: changing `max(200)` changes the form and the endpoint
in one commit, and forgetting one side is a type error, not a runtime surprise.
Validation is not only checking but **normalising** — the email schema trims and
lower-cases, and the server uses the normalised value, so the client cannot send a
subtly different one. Unknown keys are stripped by default, which is the mass
assignment defence for free.

**Bad.** The web bundle carries Zod (a few kilobytes, acceptable) and, more
importantly, `packages/shared` must be built before either app typechecks — a
monorepo ordering constraint that shows up in CI and in the Dockerfile as an
explicit build step. It also makes the shared package a coupling point: a careless
change there breaks two applications at once, which is the intended trade but does
mean it deserves stricter review than an app-local change.

**Bad, and open.** The integration suite reads `response.json()` as `any` instead of
parsing responses through these schemas, so the tests assert on the wire format
without checking it against the contract. Parsing them would type the tests **and**
catch contract drift; it is ~800 assertions of work and is recorded as technical
debt rather than done halfway.

**Not chosen but still available.** If a third-party or non-TypeScript client ever
consumes this API, OpenAPI generation is already in place and can become the
published contract without changing this decision.
