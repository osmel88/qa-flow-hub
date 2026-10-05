import { describe, expect, it } from 'vitest';
import { JsonLogger } from './app-logger';

function capture(level: 'info' | 'warn' | 'debug' = 'info', requestId?: string) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new JsonLogger({
    level,
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    ...(requestId === undefined ? {} : { requestId: () => requestId }),
  });
  return { logger, lines };
}

describe('JsonLogger', () => {
  it('writes one JSON object per line with time, level, context and message', () => {
    const { logger, lines } = capture();
    logger.log('ready', 'Bootstrap');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', context: 'Bootstrap', msg: 'ready' });
    expect(typeof lines[0]?.['time']).toBe('string');
  });

  it('merges an object message into the line', () => {
    const { logger, lines } = capture();
    logger.log({ msg: 'request completed', method: 'GET', statusCode: 200 }, 'HTTP');

    expect(lines[0]).toMatchObject({ msg: 'request completed', method: 'GET', statusCode: 200 });
  });

  it('correlates lines with the current request id, letting an explicit one win', () => {
    const { logger, lines } = capture('info', 'req-from-context');
    logger.log('inside a service');
    logger.log({ msg: 'explicit', requestId: 'req-explicit' });

    expect(lines[0]?.['requestId']).toBe('req-from-context');
    expect(lines[1]?.['requestId']).toBe('req-explicit');
  });

  it('redacts credential-shaped keys at any depth', () => {
    const { logger, lines } = capture();
    logger.log({
      msg: 'oops',
      headers: { authorization: 'Bearer abc', cookie: 'qf_refresh=xyz' },
      body: { password: 'hunter2', nested: { refreshToken: 't' } },
    });

    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain('Bearer abc');
    expect(text).not.toContain('qf_refresh=xyz');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[redacted]');
  });

  it('separates the stack trace from the context of an error', () => {
    const { logger, lines } = capture();
    logger.error('boom', 'Error: boom\n    at somewhere (file.ts:1:1)', 'AllExceptionsFilter');

    expect(lines[0]).toMatchObject({ level: 'error', msg: 'boom', context: 'AllExceptionsFilter' });
    expect(lines[0]?.['stack']).toContain('at somewhere');
  });

  it('drops lines below the configured level', () => {
    const { logger, lines } = capture('warn');
    logger.log('chatty');
    logger.debug('chattier');
    logger.warn('kept');

    expect(lines.map((line) => line['msg'])).toEqual(['kept']);
  });
});
