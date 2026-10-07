import { describe, expect, it } from 'vitest';

import { generateDemoData } from '../src/demo/data.js';
import { argsHash } from '../src/idempotency.js';
import { canonicalJson } from '../src/hash.js';

describe('demo data', () => {
  it('is deterministic', () => {
    expect(JSON.stringify(generateDemoData())).toBe(JSON.stringify(generateDemoData()));
  });

  it('has unique ids and the story records the evaluation relies on', () => {
    const data = generateDemoData();
    for (const list of [data.companies, data.contacts, data.deals, data.notes, data.tickets, data.comments, data.events, data.emails]) {
      const ids = list.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(data.tickets.filter((t) => t.companyId === 'C-1001' && ['open', 'pending'].includes(t.status)).map((t) => t.id).sort()).toEqual(['T-1001', 'T-1002', 'T-1003', 'T-1005']);
    expect(data.deals.find((d) => d.id === 'D-3005')?.stage).toBe('proposal');
    expect(data.employees.filter((e) => e.canSignIn).map((e) => e.role).sort()).toEqual(['admin', 'analyst', 'sales', 'sales', 'support', 'support']);
  });

  it('keeps every timestamp before the demo date', () => {
    const data = generateDemoData();
    const limit = Date.parse('2026-10-01T00:00:00Z');
    for (const ticket of data.tickets) expect(Date.parse(ticket.createdAt)).toBeLessThan(limit);
    for (const deal of data.deals) expect(Date.parse(deal.stageChangedAt)).toBeLessThan(limit);
  });
});

describe('hashing', () => {
  it('ignores key order and control arguments', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(argsHash({ a: 1, idempotency_key: 'x', confirmation_token: 'y' })).toBe(argsHash({ a: 1 }));
  });
});
