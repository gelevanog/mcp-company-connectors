import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type AgentEvent, type ChatModel, type FakeScript, connectGateway, createModel, defaultSystemPrompt, runAgent } from '@switchboard/agent';
import { ALL_SCOPES, queryOne, today } from '@switchboard/core';
import { parse } from 'yaml';

import { type GatewayConfig, repoRoot } from './config.js';
import type { KeyManager } from './keys.js';
import { grantScopes, roleScopes } from './policy.js';
import type { GatewayDeps } from './server.js';
import { issueAccessToken } from './tokens.js';

export interface PlaygroundTask {
  id: string;
  user: string;
  prompt: string;
  preset?: boolean;
  title?: string;
}

interface TaskFile {
  tasks: (PlaygroundTask & { fake_plan?: { steps: FakeScript['steps']; answer: string } })[];
}

export function loadTaskFile(path = join(repoRoot(), 'data', 'eval', 'tasks.yaml')): TaskFile {
  if (!existsSync(path)) return { tasks: [] };
  return parse(readFileSync(path, 'utf8')) as TaskFile;
}

export function fakeScripts(file = loadTaskFile()): FakeScript[] {
  return file.tasks.flatMap((task) => (task.fake_plan ? [{ prompt: task.prompt, steps: task.fake_plan.steps, answer: task.fake_plan.answer }] : []));
}

export type PlaygroundEvent =
  | AgentEvent
  | { type: 'started'; user: string; role: string; model: string; tools: string[] }
  | { type: 'confirmation'; key: string; message: string }
  | { type: 'confirmation_answered'; key: string; action: string }
  | { type: 'done'; answer: string; llmCalls: number; latencyMs: number };

interface Run {
  id: string;
  events: { seq: number; event: PlaygroundEvent }[];
  listeners: Set<(entry: { seq: number; event: PlaygroundEvent }) => void>;
  pending: Map<string, (action: 'accept' | 'decline') => void>;
  done: boolean;
  createdAt: number;
}

export interface StartOptions {
  userId: string;
  prompt: string;
  provider: 'fake' | 'openrouter';
  model?: string;
  gullible?: boolean;
  exposeAll?: boolean;
}

/**
 * The admin console's "try it" page: runs the agent loop server-side (the model key never reaches the browser)
 * as a chosen user, through the gateway's own /mcp endpoint, so it exercises exactly what a real client does.
 * Confirmations are forwarded to the browser and wait for a click.
 */
export class Playground {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly deps: GatewayDeps, private readonly keys: KeyManager, private readonly config: GatewayConfig) {}

  internalUrl(): string {
    return process.env.SWITCHBOARD_INTERNAL_URL ?? this.config.mcpResource;
  }

  presets(): PlaygroundTask[] {
    return loadTaskFile().tasks.filter((task) => task.preset).map(({ id, user, prompt, title }) => ({ id, user, prompt, ...(title && { title }) }));
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  subscribe(id: string, listener: (entry: { seq: number; event: PlaygroundEvent }) => void): () => void {
    const run = this.runs.get(id);
    if (!run) return () => undefined;
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  answer(id: string, key: string, action: 'accept' | 'decline'): boolean {
    const resolve = this.runs.get(id)?.pending.get(key);
    if (!resolve) return false;
    resolve(action);
    return true;
  }

  async mintToken(userId: string, clientId = 'switchboard-playground'): Promise<{ token: string; role: string; name: string }> {
    const user = await queryOne<{ id: string; role: string; name: string }>(this.deps.db, 'SELECT id, role, name FROM core.employees WHERE id = $1 AND can_sign_in', [userId]);
    if (!user) throw new Error(`unknown user ${userId}`);
    const scopes = grantScopes([], roleScopes(this.deps.tenant, user.role), ALL_SCOPES.filter((scope) => scope !== 'admin'));
    const token = await issueAccessToken(this.keys, this.config, { sub: user.id, role: user.role, tenant: this.deps.tenantName, scope: scopes.join(' '), client_id: clientId, name: user.name }, this.config.mcpResource, 3600);
    return { token, role: user.role, name: user.name };
  }

  async start(options: StartOptions): Promise<string> {
    const id = `run_${randomBytes(6).toString('hex')}`;
    const run: Run = { id, events: [], listeners: new Set(), pending: new Map(), done: false, createdAt: Date.now() };
    this.runs.set(id, run);
    for (const [key, old] of this.runs) if (Date.now() - old.createdAt > 3_600_000) this.runs.delete(key);
    const emit = (event: PlaygroundEvent) => {
      const entry = { seq: run.events.length, event };
      run.events.push(entry);
      for (const listener of run.listeners) listener(entry);
    };
    void this.execute(run, options, emit).catch((error: unknown) => {
      emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      run.done = true;
    });
    return id;
  }

  private async execute(run: Run, options: StartOptions, emit: (event: PlaygroundEvent) => void): Promise<void> {
    const { token, role, name } = await this.mintToken(options.userId);
    let model: ChatModel;
    if (options.provider === 'openrouter') {
      if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set on the gateway; use the offline model');
      model = createModel({ provider: 'openrouter', ...(options.model && { model: options.model }), tag: 'playground' });
    } else {
      model = createModel({ provider: 'fake', gullible: options.gullible ?? false }, { scripts: fakeScripts() });
    }
    let counter = 0;
    const connection = await connectGateway({
      url: this.internalUrl(),
      token,
      clientName: 'switchboard-playground',
      ...(options.exposeAll && { headers: { 'x-switchboard-expose': 'all' } }),
      elicit: async (request) => {
        counter += 1;
        const key = `c${counter}`;
        emit({ type: 'confirmation', key, message: request.message });
        const action = await new Promise<'accept' | 'decline'>((resolve) => {
          run.pending.set(key, resolve);
          setTimeout(() => resolve('decline'), 10 * 60_000).unref();
        });
        run.pending.delete(key);
        emit({ type: 'confirmation_answered', key, action });
        return action === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
      },
    });
    emit({ type: 'started', user: options.userId, role, model: model.label, tools: connection.tools.map((tool) => tool.name) });
    try {
      const result = await runAgent({
        connection,
        model,
        system: defaultSystemPrompt({ userName: name, role, company: this.deps.tenant.name, today: today(), instructions: undefined }),
        prompt: options.prompt,
        onEvent: emit,
      });
      emit({ type: 'done', answer: result.answer || result.error || '', llmCalls: result.llmCalls, latencyMs: result.latencyMs });
    } finally {
      run.done = true;
      await connection.close();
    }
  }
}
