import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id, the current recommendation for password storage.
 *
 * Why not bcrypt: bcrypt is cheap on GPUs and capped at 72 bytes. Argon2id is
 * *memory*-hard, which is what makes large-scale offline cracking expensive
 * rather than merely slow, and it resists side channels better than argon2i.
 *
 * The parameters below follow OWASP's baseline (19 MiB, 2 iterations, 1 degree
 * of parallelism). They are a deliberate trade: raising memory raises the
 * attacker's cost and also the cost of every login on our own servers.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};

/**
 * A precomputed hash of a value nobody knows, used to burn the same CPU time
 * when the email does not exist. Without it, "unknown email" answers in
 * microseconds and "wrong password" in tens of milliseconds, and that gap is a
 * usable account-enumeration oracle.
 */
let dummyHashPromise: Promise<string> | undefined;

@Injectable()
export class PasswordService {
  hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, ARGON2_OPTIONS);
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // A malformed hash in the database must read as "wrong password", never
      // as a 500 that tells an attacker something unusual happened.
      return false;
    }
  }

  /** Equalises response time for a login against an address with no account. */
  async wasteTime(): Promise<void> {
    dummyHashPromise ??= argon2.hash('a-password-that-belongs-to-nobody', ARGON2_OPTIONS);
    await this.verify(await dummyHashPromise, 'not-the-password');
  }

  /**
   * True when the stored hash was produced with weaker parameters than the
   * ones in force. Lets us silently upgrade a user's hash on their next
   * successful login instead of forcing a password reset.
   */
  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  }
}
