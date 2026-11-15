-- Password recovery (login findings, before S7-F7).
--
-- "password_reset_tokens" is account level, like "sessions" and
-- "mfa_challenges": no organization and therefore no RLS. The runtime role
-- reaches it through the default privileges granted in
-- 20260816160000_row_level_security. Only a SHA-256 of the token is stored.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'password_reset';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'password_reset';

CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "requestedIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");
CREATE INDEX "password_reset_tokens_userId_createdAt_idx" ON "password_reset_tokens"("userId", "createdAt");

ALTER TABLE "password_reset_tokens"
  ADD CONSTRAINT "password_reset_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
