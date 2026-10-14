import { createHash, randomBytes } from "node:crypto";

/**
 * Generates a URL-safe, high-entropy reset token. The raw value is what the user
 * receives; only its SHA-256 hash is persisted so a database leak cannot be used
 * to reset accounts.
 */
export function generateResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
