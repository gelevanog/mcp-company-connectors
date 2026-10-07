import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Bm25Index, tokenize } from './bm25.js';

export interface KbDocument {
  slug: string;
  title: string;
  tags: string[];
  updated: string;
  /** internal = written by Kestrel staff; community = contributed by customers (treated as untrusted). */
  trust: 'internal' | 'community';
  content: string;
  headings: string[];
}

/** data/kb in the repository, or KB_DIR. */
export function defaultKbDir(): string {
  if (process.env.KB_DIR) return process.env.KB_DIR;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'data', 'kb');
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, '..');
  }
  return resolve(process.cwd(), 'data', 'kb');
}

function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const index = line.indexOf(':');
    if (index > 0) meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n+/, '') };
}

export function loadDocuments(dir = defaultKbDir()): KbDocument[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const { meta, body } = parseFrontMatter(readFileSync(join(dir, name), 'utf8'));
      const headings = body.split('\n').filter((line) => /^#{1,3} /.test(line)).map((line) => line.replace(/^#+ /, ''));
      return {
        slug: name.replace(/\.md$/, ''),
        title: meta.title ?? headings[0] ?? name,
        tags: (meta.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
        updated: meta.updated ?? '',
        trust: meta.trust === 'community' ? 'community' : 'internal',
        content: body,
        headings,
      };
    });
}

export class KnowledgeBase {
  private readonly index = new Bm25Index<KbDocument>();
  readonly documents: KbDocument[];

  constructor(documents: KbDocument[]) {
    this.documents = documents;
    for (const doc of documents) {
      this.index.add(doc, [
        { text: doc.title, boost: 3 },
        { text: doc.tags.join(' '), boost: 2 },
        { text: doc.headings.join(' '), boost: 2 },
        { text: doc.content, boost: 1 },
      ]);
    }
  }

  get(slug: string): KbDocument | undefined {
    return this.documents.find((doc) => doc.slug === slug);
  }

  search(query: string): { doc: KbDocument; score: number; snippet: string }[] {
    const terms = new Set(tokenize(query));
    return this.index.search(query).map(({ item, score }) => ({ doc: item, score: Math.round(score * 100) / 100, snippet: snippet(item.content, terms) }));
  }
}

/** The paragraph with the most query terms, cut to about 280 characters. */
export function snippet(content: string, terms: Set<string>): string {
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p && !p.startsWith('#'));
  let best = paragraphs[0] ?? '';
  let bestScore = -1;
  for (const paragraph of paragraphs) {
    const score = tokenize(paragraph).filter((token) => terms.has(token)).length;
    if (score > bestScore) {
      best = paragraph;
      bestScore = score;
    }
  }
  return best.length > 280 ? `${best.slice(0, 277)}...` : best;
}
