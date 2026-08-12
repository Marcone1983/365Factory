import { describe, expect, it } from 'vitest';
import { VerdictSchema } from '@/lib/generation/review/critic';

/**
 * The critic's verdict is graded by a vision model, and a vision model writes
 * the review it was asked for in whatever shape it feels like. Every rejected
 * shape costs a full re-review — the six renders go up again and are billed
 * again — so these tests pin down which deviations are understood rather than
 * paid for a second time.
 *
 * The line is meaning, not tolerance for anything: a review missing its score
 * or its criteria is still rejected, because supplying either would be
 * inventing the review instead of reading it.
 */

const CRITERIA = [{ criterion: 'the bore passes right through', verdict: 'PASS', observation: 'Daylight is visible through it in the side view.' }];

describe('verdict normalisation', () => {
  it('accepts the shape the schema documents', () => {
    const parsed = VerdictSchema.parse({
      criteria: CRITERIA,
      missingFeatures: [],
      additionalProblems: [],
      silhouetteReads: true,
      silhouetteNotes: 'Reads as a block with a hole.',
      score: 88,
      summary: 'Everything asked for is present.',
    });
    expect(parsed.score).toBe(88);
    expect(parsed.criteria).toHaveLength(1);
  });

  it('reads extra problems written as sentences instead of objects', () => {
    const parsed = VerdictSchema.parse({
      criteria: CRITERIA,
      additionalProblems: ['The wheels float beside the body.', 'The splitter is detached.'],
      silhouetteReads: false,
      silhouetteNotes: 'Reads as a drone, not a car.',
      score: 22,
      summary: 'It is not a car yet.',
    });
    expect(parsed.additionalProblems).toEqual([
      { problem: 'The wheels float beside the body.', severity: 'significant' },
      { problem: 'The splitter is detached.', severity: 'significant' },
    ]);
  });

  it('reads extra problems that name their fields differently', () => {
    const parsed = VerdictSchema.parse({
      criteria: CRITERIA,
      additionalProblems: [
        { issue: 'The haunch never widens.', stepId: 'bodyShell', impact: 'high' },
        { description: 'A seam runs down the bonnet.', severity: 'cosmetic' },
        { text: 'The mirrors intersect the glazing.' },
      ],
      silhouetteReads: true,
      silhouetteNotes: 'Reads as a car.',
      score: 61,
      summary: 'Recognisable with real faults.',
    });
    expect(parsed.additionalProblems).toEqual([
      { problem: 'The haunch never widens.', step: 'bodyShell', severity: 'severe' },
      { problem: 'A seam runs down the bonnet.', severity: 'minor' },
      // An ungraded problem is significant, never minor: guessing minor would
      // quietly drop it from the repair instructions.
      { problem: 'The mirrors intersect the glazing.', severity: 'significant' },
    ]);
  });

  it('reads a per-criterion answer given as a boolean or a synonym', () => {
    const parsed = VerdictSchema.parse({
      criteria: [
        { criterion: 'a', result: 'passed', observation: 'there' },
        { criterion: 'b', met: false, notes: 'absent' },
        { criterion: 'c', status: 'partially met', evidence: 'faint' },
      ],
      silhouetteReads: true,
      silhouetteNotes: 'fine',
      score: 70,
      summary: 'mixed',
    });
    expect(parsed.criteria.map((entry) => entry.verdict)).toEqual(['PASS', 'FAIL', 'PARTIAL']);
    expect(parsed.criteria[1]?.observation).toBe('absent');
  });

  it('reads a score written as a fraction and a silhouette given as an object', () => {
    const parsed = VerdictSchema.parse({
      criteria: CRITERIA,
      silhouette: { reads: 'no', notes: 'A blade with pods beside it.' },
      overallScore: '34/100',
      summary: 'Not a car.',
    });
    expect(parsed.score).toBe(34);
    expect(parsed.silhouetteReads).toBe(false);
    expect(parsed.silhouetteNotes).toBe('A blade with pods beside it.');
  });

  it('unwraps a review that arrived inside a single wrapper key', () => {
    const parsed = VerdictSchema.parse({
      review: {
        criteria: CRITERIA,
        silhouetteReads: true,
        silhouetteNotes: 'ok',
        score: 90,
        summary: 'good',
      },
    });
    expect(parsed.score).toBe(90);
  });

  it('writes the summary from the failed criteria when the reviewer omitted it', () => {
    const parsed = VerdictSchema.parse({
      criteria: [
        { criterion: 'the splitter is separate from the bumper', verdict: 'FAIL', observation: 'floating' },
        { criterion: 'no B-pillar from the side', verdict: 'PASS', observation: 'unbroken canopy' },
      ],
      silhouetteReads: true,
      silhouetteNotes: 'ok',
      score: 55,
    });
    expect(parsed.summary).toContain('1 of 2 acceptance criteria');
    expect(parsed.summary).toContain('the splitter is separate from the bumper');
  });

  it('still refuses a review with no score or no criteria', () => {
    expect(() =>
      VerdictSchema.parse({ criteria: CRITERIA, silhouetteReads: true, silhouetteNotes: 'ok', summary: 'x' }),
    ).toThrow();
    expect(() =>
      VerdictSchema.parse({ criteria: [], silhouetteReads: true, silhouetteNotes: 'ok', score: 80, summary: 'x' }),
    ).toThrow();
  });
});
