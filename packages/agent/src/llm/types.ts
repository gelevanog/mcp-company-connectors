export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface LlmTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: LlmTool[];
  maxTokens?: number;
  temperature?: number;
}

export interface Completion {
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
  /** The model that actually answered (OpenRouter may route to a fallback). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
}

export interface ChatModel {
  readonly label: string;
  /** Offline models skip the throttle, the cache and the ledger. */
  readonly isLocal: boolean;
  complete(request: CompletionRequest): Promise<Completion>;
}

export class LlmError extends Error {}
/** 429, 5xx, timeouts: worth retrying. */
export class RetryableLlmError extends LlmError {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}
/** The free-only guard or the call budget refused the request. Never retried. */
export class PolicyViolationError extends LlmError {}
export class BudgetExceededError extends PolicyViolationError {}
