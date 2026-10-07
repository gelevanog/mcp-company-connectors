import { Playground } from '@/components/Playground';
import { PageHeader } from '@/components/ui';
import { adminFetch } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function PlaygroundPage() {
  const [presets, users] = await Promise.all([
    adminFetch<{ presets: { id: string; user: string; prompt: string; title?: string }[]; models: { provider: string; id: string; label: string }[] }>('/playground/presets'),
    adminFetch<{ users: { id: string; name: string; role: string; title: string }[] }>('/users'),
  ]);
  return (
    <>
      <PageHeader
        title="Playground"
        subtitle="Run an agent as any demo user. It connects to the gateway's /mcp endpoint like any other client, sees only that role's tools, and asks you before changing anything. The model runs server-side; its key never reaches the browser."
      />
      <Playground presets={presets.presets} models={presets.models} users={users.users} />
    </>
  );
}
