/**
 * Request metrics in the Prometheus text exposition format, kept in process.
 *
 * A dependency would be the usual choice; the reason there is none is that
 * the whole need is two series and three gauges, and writing them out shows
 * exactly what a scraper reads. Labels are the method, the *route template*
 * (`/api/v1/projects/:projectId`, never the concrete URL) and the status. That
 * is a closed set: no organization, user or entity id ever becomes a label,
 * both because it would leak tenant activity to whoever reads the metrics and
 * because unbounded labels are how a metrics backend runs out of memory.
 */

const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Requests that matched no route share one label instead of one per URL. */
export const UNMATCHED_ROUTE = 'unmatched';

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

export class HttpMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, Histogram>();
  private readonly startedAt = Date.now();

  observe(input: {
    method: string;
    route: string | undefined;
    statusCode: number;
    seconds: number;
  }): void {
    const method = KNOWN_METHODS.has(input.method) ? input.method : 'OTHER';
    const route = input.route ?? UNMATCHED_ROUTE;

    const requestKey = labels({ method, route, status: String(input.statusCode) });
    this.requests.set(requestKey, (this.requests.get(requestKey) ?? 0) + 1);

    const durationKey = labels({ method, route });
    const histogram = this.durations.get(durationKey) ?? {
      buckets: DURATION_BUCKETS_SECONDS.map(() => 0),
      sum: 0,
      count: 0,
    };
    DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
      if (input.seconds <= bound) {
        histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
      }
    });
    histogram.sum += input.seconds;
    histogram.count += 1;
    this.durations.set(durationKey, histogram);
  }

  render(): string {
    const lines: string[] = [
      '# HELP http_requests_total HTTP requests served, by method, route template and status.',
      '# TYPE http_requests_total counter',
    ];
    for (const [key, value] of this.requests) {
      lines.push(`http_requests_total{${key}} ${value}`);
    }

    lines.push(
      '# HELP http_request_duration_seconds Time to serve an HTTP request, by method and route template.',
      '# TYPE http_request_duration_seconds histogram',
    );
    for (const [key, histogram] of this.durations) {
      DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
        lines.push(
          `http_request_duration_seconds_bucket{${key},le="${bound}"} ${histogram.buckets[index] ?? 0}`,
        );
      });
      lines.push(`http_request_duration_seconds_bucket{${key},le="+Inf"} ${histogram.count}`);
      lines.push(`http_request_duration_seconds_sum{${key}} ${histogram.sum}`);
      lines.push(`http_request_duration_seconds_count{${key}} ${histogram.count}`);
    }

    const memory = process.memoryUsage();
    lines.push(
      '# HELP process_uptime_seconds Seconds since the API process started.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${(Date.now() - this.startedAt) / 1000}`,
      '# HELP process_resident_memory_bytes Resident set size of the API process.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${memory.rss}`,
      '# HELP nodejs_heap_used_bytes V8 heap in use.',
      '# TYPE nodejs_heap_used_bytes gauge',
      `nodejs_heap_used_bytes ${memory.heapUsed}`,
    );

    return `${lines.join('\n')}\n`;
  }
}

function labels(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
