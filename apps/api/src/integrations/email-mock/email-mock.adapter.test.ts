import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { EmailMessage } from '../adapter.contracts';
import { MockEmailAdapter } from './email-mock.adapter';

const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  to: 'ada@example.test',
  from: 'no-reply@qa-flow-hub.local',
  subject: 'Hello',
  text: 'Body with https://app.local/accept?token=SECRET-TOKEN',
  reference: 'ntf_1',
  ...overrides,
});

describe('MockEmailAdapter', () => {
  let adapter: MockEmailAdapter;
  let lines: string[];

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    adapter = new MockEmailAdapter();
    lines = [];
    const capture = (m: unknown): void => {
      lines.push(String(m));
    };
    vi.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a message, hands out deterministic ids and keeps it inspectable', async () => {
    const first = await adapter.send(message());
    const second = await adapter.send(message({ reference: 'ntf_2' }));

    expect(first).toEqual({ accepted: true, messageId: 'mock-000001' });
    expect(second.messageId).toBe('mock-000002');
    expect(adapter.find('ntf_1')).toMatchObject({
      to: 'ada@example.test',
      subject: 'Hello',
      html: null,
      tags: {},
      messageId: 'mock-000001',
    });
    expect(adapter.findMany(['ntf_2', 'missing', 'ntf_1']).map((m) => m.reference)).toEqual([
      'ntf_2',
      'ntf_1',
    ]);
    expect(adapter.all()).toHaveLength(2);
  });

  it('rejects bounce and defer addresses without capturing them', async () => {
    const bounce = await adapter.send(message({ to: 'Ada+Bounce@example.test' }));
    const defer = await adapter.send(message({ to: 'ada+defer@example.test' }));

    expect(bounce).toEqual({ accepted: false, messageId: null, reason: 'mailbox_unavailable' });
    expect(defer).toEqual({ accepted: false, messageId: null, reason: 'provider_unavailable' });
    expect(adapter.all()).toEqual([]);
    // A rejection does not consume an id: the next success is still the first.
    expect((await adapter.send(message())).messageId).toBe('mock-000001');
  });

  it('logs only the reference and the recipient domain, never the body or the address', async () => {
    await adapter.send(message());
    await adapter.send(message({ to: 'ada+bounce@example.test', reference: 'ntf_2' }));

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain('domain=example.test');
      expect(line).not.toContain('ada@');
      expect(line).not.toContain('ada+bounce@');
      expect(line).not.toContain('SECRET-TOKEN');
      expect(line).not.toContain('Hello');
    }
  });

  it('forgets the oldest message once the capture window is full', async () => {
    for (let i = 0; i < 501; i += 1) {
      await adapter.send(message({ reference: `ntf_${i}` }));
    }

    expect(adapter.all()).toHaveLength(500);
    expect(adapter.find('ntf_0')).toBeNull();
    expect(adapter.find('ntf_500')).not.toBeNull();
  });

  it('starts over on reset', async () => {
    await adapter.send(message());
    adapter.reset();

    expect(adapter.all()).toEqual([]);
    expect((await adapter.send(message())).messageId).toBe('mock-000001');
  });
});
