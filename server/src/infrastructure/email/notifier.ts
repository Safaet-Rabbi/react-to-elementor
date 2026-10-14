/**
 * Password-reset delivery abstraction.
 *
 * There is no email provider wired up in this deployment yet, so the default
 * transport records the reset link on the server log. Swap `deliverPasswordReset`
 * for a real provider (SMTP/SES/etc.) before enabling self-service resets in
 * production. The plaintext token is intentionally never persisted; only its
 * SHA-256 hash is stored, and it is handed to the transport for delivery.
 */
export interface PasswordResetDelivery {
  email: string;
  token: string;
  expiresAt: Date;
}

export function passwordResetLink(token: string): string {
  const base = process.env.WEB_ORIGIN?.replace(/\/+$/, "") ?? "http://localhost:3000";
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function deliverPasswordReset(delivery: PasswordResetDelivery): Promise<void> {
  // TODO: replace with a transactional email provider in production.
  console.info(
    `[password-reset] Reset requested for ${delivery.email}. ` +
      `Expires at ${delivery.expiresAt.toISOString()}. Link: ${passwordResetLink(delivery.token)}`,
  );
}
