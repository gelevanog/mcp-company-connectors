import { Client, type DiscoverResult, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Prompt, ResourceTemplateType, Tool } from '@modelcontextprotocol/server';
import { ALL_SCOPES, log } from '@switchboard/core';

import type { GatewayConfig, TenantConfig } from './config.js';
import type { KeyManager } from './keys.js';
import type { Session } from './policy.js';
import { issueDownstreamToken } from './tokens.js';

export interface UpstreamTool {
  upstream: string;
  tool: Tool;
}

export interface UpstreamCatalog {
  tools: Map<string, UpstreamTool>;
  templates: { upstream: string; template: ResourceTemplateType }[];
  prompts: Map<string, { upstream: string; prompt: Prompt }>;
  instructions: Record<string, string>;
  status: Record<string, { ok: boolean; error?: string; tools: number; refreshedAt: string }>;
}

type Actor = Pick<Session, 'userId' | 'role' | 'tenant' | 'scopes' | 'clientId'>;

/**
 * The gateway is an MCP client of every upstream server. It discovers each server once (server/discover), then
 * opens a zero-round-trip client per call with a downstream token minted for the acting user, so an upstream
 * always knows who is acting and never sees the user's own token.
 */
export class UpstreamRegistry {
  private discover = new Map<string, DiscoverResult>();
  private catalog: UpstreamCatalog = { tools: new Map(), templates: [], prompts: new Map(), instructions: {}, status: {} };
  private refreshing: Promise<void> | undefined;
  private refreshedAt = 0;

  constructor(
    private readonly tenantName: string,
    private readonly tenant: TenantConfig,
    private readonly keys: KeyManager,
    private readonly config: GatewayConfig,
  ) {}

  get current(): UpstreamCatalog {
    return this.catalog;
  }

  upstreamUrl(name: string): string {
    const upstream = this.tenant.upstreams[name];
    if (!upstream) throw new Error(`unknown upstream ${name}`);
    return upstream.url;
  }

  upstreamForUri(uri: string): string | undefined {
    const scheme = uri.split(':')[0] ?? '';
    return Object.entries(this.tenant.upstreams).find(([, upstream]) => upstream.uri_schemes.includes(scheme))?.[0];
  }

  /** Open a client to one upstream as `actor`; closed after `fn`. */
  async withClient<T>(name: string, actor: Actor, fn: (client: Client) => Promise<T>): Promise<T> {
    const url = this.upstreamUrl(name);
    const token = await issueDownstreamToken(this.keys, this.config, actor, url);
    const client = new Client({ name: 'switchboard-gateway', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } });
    const prior = this.discover.get(name);
    await client.connect(transport, prior ? { prior: { kind: 'modern', discover: prior } } : undefined);
    if (!prior) {
      const result = client.getDiscoverResult();
      if (result) this.discover.set(name, result);
    }
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private serviceActor(): Actor {
    return { userId: 'switchboard-gateway', role: 'service', tenant: this.tenantName, scopes: [...ALL_SCOPES], clientId: 'switchboard-gateway' };
  }

  /** Refresh the tool, template and prompt catalog (at most every `maxAgeMs`). */
  async refresh(maxAgeMs = 60_000): Promise<void> {
    if (Date.now() - this.refreshedAt < maxAgeMs && this.catalog.tools.size > 0) return;
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    await this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const next: UpstreamCatalog = { tools: new Map(), templates: [], prompts: new Map(), instructions: {}, status: {} };
    for (const name of Object.keys(this.tenant.upstreams)) {
      try {
        await this.withClient(name, this.serviceActor(), async (client) => {
          const caps = client.getServerCapabilities();
          const tools = caps?.tools ? (await client.listTools()).tools : [];
          for (const tool of tools) {
            if (next.tools.has(tool.name)) {
              log('gateway', 'duplicate tool name; keeping the first', { tool: tool.name, upstream: name });
              continue;
            }
            next.tools.set(tool.name, { upstream: name, tool });
          }
          if (caps?.resources) {
            const templates = (await client.listResourceTemplates()).resourceTemplates;
            next.templates.push(...templates.map((template) => ({ upstream: name, template })));
          }
          if (caps?.prompts) {
            for (const prompt of (await client.listPrompts()).prompts) next.prompts.set(prompt.name, { upstream: name, prompt });
          }
          const instructions = client.getInstructions();
          if (instructions) next.instructions[name] = instructions;
          next.status[name] = { ok: true, tools: tools.length, refreshedAt: new Date().toISOString() };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const previous = [...this.catalog.tools.values()].filter((entry) => entry.upstream === name);
        for (const entry of previous) next.tools.set(entry.tool.name, entry); // keep serving the last known catalog
        next.templates.push(...this.catalog.templates.filter((entry) => entry.upstream === name));
        for (const [key, value] of this.catalog.prompts) if (value.upstream === name) next.prompts.set(key, value);
        next.status[name] = { ok: false, error: message.slice(0, 200), tools: previous.length, refreshedAt: new Date().toISOString() };
        this.discover.delete(name);
        log('gateway', 'upstream unavailable', { upstream: name, error: message.slice(0, 200) });
      }
    }
    // Deterministic order (the spec asks for it; it also keeps prompt caches warm): by server, then name.
    const order = Object.keys(this.tenant.upstreams);
    next.tools = new Map(
      [...next.tools.entries()].sort(([a, x], [b, y]) => order.indexOf(x.upstream) - order.indexOf(y.upstream) || a.localeCompare(b)),
    );
    this.catalog = next;
    this.refreshedAt = Date.now();
  }
}
