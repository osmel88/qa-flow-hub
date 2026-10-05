import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Logger, VersioningType } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { AppConfigService } from '../config/app-config.service';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter';
import { RateLimitedError } from '../errors';
import { HttpMetrics, UNMATCHED_ROUTE } from '../observability/http-metrics';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id';

/**
 * The number of trusted proxy hops, readable by Fastify before configuration
 * is. The adapter has to exist before Nest builds the module graph, and the
 * validated configuration only exists after; this holder is the bridge, filled
 * in by `configureApp` before the first request is accepted.
 */
export class ProxyTrust {
  hops = 0;
  readonly trusts = (_address: string, hop: number): boolean => hop < this.hops;
}

/** Credential endpoints that get their own, stricter rate-limit budget. */
const AUTH_LIMITED_ROUTES = ['auth/login', 'auth/register', 'auth/refresh'] as const;
const AUTH_BUCKET = 'auth:';

/**
 * The Fastify adapter both `main.ts` and the integration harness boot.
 *
 * `genReqId` writes the resolved id back onto the raw request: the
 * request-context middleware sees a raw Node request, not Fastify's, and has to
 * arrive at the same id the error filter and the response header use.
 */
export function createFastifyAdapter(proxyTrust: ProxyTrust): FastifyAdapter {
  return new FastifyAdapter({
    trustProxy: proxyTrust.trusts,
    genReqId: (request: IncomingMessage) => {
      const id = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
      request.headers[REQUEST_ID_HEADER] = id;
      return id;
    },
  });
}

/**
 * Everything between "the module graph exists" and "listen": plugins, hooks,
 * routing conventions and the error filter.
 *
 * It is one function shared by `main.ts` and the integration harness on
 * purpose. A test application assembled by hand drifts from production one
 * forgotten plugin at a time, and then the tests prove a configuration that
 * nobody runs.
 */
export async function configureApp(
  app: NestFastifyApplication,
  proxyTrust: ProxyTrust,
): Promise<void> {
  const config = app.get(AppConfigService);
  proxyTrust.hops = config.trustProxyHops;

  const fastify = app.getHttpAdapter().getInstance();
  const metrics = new HttpMetrics();
  const requestLog = new Logger('HTTP');

  // First hook, so that every response carries the id — including the ones
  // produced before Nest runs: rate-limited, unmatched, rejected by a parser.
  fastify.addHook('onRequest', (request, reply, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });

  // One line per request, after the response is sent. Method, route template,
  // status and duration only: never headers, never bodies, never the query
  // string, so a token in a URL or a password in a payload cannot reach a log.
  fastify.addHook('onResponse', (request, reply, done) => {
    const route = routeOf(request);
    metrics.observe({
      method: request.method,
      route,
      statusCode: reply.statusCode,
      seconds: reply.elapsedTime / 1000,
    });

    const line = {
      msg: 'request completed',
      requestId: String(request.id),
      method: request.method,
      route: route ?? UNMATCHED_ROUTE,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime * 100) / 100,
    };
    // Probes arrive every few seconds from the orchestrator; at info level
    // they would drown the requests somebody actually made.
    if (route?.startsWith('/health') === true) {
      requestLog.debug(line);
    } else {
      requestLog.log(line);
    }
    done();
  });

  await app.register(import('@fastify/helmet'), contentSecurityPolicy(config));

  // Refresh tokens travel as an HttpOnly cookie; see RefreshCookieService.
  await app.register(import('@fastify/cookie'));

  // Evidence uploads. The parser truncates at the size limit instead of
  // throwing, so the attachments service sees the whole request, removes the
  // partial object and answers 413 itself. One file per request, on purpose.
  await app.register(import('@fastify/multipart'), {
    throwFileSizeLimit: false,
    limits: { files: 1, fields: 4, fileSize: config.storage.maxSizeBytes },
  });

  await app.register(import('@fastify/cors'), {
    origin: config.corsOrigins,
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });

  // In-process store, per instance: with N replicas the effective limit is N
  // times the configured one. The edge in front of the API (proxy, CDN or load
  // balancer) is where the cluster-wide limit lives; see docs/deployment.md.
  const authRoutes = new Set(AUTH_LIMITED_ROUTES.map((path) => `/${config.apiPrefix}/v1/${path}`));
  const isAuthBucket = (key: string): boolean => key.startsWith(AUTH_BUCKET);
  await app.register(import('@fastify/rate-limit'), {
    keyGenerator: (request) =>
      authRoutes.has(request.routeOptions.url ?? '') ? `${AUTH_BUCKET}${request.ip}` : request.ip,
    max: (_request, key) => (isAuthBucket(key) ? config.authRateLimit.max : config.rateLimit.max),
    timeWindow: (_request, key) =>
      isAuthBucket(key) ? config.authRateLimit.windowMs : config.rateLimit.windowMs,
    // An orchestrator probing every few seconds must never be told to back off.
    allowList: (request) => request.routeOptions.url?.startsWith('/health') === true,
    // A domain error and not a plain object, so the exception filter writes the
    // standard envelope. `Retry-After` is already on the reply by now.
    errorResponseBuilder: (_request, context) =>
      new RateLimitedError(
        `Too many requests, retry in ${context.after}`,
        Math.ceil(context.ttl / 1000),
      ),
  });

  if (config.metrics.enabled) {
    const expected = config.metrics.token;
    fastify.get('/metrics', (request, reply) => {
      if (expected !== null && !bearerMatches(request.headers.authorization, expected)) {
        void reply.status(401).send({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'A valid metrics token is required',
            requestId: String(request.id),
          },
        });
        return;
      }
      void reply
        .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(metrics.render());
    });
  }

  app.setGlobalPrefix(config.apiPrefix, { exclude: ['health', 'health/ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new AllExceptionsFilter());
}

/**
 * The route *template* the request matched, or `undefined` for a 404. The
 * template is what makes the metric label set finite.
 */
function routeOf(request: FastifyRequest): string | undefined {
  return request.is404 ? undefined : request.routeOptions.url;
}

/**
 * The API answers JSON and never renders a document, so its own policy allows
 * nothing at all: a response that somehow ends up in a browser tab cannot load
 * a script, a frame or a form target. Swagger UI is a document, so when it is
 * served the policy relaxes to helmet's defaults (production) or is dropped
 * (development, where the UI is used interactively).
 */
function contentSecurityPolicy(config: AppConfigService): {
  contentSecurityPolicy?: false | { useDefaults: false; directives: Record<string, string[]> };
} {
  if (config.swaggerEnabled) {
    // Omitted rather than `undefined`: the plugin checks for the key.
    return config.isProduction ? {} : { contentSecurityPolicy: false };
  }
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
  };
}

/**
 * Compares digests rather than the strings: `timingSafeEqual` needs equal
 * lengths, and comparing hashes keeps the token's length out of the timing too.
 */
function bearerMatches(header: string | undefined, expected: string): boolean {
  const presented = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : '';
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}
