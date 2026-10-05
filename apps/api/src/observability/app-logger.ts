import { ConsoleLogger, LogLevel as NestLogLevel, LoggerService } from '@nestjs/common';
import type { Env } from '../config/env.schema';

type LogLevel = Env['LOG_LEVEL'];

const SEVERITY: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** `LOG_LEVEL` speaks pino's vocabulary; Nest calls the same levels log and verbose. */
const NEST_LEVELS: Readonly<Record<LogLevel, readonly NestLogLevel[]>> = {
  fatal: ['fatal'],
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  info: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  trace: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
};

/**
 * Keys whose value is never written, at any depth. The request log does not
 * carry headers or bodies in the first place; this is the second line, for the
 * day someone logs an object they did not read first.
 */
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|credential/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 4;

const STACK_TRACE = /\n\s+at /;

export interface JsonLoggerOptions {
  level: LogLevel;
  /** Where each line goes. Standard output by default; tests capture it. */
  write?: (line: string) => void;
  /** The id of the request being served, when there is one. */
  requestId?: () => string | undefined;
}

/**
 * One JSON object per line on standard output, which is the format every log
 * collector ingests without a parser of its own.
 *
 * Every line has `time`, `level` and `msg`; `context` is the Nest logger name
 * and `requestId` comes from the request's AsyncLocalStorage context, so a line
 * logged deep inside a service is still correlated with the request that
 * caused it. An object passed as the message is merged into the line, which is
 * how the request log adds `method`, `route`, `statusCode` and `durationMs`.
 */
export class JsonLogger implements LoggerService {
  private readonly threshold: number;
  private readonly write: (line: string) => void;

  constructor(private readonly options: JsonLoggerOptions) {
    this.threshold = SEVERITY[options.level];
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }

  private emit(level: LogLevel, message: unknown, params: unknown[]): void {
    if (SEVERITY[level] < this.threshold) {
      return;
    }

    // Nest appends the logger's context as the last argument; an error call
    // may put a stack trace before it.
    const strings = params.filter((param): param is string => typeof param === 'string');
    const last = strings.at(-1);
    const stack = strings.find((param) => STACK_TRACE.test(param));
    const context = last !== undefined && last !== stack ? last : undefined;
    const requestId = this.options.requestId?.();

    const line: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      ...(context === undefined ? {} : { context }),
      ...(requestId === undefined ? {} : { requestId }),
      ...describe(message),
      ...(stack === undefined ? {} : { stack }),
    };

    this.write(JSON.stringify(line));
  }
}

function describe(message: unknown): Record<string, unknown> {
  if (message instanceof Error) {
    return { msg: message.message, ...(message.stack ? { stack: message.stack } : {}) };
  }
  if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
    const fields = redact(message, 0) as Record<string, unknown>;
    return { msg: typeof fields['msg'] === 'string' ? fields['msg'] : '', ...fields };
  }
  return { msg: typeof message === 'string' ? message : JSON.stringify(redact(message, 0)) };
}

export function redact(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, depth + 1),
    ]),
  );
}

/** The application logger for the configured format and level. */
export function createAppLogger(options: {
  format: Env['LOG_FORMAT'];
  level: LogLevel;
  requestId?: () => string | undefined;
}): LoggerService {
  if (options.format === 'json') {
    return new JsonLogger({
      level: options.level,
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    });
  }
  return new ConsoleLogger({ logLevels: [...NEST_LEVELS[options.level]] });
}
