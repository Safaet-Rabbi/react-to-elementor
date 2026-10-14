import { ResetPasswordCard } from '@/features/auth/ResetPasswordCard';

export default function ResetPasswordPage({ searchParams }: { searchParams: { token?: string } }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-100 to-brand-50 px-4 py-10">
      <ResetPasswordCard token={searchParams.token ?? ''} />
    </main>
  );
}
