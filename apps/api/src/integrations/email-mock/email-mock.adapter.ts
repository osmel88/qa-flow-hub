import { Injectable, Logger } from '@nestjs/common';
import { EmailAdapter, EmailDeliveryOutcome, EmailMessage } from '../adapter.contracts';

/** A message the mock accepted, kept verbatim so a test can read the body. */
export interface CapturedEmail {
  reference: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string | null;
  tags: Record<string, string>;
  messageId: string;
  capturedAt: Date;
}

/**
 * Addresses the mock refuses, deterministically, so a failure path can be
 * exercised from an HTTP test by choosing a recipient and nothing else:
 *
 *   anything+bounce@…   → mailbox_unavailable  (a hard bounce)
 *   anything+defer@…    → provider_unavailable (a transient outage)
 *
 * Plus-addressing is used because it is valid email syntax and survives the
 * product's own normalisation, unlike a magic domain that a validator might
 * one day reject.
 */
const REJECTIONS: ReadonlyArray<{ marker: string; reason: string }> = [
  { marker: '+bounce@', reason: 'mailbox_unavailable' },
  { marker: '+defer@', reason: 'provider_unavailable' },
];

const MAX_CAPTURED = 500;

/**
 * The only email provider this build ships. It never opens a socket: `send`
 * stores the message in memory and answers as a vendor would. What it logs is
 * the reference and the recipient's domain — never the body, which may carry
 * an invitation link, and never the full address.
 *
 * Lookups go by `reference` (our notification id) on purpose: the outbox
 * endpoint first loads the caller's own ledger rows, tenant-scoped by RLS,
 * and only then asks this store for their bodies. The store itself has no
 * notion of organization, so it cannot be the layer that leaks one.
 */
@Injectable()
export class MockEmailAdapter implements EmailAdapter {
  readonly provider = 'mock';
  private readonly logger = new Logger(MockEmailAdapter.name);
  private readonly captured = new Map<string, CapturedEmail>();
  private sequence = 0;

  send(message: EmailMessage): Promise<EmailDeliveryOutcome> {
    const to = message.to.toLowerCase();
    const rejection = REJECTIONS.find((rule) => to.includes(rule.marker));
    if (rejection !== undefined) {
      this.logger.warn(
        `Mock email rejected: ref=${message.reference} domain=${domainOf(to)} reason=${rejection.reason}`,
      );
      return Promise.resolve({ accepted: false, messageId: null, reason: rejection.reason });
    }

    this.sequence += 1;
    const messageId = `mock-${String(this.sequence).padStart(6, '0')}`;
    this.captured.set(message.reference, {
      reference: message.reference,
      to: message.to,
      from: message.from,
      subject: message.subject,
      text: message.text,
      html: message.html ?? null,
      tags: message.tags ?? {},
      messageId,
      capturedAt: new Date(),
    });
    if (this.captured.size > MAX_CAPTURED) {
      const oldest = this.captured.keys().next().value;
      if (oldest !== undefined) {
        this.captured.delete(oldest);
      }
    }

    this.logger.log(
      `Mock email captured: ref=${message.reference} domain=${domainOf(to)} id=${messageId}`,
    );
    return Promise.resolve({ accepted: true, messageId });
  }

  find(reference: string): CapturedEmail | null {
    return this.captured.get(reference) ?? null;
  }

  findMany(references: readonly string[]): CapturedEmail[] {
    const found: CapturedEmail[] = [];
    for (const reference of references) {
      const email = this.captured.get(reference);
      if (email !== undefined) {
        found.push(email);
      }
    }
    return found;
  }

  /** Every captured message. For tests and the local harness only. */
  all(): CapturedEmail[] {
    return [...this.captured.values()];
  }

  reset(): void {
    this.captured.clear();
    this.sequence = 0;
  }
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? 'unknown' : address.slice(at + 1);
}
