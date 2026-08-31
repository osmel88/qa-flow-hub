# 0001 — NestJS as the backend framework

Status: accepted
Date: 2026-07-31

## Context

qa-flow-hub is a multi-tenant SaaS with roughly a dozen functional modules that
share the same cross-cutting concerns: authentication, organization isolation,
authorization by role, input validation, audit logging and error shaping. Those
concerns must be applied *identically* to every endpoint, because a single
endpoint that forgets the tenant filter is a data breach.

The product is expected to outlive its first author, so structure and
testability matter more than the smallest possible dependency footprint.

## Options

**Express, plain.** Minimal, familiar, enormous ecosystem. But it offers no
answer to dependency wiring, module boundaries or ordered cross-cutting
concerns. In a codebase this size those answers get invented ad hoc, differently
in each area, and services end up importing each other directly — which also
makes them hard to test in isolation.

**Fastify, plain.** Faster and with a real plugin system with encapsulation.
Still no dependency injection and no module system for application code; we
would build both by hand.

**NestJS.** Opinionated framework with dependency injection, modules and a
well-defined request lifecycle (guards → interceptors → pipes → handler →
filters). Server-agnostic: it runs on Express or Fastify.

## Decision

Use NestJS, with TypeScript in strict mode.

The deciding factor is the request lifecycle. Tenant isolation and authorization
are applied as **global guards with explicit opt-outs**
(`apps/api/src/common/decorators/public.decorator.ts`), so the default for any
new endpoint is "protected". That inversion — secure by default, open by
explicit and greppable decision — is exactly the property this product needs,
and it is a framework feature, not something we have to remember.

Dependency injection is the second factor: it lets services be unit tested
without HTTP, and lets the Prisma client be swapped or wrapped in tests.

## Consequences

**Good.** Uniform structure across modules; cross-cutting policies declared once
and applied globally; unit-testable services; a large body of documentation and
conventions that a new developer can be pointed at.

**Bad.** Decorators and metadata are "magic": the failure mode
`Nest can't resolve dependencies of the X (?)` is opaque until you learn to read
it, and `emitDecoratorMetadata` creates a non-obvious rule (`import type` breaks
injection). Nest also encourages abstraction; we counter that explicitly in the
codebase conventions — no repository interfaces with a single implementation, no
layers that only forward calls.

**Cost of reversal.** High for the module and controller layer, low for the
domain: business rules live in services that receive their dependencies as
constructor arguments, so they are portable to another framework.
