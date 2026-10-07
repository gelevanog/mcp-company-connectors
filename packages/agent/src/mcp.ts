import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';

import type { LlmTool } from './llm/types.js';

export interface ElicitRequest {
  message: string;
  requestedSchema: Record<string, unknown> | undefined;
}

export type ElicitHandler = (request: ElicitRequest) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }>;

export interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: unknown;
  flags: string[];
  decision: string | undefined;
  upstream: string | undefined;
  latencyMs: number;
  confirmations: number;
  protocolError?: string;
}

export interface GatewayConnection {
  client: Client;
  tools: Tool[];
  instructions: string | undefined;
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; onProgress?: (message: string) => void }): Promise<ToolOutcome>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  url: string;
  token: string;
  clientName?: string;
  /** Answers confirmations (elicitation). Without one, the client declares no elicitation capability. */
  elicit?: ElicitHandler;
  headers?: Record<string, string>;
}

/** An MCP client (2026-07-28, falls back to 2025) connected to the Switchboard gateway with a bearer token. */
export async function connectGateway(options: ConnectOptions): Promise<GatewayConnection> {
  let confirmations = 0;
  const client = new Client(
    { name: options.clientName ?? 'switchboard-agent', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' }, capabilities: options.elicit ? { elicitation: { form: {} } } : {}, inputRequired: { maxRounds: 3 } },
  );
  if (options.elicit) {
    const handler = options.elicit;
    client.setRequestHandler('elicitation/create', async (request) => {
      confirmations += 1;
      const params = request.params as { message: string; requestedSchema?: Record<string, unknown> };
      return handler({ message: params.message, requestedSchema: params.requestedSchema });
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    authProvider: { token: async () => options.token },
    ...(options.headers && { requestInit: { headers: options.headers } }),
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  return {
    client,
    tools,
    instructions: client.getInstructions(),
    async callTool(name, args, callOptions) {
      const before = confirmations;
      const started = performance.now();
      try {
        const result = await client.callTool(
          { name, arguments: args },
          {
            timeout: 180_000,
            ...(callOptions?.signal && { signal: callOptions.signal }),
            ...(callOptions?.onProgress && { onprogress: (p: { progress: number; total?: number; message?: string }) => callOptions.onProgress?.(p.message ?? `${p.progress}/${p.total ?? '?'}`) }),
          },
        );
        const meta = (result._meta ?? {}) as Record<string, unknown>;
        const content = (result.content ?? []) as { type: string; text?: string }[];
        return {
          isError: result.isError === true,
          text: content.map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`)).join('\n'),
          structured: result.structuredContent,
          flags: Array.isArray(meta['io.switchboard/flags']) ? (meta['io.switchboard/flags'] as string[]) : [],
          decision: typeof meta['io.switchboard/decision'] === 'string' ? (meta['io.switchboard/decision'] as string) : undefined,
          upstream: typeof meta['io.switchboard/upstream'] === 'string' ? (meta['io.switchboard/upstream'] as string) : undefined,
          latencyMs: Math.round(performance.now() - started),
          confirmations: confirmations - before,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, text: `Error: ${message}`, structured: undefined, flags: [], decision: 'protocol_error', upstream: undefined, latencyMs: Math.round(performance.now() - started), confirmations: confirmations - before, protocolError: message };
      }
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

function cleanSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const { $schema: _schema, ...rest } = schema as Record<string, unknown>;
  return rest;
}

/** MCP tools as OpenAI-style function tools for the model. */
export function toLlmTools(tools: Tool[]): LlmTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: `${tool.title ? `${tool.title}. ` : ''}${tool.description ?? ''}`.slice(0, 1000),
      parameters: cleanSchema(tool.inputSchema),
    },
  }));
}
