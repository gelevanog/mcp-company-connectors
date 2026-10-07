/** A small BM25 index (Robertson/Sparck Jones, k1 = 1.2, b = 0.75) with field boosts. No embeddings, no model. */

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from has have how i if in into is it its of on or our so that the their them then there these this to was we what when where which who why will with you your'.split(' '),
);

export function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'edly', 'ies', 'ied', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      const base = token.slice(0, -suffix.length);
      return suffix === 'ies' || suffix === 'ied' ? `${base}y` : base;
    }
  }
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

export interface IndexedField {
  text: string;
  boost: number;
}

export interface SearchHit<T> {
  item: T;
  score: number;
}

export class Bm25Index<T> {
  private readonly docs: { item: T; tf: Map<string, number>; length: number }[] = [];
  private readonly df = new Map<string, number>();
  private avgLength = 0;

  constructor(private readonly k1 = 1.2, private readonly b = 0.75) {}

  add(item: T, fields: IndexedField[]): void {
    const tf = new Map<string, number>();
    let length = 0;
    for (const field of fields) {
      for (const token of tokenize(field.text)) {
        tf.set(token, (tf.get(token) ?? 0) + field.boost);
        length += field.boost;
      }
    }
    for (const token of tf.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1);
    this.docs.push({ item, tf, length });
    this.avgLength = this.docs.reduce((sum, doc) => sum + doc.length, 0) / this.docs.length;
  }

  get size(): number {
    return this.docs.length;
  }

  search(query: string): SearchHit<T>[] {
    const terms = [...new Set(tokenize(query))];
    const n = this.docs.length;
    const hits: SearchHit<T>[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        const freq = doc.tf.get(term);
        if (!freq) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * freq * (this.k1 + 1)) / (freq + this.k1 * (1 - this.b + (this.b * doc.length) / this.avgLength));
      }
      if (score > 0) hits.push({ item: doc.item, score });
    }
    return hits.sort((a, b) => b.score - a.score);
  }
}
