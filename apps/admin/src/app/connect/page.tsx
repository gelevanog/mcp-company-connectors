import { Card, PageHeader } from '@/components/ui';
import { GATEWAY_PUBLIC_URL } from '@/lib/config';

const block = 'mt-2 overflow-x-auto rounded-lg bg-console p-3 font-mono text-[12px] leading-relaxed text-slate-100';

export default function ConnectPage() {
  const mcp = `${GATEWAY_PUBLIC_URL}/mcp`;
  return (
    <>
      <PageHeader
        title="Connect a client"
        subtitle={`Every client connects to one URL, ${mcp}. The gateway answers with a 401 and its OAuth metadata; the client registers itself, opens the sign-in page, and receives a token for this user only. The README lists what was tested.`}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Claude Code (remote, OAuth)">
          <pre className={block}>{`claude mcp add --transport http switchboard ${mcp}
# then in Claude Code: /mcp  → switchboard → Authenticate`}</pre>
        </Card>
        <Card title="Claude Desktop / claude.ai (custom connector)">
          <p className="text-[13px] text-slate-600">Settings → Connectors → Add custom connector → URL <code className="font-mono">{mcp}</code>. Needs a URL Anthropic&apos;s servers can reach (a public HTTPS deployment, not localhost).</p>
        </Card>
        <Card title="Claude Desktop (local, stdio)">
          <pre className={block}>{`{
  "mcpServers": {
    "switchboard": {
      "command": "node",
      "args": ["/path/to/mcp-company-connectors/packages/cli/dist/main.js", "gateway", "--stdio"],
      "env": {
        "DATABASE_URL": "postgresql://switchboard:switchboard@127.0.0.1:55480/switchboard",
        "SWITCHBOARD_TOKEN": "<output of: switchboard token --user sam>"
      }
    }
  }
}`}</pre>
        </Card>
        <Card title="Cursor (.cursor/mcp.json)">
          <pre className={block}>{`{
  "mcpServers": {
    "switchboard": { "url": "${mcp}" }
  }
}`}</pre>
        </Card>
        <Card title="VS Code (.vscode/mcp.json)">
          <pre className={block}>{`{
  "servers": {
    "switchboard": { "type": "http", "url": "${mcp}" }
  }
}`}</pre>
        </Card>
        <Card title="ChatGPT (developer mode connector)">
          <p className="text-[13px] text-slate-600">Settings → Apps and connectors → Advanced → Developer mode, then Create connector with the MCP URL <code className="font-mono">{mcp}</code> and OAuth. Like claude.ai, ChatGPT reaches the server from the internet, so it needs a public HTTPS deployment.</p>
        </Card>
        <Card title="MCP Inspector">
          <pre className={block}>{`npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP · URL: ${mcp} · Authentication: OAuth`}</pre>
        </Card>
        <Card title="Your own agent (TypeScript SDK)">
          <pre className={block}>{`import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const client = new Client({ name: 'my-agent', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: { form: {} } } });
client.setRequestHandler('elicitation/create', askTheUser);
await client.connect(new StreamableHTTPClientTransport(new URL('${mcp}'),
  { authProvider: myOAuthProvider }));`}</pre>
        </Card>
      </div>
    </>
  );
}
