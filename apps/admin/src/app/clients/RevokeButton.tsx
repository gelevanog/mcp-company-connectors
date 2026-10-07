'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function RevokeButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/admin/grants/${id}/revoke`, { method: 'POST', body: '{}' });
        router.refresh();
      }}
      className="rounded-md border border-rule px-2 py-0.5 text-[11.5px] text-rose-700 hover:bg-rose-50"
    >
      Revoke
    </button>
  );
}
