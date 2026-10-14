'use client';

import Link from 'next/link';
import { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/error-handling';

export function ForgotPasswordCard() {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await apiClient.requestPasswordReset(email);
      setSubmitted(true);
      // The token is only returned by the API outside production (no mail
      // provider is configured), so it lets the reset flow be completed locally.
      setResetToken(response.resetToken ?? null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="card mx-auto w-full max-w-md">
      <div className="mb-6 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-brand-600">Account recovery</p>
        <h1 className="mt-3 text-3xl font-bold text-slate-900">Forgot password</h1>
      </div>

      {submitted ? (
        <div className="space-y-4" role="status">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            If an account exists for {email}, a password reset link has been sent. Check your inbox and
            follow the link to choose a new password.
          </div>
          {resetToken ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <p className="font-semibold">Development only</p>
              <p className="mt-1">No email provider is configured, so use the link below to reset your password:</p>
              <Link
                href={`/reset-password?token=${encodeURIComponent(resetToken)}`}
                className="mt-2 inline-block font-semibold text-brand-600 hover:text-brand-700"
              >
                Continue to reset password
              </Link>
            </div>
          ) : null}
          <Link href="/login" className="btn-secondary w-full">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <p className="text-sm text-slate-600">
            Enter the email address associated with your account and we&apos;ll send you a link to reset your password.
          </p>
          <div>
            <label className="label" htmlFor="email">
              Email address
            </label>
            <input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>

          {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}

          <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Please wait...' : 'Send reset link'}
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-slate-600">
        Remembered your password?{' '}
        <Link href="/login" className="font-semibold text-brand-600 hover:text-brand-700">
          Sign in
        </Link>
      </p>
    </div>
  );
}
