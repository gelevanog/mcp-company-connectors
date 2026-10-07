import { SCOPES } from '@switchboard/core';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

const STYLE = `
:root { --bg:#f4f1ea; --panel:#fffdf8; --ink:#1d2433; --muted:#5d6577; --line:#d9d2c3; --accent:#1f6f5c; --accent-ink:#fff; --warn:#9a4b00; --chip:#ece6d8; }
@media (prefers-color-scheme: dark) { :root { --bg:#14181f; --panel:#1b2029; --ink:#e7e9ee; --muted:#9aa3b5; --line:#2d3442; --accent:#3fb28f; --accent-ink:#0d1512; --warn:#f0a35e; --chip:#252c38; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:560px; margin:48px auto; padding:0 16px; }
.brand { display:flex; align-items:center; gap:10px; font-weight:650; letter-spacing:.02em; margin-bottom:18px; }
.brand svg { width:26px; height:26px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:24px; }
h1 { font-size:20px; margin:0 0 6px; }
p.lead { color:var(--muted); margin:0 0 18px; }
.client { display:flex; justify-content:space-between; gap:12px; padding:12px 14px; background:var(--chip); border-radius:10px; margin-bottom:18px; font-size:14px; }
.client code { font-size:12px; word-break:break-all; }
fieldset { border:0; padding:0; margin:0 0 16px; }
legend { font-weight:600; margin-bottom:8px; }
label.user { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; margin-bottom:8px; cursor:pointer; }
label.user:has(input:checked) { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
.role { margin-left:auto; font-size:12px; padding:2px 8px; border-radius:999px; background:var(--chip); color:var(--muted); }
ul.scopes { margin:0 0 18px; padding:0; list-style:none; font-size:14px; }
ul.scopes li { padding:6px 0; border-bottom:1px dashed var(--line); display:flex; gap:10px; }
ul.scopes code { min-width:128px; color:var(--accent); }
.note { font-size:13px; color:var(--warn); margin:0 0 16px; }
.actions { display:flex; gap:10px; justify-content:flex-end; }
button { font:inherit; border-radius:10px; padding:10px 16px; border:1px solid var(--line); background:transparent; color:var(--ink); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:600; }
.footer { font-size:12px; color:var(--muted); margin-top:14px; text-align:center; }
`;

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="7" fill="currentColor" opacity=".12"/><circle cx="10" cy="11" r="2.6" fill="currentColor"/><circle cx="22" cy="11" r="2.6" fill="currentColor"/><circle cx="10" cy="21" r="2.6" fill="currentColor"/><circle cx="22" cy="21" r="2.6" fill="currentColor"/><path d="M10 11 C16 11 16 21 22 21 M10 21 C16 21 16 11 22 11" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><div class="brand">${LOGO}<span>Switchboard</span></div>${body}</main></body></html>`;
}

export interface ConsentPageInput {
  clientName: string;
  clientId: string;
  clientKind: string;
  redirectHost: string;
  resource: string;
  scopes: string[];
  users: { id: string; name: string; role: string; title: string }[];
  request: string;
  signature: string;
  demoLogin: boolean;
}

export function consentPage(input: ConsentPageInput): string {
  const scopeList = (input.scopes.length > 0 ? input.scopes : ['(everything your role allows)'])
    .map((scope) => `<li><code>${escapeHtml(scope)}</code><span>${escapeHtml(SCOPES[scope as keyof typeof SCOPES] ?? '')}</span></li>`)
    .join('');
  const users = input.users
    .map(
      (user, index) =>
        `<label class="user"><input type="radio" name="user" value="${escapeHtml(user.id)}" ${index === 0 ? 'checked' : ''}><span><strong>${escapeHtml(user.name)}</strong><br><small>${escapeHtml(user.title)}</small></span><span class="role">${escapeHtml(user.role)}</span></label>`,
    )
    .join('');
  const signIn = input.demoLogin
    ? `<fieldset><legend>Sign in as (demo users)</legend>${users}</fieldset>`
    : `<p class="note">Interactive sign-in is delegated to your identity provider, which is not configured in this deployment.</p>`;
  return layout(
    'Authorize access',
    `<div class="card">
      <h1>Connect an AI assistant</h1>
      <p class="lead">An application wants to use Switchboard on your behalf. It will only see the tools your role allows, and every change still needs your confirmation.</p>
      <div class="client"><div><strong>${escapeHtml(input.clientName)}</strong><br><code>${escapeHtml(input.clientId)}</code></div><div>returns to<br><code>${escapeHtml(input.redirectHost)}</code></div></div>
      ${input.clientKind === 'dcr' ? '<p class="note">This client registered itself dynamically; Switchboard cannot verify who publishes it. Continue only if you started this connection.</p>' : ''}
      <form method="post" action="/oauth/authorize/decision">
        ${signIn}
        <fieldset><legend>Requested access</legend><ul class="scopes">${scopeList}</ul></fieldset>
        <input type="hidden" name="request" value="${escapeHtml(input.request)}">
        <input type="hidden" name="signature" value="${escapeHtml(input.signature)}">
        <div class="actions"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="approve" ${input.demoLogin ? '' : 'disabled'}>Allow access</button></div>
      </form>
    </div>
    <p class="footer">Tokens are issued for <code>${escapeHtml(input.resource)}</code> only.</p>`,
  );
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<div class="card"><h1>${escapeHtml(title)}</h1><p class="lead">${escapeHtml(message)}</p></div>`);
}
