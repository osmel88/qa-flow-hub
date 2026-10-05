/**
 * The client address of a request behind `trustedHops` reverse proxies.
 *
 * The candidate list is the socket peer followed by `X-Forwarded-For` read
 * right to left: each proxy appends the address it received the connection
 * from. Trusting `n` hops means believing the last `n` entries were written
 * by our own infrastructure, so the client is the entry `n` steps back. The
 * leftmost entries are whatever the client typed and are never used unless
 * the chain is shorter than configured.
 *
 * This is the same rule Fastify applies when `trustProxy` is a hop count
 * (via `proxy-addr`), and it has to be: the rate limiter keys on Fastify's
 * `request.ip`, the audit log on this function, and both must name the same
 * caller.
 */
export function resolveClientIp(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedHops: number,
): string | undefined {
  if (socketAddress === undefined || trustedHops === 0) {
    return socketAddress;
  }

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const forwarded = header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .reverse();

  const chain = [socketAddress, ...forwarded];
  return chain[Math.min(trustedHops, chain.length - 1)];
}
