import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { extractSymbols, type SymbolInfo } from '@/lib/ide/repo-index';
import { createLogger } from '@/lib/observability/logger';
import { counter } from '@/lib/observability/metrics';

const log = createLogger('agents.repair-policy');

/**
 * No-regression repair policy.
 *
 * The cheapest way to make a failing build pass is to delete the thing that
 * fails: drop the test, stub the function, silence the type error, remove the
 * feature. Every one of those makes the product worse while making the pipeline
 * green, and an autonomous loop will find them unless it is stopped.
 *
 * This module inspects each proposed change and rejects it when the failure was
 * "resolved" by removing capability rather than by fixing the defect. Rejected
 * repairs are fed back to the coding agent with the specific violation, so the
 * next attempt has to solve the real problem.
 */

export type ViolationKind =
  | 'symbol_removed'
  | 'test_removed'
  | 'assertion_removed'
  | 'function_stubbed'
  | 'type_check_suppressed'
  | 'lint_suppressed'
  | 'any_introduced'
  | 'todo_introduced'
  | 'error_swallowed'
  | 'feature_commented_out'
  | 'drastic_shrink'
  | 'empty_output';

export interface PolicyViolation {
  readonly kind: ViolationKind;
  readonly detail: string;
  /** Blocking violations reject the change outright. */
  readonly blocking: boolean;
  readonly evidence?: string;
}

export interface RepairMetrics {
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly linesBefore: number;
  readonly linesAfter: number;
  readonly symbolsBefore: number;
  readonly symbolsAfter: number;
  readonly shrinkRatio: number;
}

export interface RepairAssessment {
  readonly verdict: 'accept' | 'reject';
  readonly violations: readonly PolicyViolation[];
  readonly metrics: RepairMetrics;
  readonly guidance: string;
}

const SUPPRESSION_PATTERNS: ReadonlyArray<[ViolationKind, RegExp, string, boolean]> = [
  ['type_check_suppressed', /@ts-(?:ignore|nocheck|expect-error)/g, 'a TypeScript check was suppressed instead of the type being fixed', true],
  ['lint_suppressed', /eslint-disable(?!-next-line\s+@next)/g, 'a lint rule was disabled instead of the code being corrected', true],
  ['todo_introduced', /\b(?:TODO|FIXME|HACK|XXX)\b/g, 'a TODO/FIXME marker was introduced instead of the work being completed', true],
  ['function_stubbed', /throw new Error\(\s*['"`](?:not implemented|unimplemented|todo)/gi, 'a function was replaced with a "not implemented" throw', true],
];

const ANY_PATTERN = /:\s*any\b|<any>|as\s+any\b/g;
const EMPTY_CATCH = /catch\s*\([^)]*\)\s*\{\s*\}/g;
const TEST_PATTERN = /\b(?:it|test|describe)\s*\(/g;
const ASSERTION_PATTERN = /\b(?:expect|assert)\s*\(/g;

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function exportedNames(source: string): Set<string> {
  return new Set(
    extractSymbols(source)
      .filter((symbol: SymbolInfo) => symbol.exported)
      .map((symbol) => `${symbol.kind}:${symbol.name}`),
  );
}

/** Detects a block of working code turned into comments. */
function commentedOutBlocks(before: string, after: string): number {
  const beforeComments = count(before, /^\s*\/\/\s*\S/gm);
  const afterComments = count(after, /^\s*\/\/\s*\S/gm);
  const added = afterComments - beforeComments;
  if (added < 5) return 0;
  // Only count comment lines that look like code rather than prose.
  const codeLike = (after.match(/^\s*\/\/\s*.*[;{}()=]\s*$/gm) ?? []).length;
  return codeLike >= 5 ? codeLike : 0;
}

export interface AssessRepairInput {
  readonly filePath: string;
  readonly before: string;
  readonly after: string;
  /** Test files are held to a stricter standard: coverage may not be reduced. */
  readonly isTestFile?: boolean;
}

export function assessRepair(input: AssessRepairInput): RepairAssessment {
  const { before, after } = input;
  const violations: PolicyViolation[] = [];

  const linesBefore = before === '' ? 0 : before.split('\n').length;
  const linesAfter = after === '' ? 0 : after.split('\n').length;
  const shrinkRatio = linesBefore === 0 ? 0 : 1 - linesAfter / linesBefore;

  const symbolsBefore = exportedNames(before);
  const symbolsAfter = exportedNames(after);
  const metrics: RepairMetrics = {
    bytesBefore: Buffer.byteLength(before),
    bytesAfter: Buffer.byteLength(after),
    linesBefore,
    linesAfter,
    symbolsBefore: symbolsBefore.size,
    symbolsAfter: symbolsAfter.size,
    shrinkRatio: Number(shrinkRatio.toFixed(3)),
  };

  if (before.length > 0 && after.trim().length === 0) {
    violations.push({ kind: 'empty_output', detail: 'the file was emptied', blocking: true });
  }

  // Capability removal: an exported symbol that existed and no longer does.
  const removed = [...symbolsBefore].filter((name) => !symbolsAfter.has(name));
  if (removed.length > 0) {
    violations.push({
      kind: 'symbol_removed',
      detail: `${removed.length} exported symbol(s) were deleted rather than repaired: ${removed.slice(0, 6).join(', ')}`,
      blocking: true,
      evidence: removed.join(', '),
    });
  }

  // Newly introduced suppressions and markers.
  for (const [kind, pattern, detail, blocking] of SUPPRESSION_PATTERNS) {
    const added = count(after, pattern) - count(before, pattern);
    if (added > 0) violations.push({ kind, detail: `${detail} (${added} new occurrence(s))`, blocking });
  }

  const addedAny = count(after, ANY_PATTERN) - count(before, ANY_PATTERN);
  if (addedAny > 0) {
    violations.push({
      kind: 'any_introduced',
      detail: `${addedAny} new \`any\` annotation(s) were added, which hides the type error rather than resolving it`,
      blocking: true,
    });
  }

  const addedEmptyCatch = count(after, EMPTY_CATCH) - count(before, EMPTY_CATCH);
  if (addedEmptyCatch > 0) {
    violations.push({
      kind: 'error_swallowed',
      detail: `${addedEmptyCatch} empty catch block(s) were added, silencing the failure instead of handling it`,
      blocking: true,
    });
  }

  const commented = commentedOutBlocks(before, after);
  if (commented > 0) {
    violations.push({
      kind: 'feature_commented_out',
      detail: `${commented} lines of working code appear to have been commented out`,
      blocking: true,
    });
  }

  // Test files may grow but never shrink in coverage.
  const testsBefore = count(before, TEST_PATTERN);
  const testsAfter = count(after, TEST_PATTERN);
  if (testsAfter < testsBefore) {
    violations.push({
      kind: 'test_removed',
      detail: `${testsBefore - testsAfter} test case(s) were removed; a failing test is evidence of a defect, not something to delete`,
      blocking: true,
    });
  }
  const assertionsBefore = count(before, ASSERTION_PATTERN);
  const assertionsAfter = count(after, ASSERTION_PATTERN);
  if (assertionsAfter < assertionsBefore) {
    violations.push({
      kind: 'assertion_removed',
      detail: `${assertionsBefore - assertionsAfter} assertion(s) were removed, weakening what the suite proves`,
      blocking: true,
    });
  }

  // A large shrink is not automatically wrong — a genuine simplification can be
  // an improvement — but combined with no new symbols it is almost always the
  // model taking the easy path, so it blocks and asks for justification.
  if (linesBefore > 40 && shrinkRatio > 0.4) {
    const gainedSymbols = [...symbolsAfter].some((name) => !symbolsBefore.has(name));
    violations.push({
      kind: 'drastic_shrink',
      detail: `the file lost ${(shrinkRatio * 100).toFixed(0)}% of its lines (${linesBefore} → ${linesAfter})`,
      blocking: !gainedSymbols,
    });
  }

  const blocking = violations.filter((v) => v.blocking);
  const assessment: RepairAssessment = {
    verdict: blocking.length === 0 ? 'accept' : 'reject',
    violations,
    metrics,
    guidance:
      blocking.length === 0
        ? 'Change accepted: no capability was removed and no check was suppressed.'
        : buildGuidance(input.filePath, blocking),
  };

  counter('repair.policy', { verdict: assessment.verdict, file: input.isTestFile ? 'test' : 'source' });
  if (assessment.verdict === 'reject') {
    log.warn('repair rejected by the no-regression policy', {
      file: input.filePath,
      violations: blocking.map((v) => v.kind),
    });
  }
  return assessment;
}

function buildGuidance(filePath: string, violations: readonly PolicyViolation[]): string {
  return [
    `The proposed change to ${filePath} was rejected because it resolves the failure by removing or silencing behaviour rather than by fixing the defect.`,
    '',
    'Violations:',
    ...violations.map((v) => `- ${v.detail}`),
    '',
    'Required approach:',
    '- Diagnose the underlying cause and correct it. Keep every exported symbol, every test and every assertion that existed before.',
    '- Do not add `any`, `@ts-ignore`, `eslint-disable`, TODO markers, empty catch blocks or "not implemented" throws.',
    '- If a type is genuinely wrong, correct the type or the value that produces it — do not widen it.',
    '- If a test fails, the product is wrong until proven otherwise: fix the product.',
    '- If the correct fix is larger than the original code, that is acceptable. Deleting scope is not.',
  ].join('\n');
}

export function recordRepairAudit(input: {
  projectId: string;
  attempt: number;
  filePath: string;
  assessment: RepairAssessment;
}): void {
  db()
    .prepare(
      `INSERT INTO repair_audits (id, project_id, attempt, file_path, verdict, violations, metrics, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId('rpa'),
      input.projectId,
      input.attempt,
      input.filePath,
      input.assessment.verdict,
      toJson(input.assessment.violations),
      toJson(input.assessment.metrics),
      nowIso(),
    );
}

/** The policy text injected into every code-generation and repair prompt. */
export const NO_REGRESSION_DIRECTIVE = `QUALITY POLICY — this is not negotiable and your output is checked against it automatically:

- Fix the cause. Never make a failure disappear by removing the thing that fails.
- Never delete an exported symbol, a test case, or an assertion that already exists.
- Never add: \`any\`, \`@ts-ignore\`, \`@ts-expect-error\`, \`eslint-disable\`, TODO/FIXME markers,
  empty catch blocks, or \`throw new Error("not implemented")\`.
- Never comment out working code to get past an error.
- Never simplify a feature away, shorten a specification, or reduce scope to make a build pass.
- If the correct fix requires more code, write more code. If it requires a different design, change the design.
- Prefer a remedy that has already been verified in a previous run when one is supplied to you.

A change that violates any of the above is rejected automatically and you will be asked again.`;
