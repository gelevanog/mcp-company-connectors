import type { Command } from 'commander';

export function registerEvalCommands(program: Command): void {
  program.command('eval').description('Evaluation (see subcommands)');
}
