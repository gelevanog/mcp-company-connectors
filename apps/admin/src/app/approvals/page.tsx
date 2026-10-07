import { Approvals, type ConfirmationApproval, type EmailApproval } from '@/components/Approvals';
import { PageHeader } from '@/components/ui';
import { adminFetch } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const data = await adminFetch<{ emails: EmailApproval[]; confirmations: ConfirmationApproval[] }>('/approvals');
  return (
    <>
      <PageHeader title="Approvals" subtitle="Changes that wait for a person. Every decision here is written to the audit log." />
      <Approvals emails={data.emails} confirmations={data.confirmations} />
    </>
  );
}
