import { ensureFreeModels, ensureServedFree, requireFreeModels } from './guards.js';
import { type ChatModel, type Completion, type CompletionRequest, LlmError, RetryableLlmError } from './types.js';

export interface OpenAiCompatibleOptions {
  model: string;
  fallbackModels?: string[];
  apiKey: string;
  baseUrl?: string;
  /** OpenRouter only: the free-only guard (default on). */
  requireFree?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | undefined;
  timeoutMs?: number;
  provider?: 'openrouter' | 'openai_compatible';
  fetch?: typeof fetch;
}

/** Chat completions with tool calling over OpenRouter (or any OpenAI-compatible endpoint). */
export class OpenAiCompatibleModel implements ChatModel {
  readonly isLocal = false;
  readonly label: string;
  private readonly requireFree: boolean;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    const provider = options.provider ?? 'openrouter';
    this.requireFree = provider === 'openrouter' && (options.requireFree ?? requireFreeModels());
    if (this.requireFree) ensureFreeModels([options.model, ...(options.fallbackModels ?? [])]);
    if (!options.apiKey) throw new LlmError(`${provider}: no API key (set OPENROUTER_API_KEY)`);
    this.label = `${provider}/${options.model}`;
  }

  get model(): string {
    return this.options.model;
  }

  withModel(model: string, fallbackModels: string[] = []): OpenAiCompatibleModel {
    return new OpenAiCompatibleModel({ ...this.options, model, fallbackModels });
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 2048,
      ...(request.tools.length > 0 && { tools: request.tools, tool_choice: 'auto' }),
      ...(this.options.fallbackModels && this.options.fallbackModels.length > 0 && { models: [this.options.model, ...this.options.fallbackModels] }),
      ...(this.options.reasoningEffort && { reasoning: { effort: this.options.reasoningEffort } }),
    };
    if (this.requireFree) ensureFreeModels([String(body.model), ...((body.models as string[] | undefined) ?? [])]);
    const doFetch = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.options.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'http-referer': 'https://github.com/gelevanog/mcp-company-connectors',
          'x-title': 'Switchboard evaluation',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
      });
    } catch (error) {
      throw new RetryableLlmError(`network error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    if (response.status === 429 || response.status >= 500 || response.status === 408) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '');
      throw new RetryableLlmError(`upstream ${response.status}: ${text.slice(0, 200)}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    if (!response.ok) throw new LlmError(`upstream ${response.status}: ${text.slice(0, 300)}`);
    let data: {
      model?: string;
      error?: { code?: number; message?: string };
      choices?: { message?: { content?: string | null; tool_calls?: Completion['message']['tool_calls'] }; finish_reason?: string; error?: { message?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new RetryableLlmError(`unparseable response: ${text.slice(0, 120)}`);
    }
    if (data.error) {
      const code = data.error.code ?? 0;
      if (code === 429 || code >= 500) throw new RetryableLlmError(`upstream ${code}: ${data.error.message ?? ''}`);
      throw new LlmError(`upstream ${code}: ${data.error.message ?? ''}`);
    }
    if (this.requireFree) ensureServedFree(data.model);
    const choice = data.choices?.[0];
    if (choice?.error) throw new RetryableLlmError(`choice error: ${choice.error.message ?? ''}`);
    const message = choice?.message;
    if (!message || (!message.content && (!message.tool_calls || message.tool_calls.length === 0))) {
      throw new RetryableLlmError(`empty answer (finish_reason ${choice?.finish_reason ?? 'none'})`);
    }
    return {
      message: {
        role: 'assistant',
        content: message.content ?? null,
        ...(message.tool_calls && message.tool_calls.length > 0 && { tool_calls: message.tool_calls.map((call, index) => ({ ...call, id: call.id || `call_${index}`, type: 'function' as const })) }),
      },
      model: data.model ?? this.options.model,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cached: false,
    };
  }
}
