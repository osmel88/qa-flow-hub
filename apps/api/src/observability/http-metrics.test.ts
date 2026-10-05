import { describe, expect, it } from 'vitest';
import { HttpMetrics } from './http-metrics';

describe('HttpMetrics', () => {
  it('counts requests and durations by method, route template and status', () => {
    const metrics = new HttpMetrics();
    metrics.observe({
      method: 'GET',
      route: '/api/v1/projects/:projectId',
      statusCode: 200,
      seconds: 0.02,
    });
    metrics.observe({
      method: 'GET',
      route: '/api/v1/projects/:projectId',
      statusCode: 200,
      seconds: 0.3,
    });
    metrics.observe({
      method: 'GET',
      route: '/api/v1/projects/:projectId',
      statusCode: 404,
      seconds: 0.01,
    });

    const text = metrics.render();

    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toContain(
      'http_requests_total{method="GET",route="/api/v1/projects/:projectId",status="200"} 2',
    );
    expect(text).toContain(
      'http_requests_total{method="GET",route="/api/v1/projects/:projectId",status="404"} 1',
    );
    expect(text).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/api/v1/projects/:projectId",le="0.025"} 2',
    );
    expect(text).toContain(
      'http_request_duration_seconds_count{method="GET",route="/api/v1/projects/:projectId"} 3',
    );
    expect(text).toMatch(/process_resident_memory_bytes \d+/);
  });

  it('keeps the label set closed: unmatched URLs and unknown methods collapse', () => {
    const metrics = new HttpMetrics();
    metrics.observe({ method: 'PROPFIND', route: undefined, statusCode: 404, seconds: 0.001 });

    expect(metrics.render()).toContain(
      'http_requests_total{method="OTHER",route="unmatched",status="404"} 1',
    );
  });

  it('escapes label values', () => {
    const metrics = new HttpMetrics();
    metrics.observe({ method: 'GET', route: '/a"b\\c', statusCode: 200, seconds: 0.001 });

    expect(metrics.render()).toContain('route="/a\\"b\\\\c"');
  });
});
