import { t } from './i18n';
import type { MessageKey } from './messages/en';

/**
 * Validation messages come from the shared schemas in English, because the API
 * uses the same schemas. The Web maps the known ones to catalog keys here, in
 * one place, instead of each screen rewording them; anything unknown is shown
 * as it came.
 */
const PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  key: MessageKey;
  vars?: (match: RegExpMatchArray) => Record<string, string>;
}> = [
  {
    pattern: /^Password must be at least (\d+) characters$/,
    key: 'validation.passwordMin',
    vars: (m) => ({ min: m[1] ?? '' }),
  },
  {
    pattern: /^Password must be at most (\d+) characters$/,
    key: 'validation.passwordMax',
    vars: (m) => ({ max: m[1] ?? '' }),
  },
  { pattern: /^Password must contain a lowercase letter$/, key: 'validation.passwordLowercase' },
  { pattern: /^Password must contain an uppercase letter$/, key: 'validation.passwordUppercase' },
  { pattern: /^Password must contain a digit$/, key: 'validation.passwordDigit' },
  {
    pattern: /^The new password must be different from the current one$/,
    key: 'validation.passwordSameAsCurrent',
  },
  { pattern: /^The passwords do not match$/, key: 'validation.passwordsDoNotMatch' },
  { pattern: /^expects a number$/, key: 'validation.expectsNumber' },
  { pattern: /^expects true or false$/, key: 'validation.expectsBoolean' },
  { pattern: /^expects a YYYY-MM-DD date$/, key: 'validation.expectsDate' },
  { pattern: /^Required$/, key: 'validation.required' },
  { pattern: /^Invalid email$/, key: 'validation.invalidEmail' },
  { pattern: /^A valid email address is required$/, key: 'validation.invalidEmail' },
  {
    pattern: /^Enter the 6-digit code from your authenticator app$/,
    key: 'c_mfaSettings.codeMustBeSixDigits',
  },
  {
    pattern: /^String must contain at least (\d+) character\(s\)$/,
    key: 'validation.tooShort',
    vars: (m) => ({ min: m[1] ?? '' }),
  },
  {
    pattern: /^String must contain at most (\d+) character\(s\)$/,
    key: 'validation.tooLong',
    vars: (m) => ({ max: m[1] ?? '' }),
  },
];

/** A shared-schema validation message in the active language. */
export function validationMessage(message: string): string {
  for (const { pattern, key, vars } of PATTERNS) {
    const match = message.match(pattern);
    if (match !== null) return t(key, vars?.(match));
  }
  return message;
}
