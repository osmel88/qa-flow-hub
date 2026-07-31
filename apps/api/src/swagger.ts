import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * The OpenAPI document is the contract the web client and future integrations
 * are written against, so it is generated from the code — a hand-maintained
 * spec always drifts.
 */
export function setupSwagger(app: NestFastifyApplication): void {
  const document = new DocumentBuilder()
    .setTitle('qa-flow-hub API')
    .setDescription(
      [
        'QA management platform: organizations, projects, requirements, test cases,',
        'runs, results, defects and traceability.',
        '',
        'All functional data belongs to an organization. Requests are authenticated',
        'with a bearer access token whose payload carries the active organization;',
        'the server never trusts an organization id supplied by the client without',
        'checking membership.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token' },
      'access-token',
    )
    .addTag('health', 'Liveness and readiness probes')
    .addTag('auth', 'Registration, login, refresh and sessions')
    .build();

  const openApi = SwaggerModule.createDocument(app, document, { deepScanRoutes: true });

  SwaggerModule.setup('docs', app, openApi, {
    jsonDocumentUrl: 'docs/openapi.json',
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha', operationsSorter: 'alpha' },
    customSiteTitle: 'qa-flow-hub API',
  });
}
