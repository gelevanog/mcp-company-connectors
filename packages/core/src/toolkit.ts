import type { CallToolResult, McpServer, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { Actor } from './actor.js';
import { actorFromAuthInfo, hasScope } from './actor.js';
import type { Db } from './db.js';
import { ToolError } from './errors.js';
import type { Scope } from './scopes.js';
import { META } from './scopes.js';

export interface ToolContext {
  actor: Actor;
  db: Db;
  signal: AbortSignal;
  /** Sends notifications/progress when the client asked for progress (a progressToken in _meta). */
  progress: (progress: number, total?: number, message?: string) => Promise<void>;
}

export interface ToolOutput<T> {
  data: T;
  /** Human-readable rendering; defaults to the JSON of `data`. */
  text?: string;
  /** JSON pointers into `data` whose strings were written by customers or third parties. */
  untrusted?: string[];
}

export interface ToolSpec<I extends z.ZodObject, O extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: I;
  output: O;
  scope: Scope;
  write?: boolean;
  annotations: ToolAnnotations;
  /** Field names that carry untrusted text, for documentation and the gateway's tool listing. */
  untrustedFields?: string[];
  handler: (args: z.infer<I>, ctx: ToolContext) => Promise<ToolOutput<z.infer<O>>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolSpec = ToolSpec<any, any>;

export function defineTool<I extends z.ZodObject, O extends z.ZodType>(spec: ToolSpec<I, O>): ToolSpec<I, O> {
  return spec;
}

/** Optional on every write tool: the same key with the same arguments never applies a change twice. */
export const idempotencyKey = z
  .string()
  .min(8)
  .max(200)
  .optional()
  .describe('Optional idempotency key. Retrying with the same key and arguments returns the first result instead of writing again.');

export interface RegisterOptions {
  db: Db;
  /** Used when the request carries no gateway token (stdio, or HTTP with auth off on loopback). */
  fallbackActor: Actor | undefined;
  serverName: string;
}

export function resolveActor(ctx: ServerContext, fallback: Actor | undefined): Actor {
  const actor = actorFromAuthInfo(ctx.http?.authInfo) ?? fallback;
  if (!actor) throw new ToolError('no authenticated user for this request', 'unauthenticated');
  return actor;
}

export function progressSender(ctx: ServerContext): ToolContext['progress'] {
  const token = ctx.mcpReq._meta?.progressToken;
  let last = 0;
  return async (progress, total, message) => {
    if (token === undefined) return;
    const value = Math.max(progress, last + 1e-6);
    last = value;
    await ctx.mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken: token, progress: value, ...(total !== undefined && { total }), ...(message !== undefined && { message }) },
    });
  };
}

export function registerTools(server: McpServer, specs: AnyToolSpec[], options: RegisterOptions): void {
  for (const spec of specs) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input as z.ZodObject,
        outputSchema: spec.output as z.ZodType,
        annotations: spec.annotations,
        _meta: {
          [META.scope]: spec.scope,
          [META.write]: spec.write === true,
          [META.server]: options.serverName,
          ...(spec.untrustedFields && { [META.untrustedFields]: spec.untrustedFields }),
        },
      },
      async (args: unknown, ctx: ServerContext): Promise<CallToolResult> => {
        try {
          const actor = resolveActor(ctx, options.fallbackActor);
          if (!hasScope(actor, spec.scope)) {
            throw new ToolError(`insufficient scope: ${spec.name} needs ${spec.scope}`, 'insufficient_scope');
          }
          const output = await spec.handler(args, {
            actor,
            db: options.db,
            signal: ctx.mcpReq.signal,
            progress: progressSender(ctx),
          });
          return {
            content: [{ type: 'text', text: output.text ?? JSON.stringify(output.data, null, 2) }],
            structuredContent: output.data as Record<string, unknown>,
            ...(output.untrusted && output.untrusted.length > 0 && { _meta: { [META.untrustedPaths]: output.untrusted } }),
          };
        } catch (error) {
          if (error instanceof ToolError) {
            return { content: [{ type: 'text', text: error.message }], isError: true, _meta: { 'io.switchboard/error': error.code } };
          }
          if (error instanceof z.ZodError) {
            return { content: [{ type: 'text', text: `invalid arguments: ${error.message}` }], isError: true };
          }
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[${options.serverName}] ${spec.name} failed: ${message}`);
          return { content: [{ type: 'text', text: `${spec.name} failed: internal error` }], isError: true };
        }
      },
    );
  }
}

/** Escape LIKE wildcards in user-supplied search text. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * Every word of the query must appear in at least one of the columns (case-insensitive), so "VAT invoice"
 * finds "Invoice 2026-09 shows the wrong VAT rate". Pushes the parameters and returns the SQL condition.
 */
export function wordsMatch(columns: string[], query: string, params: unknown[]): string {
  const words = query
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}@]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((word) => word.length > 0)
    .slice(0, 8);
  if (words.length === 0) return 'TRUE';
  return words
    .map((word) => {
      params.push(likePattern(word));
      const placeholder = `$${params.length}`;
      return `(${columns.map((column) => `${column} ILIKE ${placeholder}`).join(' OR ')})`;
    })
    .join(' AND ');
}

/** Opaque, tamper-evident-enough pagination cursor for list tools (an offset; never trusted beyond bounds). */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0 && parsed.o < 1_000_000) return parsed.o;
  } catch {
    // fall through
  }
  throw new ToolError('invalid cursor');
}
