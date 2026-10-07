import { describe, expect, it } from 'vitest';

import { redirectMatches, redirectUriAllowed } from '../src/clients.js';
import { loadPolicy } from '../src/config.js';
import { grantScopes, matches, roleScopes } from '../src/policy.js';

describe('policy', () => {
  const tenant = loadPolicy().kestrel;
  if (!tenant) throw new Error('kestrel missing');

  it('matches tool patterns', () => {
    expect(matches('crm_*', 'crm_get_deal')).toBe(true);
    expect(matches('crm_*', 'helpdesk_get_ticket')).toBe(false);
    expect(matches('*', 'anything')).toBe(true);
    expect(matches('kb_search', 'kb_search')).toBe(true);
  });

  it('grants the intersection of requested and role scopes', () => {
    const known = ['crm:read', 'crm:deals', 'crm:write', 'helpdesk:read', 'helpdesk:write'];
    expect(grantScopes([], roleScopes(tenant, 'support'), known)).toEqual(['crm:read', 'helpdesk:read', 'helpdesk:write']);
    expect(grantScopes(['crm:deals', 'helpdesk:write'], roleScopes(tenant, 'support'), known)).toEqual(['helpdesk:write']);
    expect(grantScopes(['crm:write'], roleScopes(tenant, 'analyst'), known)).toEqual([]);
    expect(grantScopes([], roleScopes(tenant, 'admin'), known)).toEqual(known);
  });

  it('keeps analysts free of write scopes', () => {
    const scopes = roleScopes(tenant, 'analyst');
    expect(scopes).not.toBe('*');
    expect((scopes as string[]).filter((s) => s.endsWith(':write') || s.startsWith('email'))).toEqual([]);
  });

  it('validates redirect URIs', () => {
    const config = { allowHttpsRedirects: true };
    expect(redirectUriAllowed('http://127.0.0.1:33418/callback', config)).toBe(true);
    expect(redirectUriAllowed('http://localhost/cb', config)).toBe(true);
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback', config)).toBe(true);
    expect(redirectUriAllowed('cursor://anysphere.cursor-mcp/oauth/callback', config)).toBe(true);
    expect(redirectUriAllowed('http://evil.example/cb', config)).toBe(false);
    expect(redirectUriAllowed('javascript:alert(1)', config)).toBe(false);
    expect(redirectUriAllowed('https://x.example/cb#frag', config)).toBe(false);
    expect(redirectUriAllowed('https://x.example/cb', { allowHttpsRedirects: false })).toBe(false);
  });

  it('matches loopback redirects on any port, everything else exactly', () => {
    expect(redirectMatches(['http://127.0.0.1/callback'], 'http://127.0.0.1:51234/callback')).toBe(true);
    expect(redirectMatches(['http://127.0.0.1/callback'], 'http://127.0.0.1:51234/other')).toBe(false);
    expect(redirectMatches(['https://a.example/cb'], 'https://a.example/cb')).toBe(true);
    expect(redirectMatches(['https://a.example/cb'], 'https://a.example/cb2')).toBe(false);
  });
});
