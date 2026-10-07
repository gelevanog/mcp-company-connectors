/**
 * OAuth scopes. Each tool declares the one scope it needs (in its `_meta`), each role is granted a set of
 * scopes, and a token carries the intersection of what the client asked for and what the role allows.
 */
export const SCOPES = {
  'crm:read': 'Read companies and contacts',
  'crm:deals': 'Read deals, notes and the pipeline',
  'contacts:pii': "See customer contacts' email addresses and phone numbers (personal data)",
  'crm:write': 'Update deal stages and add notes',
  'helpdesk:read': 'Read tickets and comments',
  'helpdesk:write': 'Comment on, update, assign and create tickets',
  'analytics:query': 'Run read-only SQL and saved reports',
  'kb:read': 'Search and read knowledge-base articles',
  'calendar:read': 'Read calendars and availability',
  'calendar:write': 'Create calendar events',
  'email:draft': 'Write email drafts',
  'email:send': 'Submit emails to the outbox (an admin approves delivery)',
  admin: 'Use the Switchboard admin API',
} as const;

export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

/** Keys Switchboard puts into a tool's or a result's `_meta`. */
export const META = {
  scope: 'io.switchboard/scope',
  write: 'io.switchboard/write',
  untrustedFields: 'io.switchboard/untrusted-fields',
  untrustedPaths: 'io.switchboard/untrusted',
  server: 'io.switchboard/server',
} as const;
