import { db } from '../src/lib/db/client';
import { installGlobalDispatcher } from '../src/lib/net/dispatcher';
import { config } from '../src/lib/config/env';
import { capabilityReport } from '../src/lib/config/capabilities';
import { FACTORY_STEPS, runFactory, type FactoryStep } from '../src/lib/orchestrator/factory';
import { subscribe } from '../src/lib/observability/events';
import { budgetState } from '../src/lib/ai/usage';

/**
 * Runs one factory cycle from the command line.
 *
 * This is the same pipeline the scheduler and the console drive — there is no
 * separate "CLI mode" that behaves differently. It exists so a deployment can be
 * exercised, or a single day's work run, without a browser.
 *
 *   npm run factory:run -- "objective" [--stop-after=selection] [--no-games]
 */

function usage(): never {
  process.stderr.write(
    [
      'Usage: npm run factory:run -- "<objective>" [options]',
      '',
      'Options:',
      `  --stop-after=<step>   Stop after a step. One of: ${FACTORY_STEPS.join(', ')}`,
      '  --no-games            Exclude 3D game concepts from invention.',
      '  --max-documents=<n>   Cap how many documents the research step fetches.',
      '  --quiet               Do not stream progress events.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const objective = args.find((arg) => !arg.startsWith('--'));
  if (!objective) usage();

  const flag = (name: string): string | undefined =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

  const stopAfter = flag('stop-after') as FactoryStep | undefined;
  if (stopAfter && !FACTORY_STEPS.includes(stopAfter)) {
    process.stderr.write(`Unknown step "${stopAfter}".\n`);
    usage();
  }
  const maxDocuments = flag('max-documents') ? Number(flag('max-documents')) : undefined;
  const quiet = args.includes('--quiet');

  installGlobalDispatcher();
  db();
  const cfg = config();

  // A run that cannot reach its goal should fail here, before it spends
  // anything, with the reason stated rather than as a confusing mid-run error.
  const report = capabilityReport();
  const blocking = report.capabilities.filter(
    (capability) => capability.state === 'unavailable' && ['reasoning', 'web_research'].includes(capability.id),
  );
  if (blocking.length > 0) {
    process.stderr.write('The factory cannot run:\n');
    for (const capability of blocking) {
      process.stderr.write(`  - ${capability.title}: ${capability.summary}\n`);
      for (const remedy of capability.remedy) process.stderr.write(`      ${remedy}\n`);
    }
    process.exit(2);
  }

  if (!quiet) {
    subscribe((event) => {
      process.stdout.write(`[${event.ts.slice(11, 19)}] ${event.scope.padEnd(18)} ${event.message}\n`);
    });
  }

  const controller = new AbortController();
  const stop = (): void => {
    process.stderr.write('\nInterrupted — asking the run to stop.\n');
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  process.stdout.write(`Objective: ${objective}\nAutonomy: ${cfg.AUTONOMY_MODE}\n\n`);
  const started = Date.now();

  const result = await runFactory({
    objective,
    includeGames: !args.includes('--no-games'),
    trigger: 'manual',
    stopAfter,
    maxDocuments,
    signal: controller.signal,
  });

  const budget = budgetState();
  process.stdout.write(
    [
      '',
      `Run ${result.runId} — ${result.status}`,
      `Steps: ${result.stepsCompleted.join(' → ') || 'none'}`,
      `Cost: $${result.costUsd.toFixed(4)} (daily budget: $${budget.costUsed.toFixed(4)} of $${budget.costLimit.toFixed(2)})`,
      `Duration: ${((Date.now() - started) / 1000).toFixed(1)}s`,
      result.project ? `Product: ${result.project.name} (${result.project.slug})` : 'No product was created.',
      result.error ? `Error: ${result.error}` : '',
      result.summary,
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  process.exit(result.status === 'SUCCEEDED' ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
