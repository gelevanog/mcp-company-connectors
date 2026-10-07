/** An error whose message is safe to show to the model and the user (becomes an `isError` tool result). */
export class ToolError extends Error {
  constructor(message: string, readonly code = 'tool_error') {
    super(message);
    this.name = 'ToolError';
  }
}
