import { describe, expect, it } from 'vitest';
import { resolveClientIp } from './client-ip';

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For entirely when no proxy is trusted', () => {
    expect(resolveClientIp('10.0.0.5', '1.2.3.4', 0)).toBe('10.0.0.5');
  });

  it('takes the address one hop back behind a single proxy', () => {
    expect(resolveClientIp('10.0.0.5', '203.0.113.7', 1)).toBe('203.0.113.7');
  });

  it('does not let a client choose its address by prepending entries', () => {
    // The client sent "X-Forwarded-For: 6.6.6.6"; our proxy appended the real peer.
    expect(resolveClientIp('10.0.0.5', '6.6.6.6, 203.0.113.7', 1)).toBe('203.0.113.7');
  });

  it('walks back as many hops as configured', () => {
    expect(resolveClientIp('10.0.0.5', '203.0.113.7, 10.0.0.9', 2)).toBe('203.0.113.7');
  });

  it('stops at the oldest entry when the chain is shorter than the configured hops', () => {
    expect(resolveClientIp('10.0.0.5', '203.0.113.7', 3)).toBe('203.0.113.7');
    expect(resolveClientIp('10.0.0.5', undefined, 2)).toBe('10.0.0.5');
  });

  it('accepts the header split over several lines', () => {
    expect(resolveClientIp('10.0.0.5', ['6.6.6.6', '203.0.113.7'], 1)).toBe('203.0.113.7');
  });
});
