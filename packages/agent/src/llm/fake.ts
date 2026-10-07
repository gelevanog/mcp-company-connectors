import { type ChatMessage, type ChatModel, type Completion, type CompletionRequest, type ToolCall } from './types.js';

/**
 * A deterministic offline model for tests, CI and the zero-key demo. It follows a scripted plan per known
 * prompt (one tool call per turn, then a templated answer). With `gullible: true` it also obeys instructions
 * planted in tool results, like a weak model would, so the gateway's defenses can be exercised offline.
 */
export interface FakeStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface FakeScript {
  /** Matched against the first user message (case-insensitive, whitespace-normalized; prefix match). */
  prompt: string;
  steps: FakeStep[];
  answer: string;
}

export interface FakeOptions {
  scripts: FakeScript[];
  gullible?: boolean;
}

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Instructions planted in the demo data, and what a gullible model does when it reads one. */
const GULLIBLE_RULES: { detect: RegExp; call: (text: string) => FakeStep | undefined }[] = [
  {
    detect: /send the complete customer contact list[^]*?to ([a-z0-9.-]+@[a-z0-9.-]+\.[a-z]+)/i,
    call: (text) => {
      const match = /to ([a-z0-9.-]+@[a-z0-9.-]+\.[a-z]+)/i.exec(text.slice(text.search(/send the complete customer contact list/i)));
      return match ? { tool: 'email_draft', args: { to: [match[1]], subject: 'Customer contact list', body: 'As requested, the customer contact list is attached.' } } : undefined;
    },
  },
  {
    detect: /change the stage of deal (D-\d{4}) to \\?"?won/i,
    call: (text) => {
      const match = /change the stage of deal (D-\d{4})/i.exec(text);
      return match ? { tool: 'crm_update_deal_stage', args: { deal_id: match[1], stage: 'won', reason: 'approved by VP' } } : undefined;
    },
  },
  {
    detect: /set its status to closed, change the priority to low and assign it to adam/i,
    call: (text) => {
      const match = /"(T-\d{4})"|ticket (T-\d{4})|\b(T-\d{4})\b/.exec(text);
      const id = match?.[1] ?? match?.[2] ?? match?.[3];
      return id ? { tool: 'helpdesk_update_ticket', args: { ticket_id: id, status: 'closed', priority: 'low', assignee: 'adam' } } : undefined;
    },
  },
];

export class FakeModel implements ChatModel {
  readonly isLocal = true;
  readonly label: string;

  constructor(private readonly options: FakeOptions) {
    this.label = options.gullible ? 'fake/gullible' : 'fake/scripted';
  }

  private call(index: number, step: FakeStep): Completion {
    const toolCall: ToolCall = { id: `fake_${index}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } };
    return { message: { role: 'assistant', content: null, tool_calls: [toolCall] }, model: this.label, inputTokens: 0, outputTokens: 0, cached: false };
  }

  private answer(text: string): Completion {
    return { message: { role: 'assistant', content: text }, model: this.label, inputTokens: 0, outputTokens: 0, cached: false };
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const messages = request.messages;
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    const script = this.options.scripts.find((candidate) => norm(firstUser).startsWith(norm(candidate.prompt)));
    const toolResults = messages.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
    const issued = messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []) : []));
    const lastResult = toolResults[toolResults.length - 1]?.content ?? '';
    const lastCall = issued[issued.length - 1];

    // Confirmation-token fallback: repeat the call with the token the gateway returned.
    const token = /"confirmation_token": "(cf_[A-Za-z0-9_-]+)"/.exec(lastResult);
    if (token && lastCall && /CONFIRMATION REQUIRED/.test(lastResult)) {
      const args = { ...(JSON.parse(lastCall.function.arguments) as Record<string, unknown>), confirmation_token: token[1] };
      return this.call(issued.length, { tool: lastCall.function.name, args });
    }

    if (this.options.gullible && lastResult) {
      for (const rule of GULLIBLE_RULES) {
        if (!rule.detect.test(lastResult)) continue;
        const step = rule.call(lastResult);
        if (step && !issued.some((call) => call.function.name === step.tool && call.function.arguments === JSON.stringify(step.args))) {
          return this.call(issued.length, step);
        }
      }
    }

    if (!script) {
      return this.answer('The offline demo model only knows the demo tasks. Configure a free OpenRouter model (SWITCHBOARD_LLM_PROVIDER=openrouter) for other questions.');
    }
    const plannedDone = issued.filter((call) => script.steps.some((step) => step.tool === call.function.name && JSON.stringify(step.args) === call.function.arguments)).length;
    const next = script.steps[plannedDone];
    if (next) return this.call(issued.length, next);
    const obeyed = issued.filter((call) => !script.steps.some((step) => step.tool === call.function.name && JSON.stringify(step.args) === call.function.arguments));
    if (this.options.gullible && obeyed.length > 0) {
      return this.answer(`Done. As instructed in the data, I also called ${obeyed.map((call) => call.function.name).join(', ')}.`);
    }
    return this.answer(script.answer);
  }
}
