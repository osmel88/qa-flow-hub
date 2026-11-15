import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth.contracts.js';

/**
 * Password recovery. A reset link is valid for `PASSWORD_RESET_TTL_MINUTES`,
 * works once, and only the newest link of an account is alive. An account can
 * ask for at most `PASSWORD_RESET_MAX_REQUESTS` links per
 * `PASSWORD_RESET_WINDOW_MINUTES`; extra requests get the same answer and send
 * nothing, so the endpoint cannot be used to flood a mailbox.
 */
export const PASSWORD_RESET_TTL_MINUTES = 30;
export const PASSWORD_RESET_MAX_REQUESTS = 3;
export const PASSWORD_RESET_WINDOW_MINUTES = 15;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(20).max(200),
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * The same answer for every address. `mockResetUrl` exists only outside
 * production with the mock email provider, so a local or staging install can
 * finish the flow without a mailbox; it is never present in production.
 */
export interface ForgotPasswordView {
  accepted: true;
  mockResetUrl?: string | null;
}

export const PASSWORD_RESET_INVALID_MESSAGE = 'This reset link is invalid or has expired';
