import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from './auth.contracts.js';

/** RFC 6238 parameters. Fixed: authenticator apps assume exactly these. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const MFA_RECOVERY_CODE_COUNT = 10;

/** Six digits; spaces a user may type from the app's "123 456" are removed. */
export const totpCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'));

/** `xxxxx-xxxxx`, case-insensitive; normalised to lower case without spaces. */
export const recoveryCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, '').toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9]{5}-[a-z0-9]{5}$/, 'Enter a recovery code like abcde-12345'));

export const mfaSetupSchema = z.object({
  /** Re-authentication: a stolen access token alone must not enrol a factor. */
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type MfaSetupInput = z.infer<typeof mfaSetupSchema>;

export const mfaConfirmSchema = z.object({ code: totpCodeSchema });
export type MfaConfirmInput = z.infer<typeof mfaConfirmSchema>;

export const mfaDisableSchema = z.object({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  code: totpCodeSchema,
});
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;

export const mfaRegenerateSchema = z.object({ code: totpCodeSchema });
export type MfaRegenerateInput = z.infer<typeof mfaRegenerateSchema>;

/** Second login step: exactly one of `code` or `recoveryCode`. */
export const mfaVerifySchema = z
  .object({
    challengeToken: z.string().min(16).max(256),
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .strict()
  .refine((value) => (value.code === undefined) !== (value.recoveryCode === undefined), {
    message: 'Send either an authenticator code or a recovery code',
    path: ['code'],
  });
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

/** What `POST /auth/login` returns instead of a session when MFA is on. */
export interface MfaChallengeView {
  mfaRequired: true;
  challengeToken: string;
  expiresIn: number;
}

export interface MfaStatusView {
  enabled: boolean;
  confirmedAt: string | null;
  recoveryCodesRemaining: number;
  /** Whether the current session was opened with a second factor. */
  sessionVerified: boolean;
}

/** Shown once: the secret is never returned again after this response. */
export interface MfaSetupView {
  secret: string;
  otpauthUri: string;
}

/** Shown once, on confirmation and on regeneration. */
export interface MfaRecoveryCodesView {
  recoveryCodes: string[];
}
