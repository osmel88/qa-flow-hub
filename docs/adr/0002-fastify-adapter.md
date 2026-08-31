# 0002 — Fastify adapter instead of Express

Status: accepted
Date: 2026-07-31

## Context

NestJS abstracts the HTTP server behind an adapter. The default is Express;
`@nestjs/platform-fastify` is a first-party alternative. Application code is
identical in both cases *until* something touches the native request or reply
object.

The workload is a JSON API: many small requests, most of the latency spent
waiting for PostgreSQL, and a traceability matrix endpoint that can return large
payloads.

## Options

**Express.** The default. Largest ecosystem; every Nest recipe on the internet
assumes it. Slower routing and JSON serialization, and middleware ordering is a
convention rather than a mechanism.

**Fastify.** Radix-tree routing, compiled JSON serialization (roughly 2× the
throughput of Express in typical API benchmarks), an encapsulated plugin system
where registration order is explicit, and `inject()` for running requests
against the application without opening a socket.

## Decision

Use the Fastify adapter.

The throughput difference alone would not justify diverging from the default —
the database dominates. Two other properties did:

1. **Plugin ordering is explicit.** Security headers, CORS and rate limiting are
   registered in a deliberate order in `apps/api/src/main.ts`, with a comment
   explaining why helmet goes first (so that even a 429 produced by the rate
   limiter carries security headers).
2. **`app.inject()` makes the integration suite fast and deterministic.** The
   suite that proves tenant isolation will grow to hundreds of cases; running
   them without a real socket keeps that affordable.

## Consequences

**Good.** Better throughput and lower memory per request; explicit plugin
pipeline; fast integration tests.

**Bad.** Ecosystem friction, and it appeared immediately: the Swagger UI failed
at startup with `The "@fastify/static" package is missing`, which required
adding that plugin. Expect the same class of problem with any Nest package that
assumes Express — file uploads and session middleware are the usual suspects.

Anything that touches the native reply object (`apps/api/src/errors/all-exceptions.filter.ts`
uses `FastifyReply`) is coupled to Fastify. That surface is intentionally tiny:
one filter.

**Cost of reversal.** Low. Swapping the adapter means changing `main.ts`, the
few Fastify type imports and the plugin registrations.
