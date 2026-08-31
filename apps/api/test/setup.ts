/**
 * Integration test environment.
 *
 * Secrets here are throwaway values used only by the test database; nothing in
 * this file is valid anywhere else. The real values come from the environment
 * in CI and from `.env` locally.
 */
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] ??= 'error';
process.env['JWT_ACCESS_SECRET'] ??= 'test-access-secret-value-with-enough-length';
process.env['JWT_REFRESH_SECRET'] ??= 'test-refresh-secret-value-with-enough-length';
process.env['DATABASE_URL'] ??=
  'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public';
process.env['SWAGGER_ENABLED'] ??= 'false';
// Rate limiting is exercised by its own test; elsewhere it would make suites flaky.
process.env['RATE_LIMIT_MAX'] ??= '100000';
