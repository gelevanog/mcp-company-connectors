import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import {
  type Actor,
  type AnyToolSpec,
  type Db,
  META,
  ToolError,
  decodeCursor,
  defineTool,
  encodeCursor,
  hasScope,
  registerTools,
  resolveActor,
} from '@switchboard/core';
import * as z from 'zod/v4';

import { type KbDocument, KnowledgeBase, loadDocuments } from './docs.js';

export { Bm25Index, stem, tokenize } from './bm25.js';
export { KnowledgeBase, defaultKbDir, loadDocuments, type KbDocument } from './docs.js';

export interface KbServerOptions {
  db: Db;
  kb?: KnowledgeBase;
  fallbackActor?: Actor;
}

let shared: KnowledgeBase | undefined;
export function defaultKnowledgeBase(): KnowledgeBase {
  shared ??= new KnowledgeBase(loadDocuments());
  return shared;
}

function documentPayload(doc: KbDocument) {
  return { slug: doc.slug, title: doc.title, tags: doc.tags, updated: doc.updated, trust: doc.trust, uri: `kb://doc/${doc.slug}`, content: doc.content };
}

export function kbTools(kb: KnowledgeBase): AnyToolSpec[] {
  const search = defineTool({
    name: 'kb_search',
    title: 'Search the knowledge base',
    description: 'Keyword search (BM25) over Kestrel Cloud help articles and policies: SLAs, refunds, known issues, how-tos.',
    scope: 'kb:read',
    input: z.object({
      query: z.string().min(2).max(200),
      limit: z.number().int().min(1).max(10).default(5),
      cursor: z.string().optional(),
    }),
    output: z.object({
      results: z.array(z.object({ slug: z.string(), title: z.string(), score: z.number(), snippet: z.string(), tags: z.array(z.string()), trust: z.string(), uri: z.string() })),
      total: z.number(),
      next_cursor: z.string().nullable(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    untrustedFields: ['snippet'],
    async handler(args) {
      const offset = decodeCursor(args.cursor);
      const hits = kb.search(args.query);
      const page = hits.slice(offset, offset + args.limit);
      const results = page.map((hit) => ({
        slug: hit.doc.slug,
        title: hit.doc.title,
        score: hit.score,
        snippet: hit.snippet,
        tags: hit.doc.tags,
        trust: hit.doc.trust,
        uri: `kb://doc/${hit.doc.slug}`,
      }));
      return {
        data: { results, total: hits.length, next_cursor: offset + page.length < hits.length ? encodeCursor(offset + page.length) : null },
        untrusted: results.flatMap((result, index) => (result.trust === 'community' ? [`/results/${index}/snippet`] : [])),
      };
    },
  });

  const get = defineTool({
    name: 'kb_get_document',
    title: 'Read a knowledge-base article',
    description: 'The full Markdown of one article (also available as the resource kb://doc/{slug}).',
    scope: 'kb:read',
    input: z.object({ slug: z.string().regex(/^[a-z0-9-]{2,80}$/).describe('Article slug from kb_search') }),
    output: z.object({ slug: z.string(), title: z.string(), tags: z.array(z.string()), updated: z.string(), trust: z.string(), uri: z.string(), content: z.string() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    untrustedFields: ['content'],
    async handler(args) {
      const doc = kb.get(args.slug);
      if (!doc) throw new ToolError(`no article "${args.slug}"; use kb_search to find slugs`, 'not_found');
      return { data: documentPayload(doc), untrusted: doc.trust === 'community' ? ['/content'] : [] };
    },
  });
  return [search, get];
}

export const KB_INSTRUCTIONS =
  'Kestrel Cloud knowledge base: help articles, known issues and policies. Search with kb_search, read with kb_get_document ' +
  'or the kb://doc/{slug} resource. Articles marked trust=community were written by customers.';

export function createKbServer(options: KbServerOptions): McpServer {
  const kb = options.kb ?? defaultKnowledgeBase();
  const server = new McpServer({ name: 'switchboard-kb', title: 'Switchboard Knowledge Base', version: '0.1.0' }, { instructions: KB_INSTRUCTIONS });
  registerTools(server, kbTools(kb), { db: options.db, fallbackActor: options.fallbackActor, serverName: 'kb' });
  server.registerResource(
    'document',
    new ResourceTemplate('kb://doc/{slug}', {
      list: async (ctx) => {
        const actor = resolveActor(ctx, options.fallbackActor);
        if (!hasScope(actor, 'kb:read')) return { resources: [] };
        return {
          resources: kb.documents.map((doc) => ({ uri: `kb://doc/${doc.slug}`, name: doc.slug, title: doc.title, mimeType: 'text/markdown' })),
        };
      },
      complete: { slug: (value) => kb.documents.map((doc) => doc.slug).filter((slug) => slug.startsWith(value)).slice(0, 20) },
    }),
    { title: 'Knowledge-base article', description: 'One help article as Markdown', mimeType: 'text/markdown', _meta: { [META.scope]: 'kb:read' } },
    async (uri, variables, ctx) => {
      const actor = resolveActor(ctx, options.fallbackActor);
      if (!hasScope(actor, 'kb:read')) throw new ToolError('insufficient scope: kb:read');
      const doc = kb.get(String(variables.slug ?? ''));
      if (!doc) throw new ToolError(`no article ${String(variables.slug)}`, 'not_found');
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc.content }],
        ...(doc.trust === 'community' && { _meta: { [META.untrustedPaths]: ['/contents/0/text'] } }),
      };
    },
  );
  return server;
}
