/** Structured logs on stderr (stdout belongs to the MCP stdio transport). Never log tokens or arguments. */
export function log(component: string, message: string, fields: Record<string, unknown> = {}): void {
  if (process.env.SWITCHBOARD_LOG === 'silent') return;
  const line = { ts: new Date().toISOString(), component, message, ...fields };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}
