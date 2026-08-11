import { describe, expect, it } from 'vitest';
import { CronParseError, describeCron, isValidCron, nextOccurrence, parseCron } from '@/lib/schedule/cron';

/**
 * The scheduler is the only thing standing between "autonomous" and "runs when
 * someone remembers to click a button", so its calendar arithmetic is tested
 * against the cases that break naive implementations: month lengths, leap days,
 * the POSIX day-of-month/day-of-week union rule, and step syntax.
 */

const iso = (expression: string, from: string, offsetMinutes = 0): string | null =>
  nextOccurrence(expression, new Date(from), offsetMinutes)?.toISOString() ?? null;

describe('parseCron', () => {
  it('expands wildcards to the full range', () => {
    const fields = parseCron('* * * * *');
    expect(fields.minutes).toHaveLength(60);
    expect(fields.hours).toHaveLength(24);
    expect(fields.daysOfMonth).toHaveLength(31);
    expect(fields.months).toHaveLength(12);
    expect(fields.dayOfMonthRestricted).toBe(false);
    expect(fields.dayOfWeekRestricted).toBe(false);
  });

  it('expands ranges, lists and steps', () => {
    expect(parseCron('0,30 9-11 * * *').minutes).toEqual([0, 30]);
    expect(parseCron('0,30 9-11 * * *').hours).toEqual([9, 10, 11]);
    expect(parseCron('*/20 * * * *').minutes).toEqual([0, 20, 40]);
    expect(parseCron('5/15 * * * *').minutes).toEqual([5, 20, 35, 50]);
  });

  it('accepts month and weekday names', () => {
    expect(parseCron('0 0 1 jan *').months).toEqual([1]);
    expect(parseCron('0 0 * * mon-fri').daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('normalises weekday 7 to 0 so Sunday matches once', () => {
    expect(parseCron('0 0 * * 0,7').daysOfWeek).toEqual([0]);
  });

  it('expands the macros', () => {
    expect(parseCron('@daily').hours).toEqual([0]);
    expect(parseCron('@hourly').minutes).toEqual([0]);
    expect(parseCron('@weekly').daysOfWeek).toEqual([0]);
  });

  it('rejects malformed expressions rather than silently never firing', () => {
    expect(() => parseCron('0 6 * *')).toThrow(CronParseError);
    expect(() => parseCron('60 * * * *')).toThrow(CronParseError);
    expect(() => parseCron('0 6 * * xyz')).toThrow(CronParseError);
    expect(() => parseCron('5-1 * * * *')).toThrow(/backwards/);
    expect(() => parseCron('*/0 * * * *')).toThrow(CronParseError);
    expect(isValidCron('0 6 * * *')).toBe(true);
    expect(isValidCron('nonsense')).toBe(false);
  });
});

describe('nextOccurrence', () => {
  it('returns the next matching minute, strictly after the given instant', () => {
    expect(iso('0 6 * * *', '2026-08-11T05:30:00Z')).toBe('2026-08-11T06:00:00.000Z');
    // Exactly on the boundary must advance, otherwise a claimed schedule would
    // immediately re-claim itself and run in a tight loop.
    expect(iso('0 6 * * *', '2026-08-11T06:00:00Z')).toBe('2026-08-12T06:00:00.000Z');
  });

  it('honours step expressions within the hour', () => {
    expect(iso('*/15 * * * *', '2026-08-11T10:07:00Z')).toBe('2026-08-11T10:15:00.000Z');
    expect(iso('*/15 * * * *', '2026-08-11T10:52:00Z')).toBe('2026-08-11T11:00:00.000Z');
  });

  it('skips weekends for a weekday schedule', () => {
    // 2026-08-08 is a Saturday; the next weekday firing is Monday the 10th.
    expect(iso('0 8 * * 1-5', '2026-08-08T00:00:00Z')).toBe('2026-08-10T08:00:00.000Z');
  });

  it('skips months that do not have the requested day', () => {
    // February has no 31st, and 2026 is not a leap year, so the next 31st is in March.
    expect(iso('0 0 31 * *', '2026-02-01T00:00:00Z')).toBe('2026-03-31T00:00:00.000Z');
  });

  it('finds the next leap day', () => {
    expect(iso('0 0 29 2 *', '2026-01-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('applies the POSIX union rule when both day fields are restricted', () => {
    // 1 January 2026 is a Thursday. With both fields restricted, either the 1st
    // of January or any Sunday in January matches — the first Sunday is the 4th.
    expect(iso('0 0 1 jan sun', '2026-01-02T00:00:00Z')).toBe('2026-01-04T00:00:00.000Z');
  });

  it('shifts the calendar by the configured timezone offset', () => {
    // 06:00 in a UTC+02:00 deployment is 04:00 UTC.
    expect(iso('0 6 * * *', '2026-08-11T00:00:00Z', 120)).toBe('2026-08-11T04:00:00.000Z');
    // 06:00 in a UTC-05:00 deployment is 11:00 UTC.
    expect(iso('0 6 * * *', '2026-08-11T00:00:00Z', -300)).toBe('2026-08-11T11:00:00.000Z');
  });

  it('produces a strictly increasing sequence over a full year', () => {
    let cursor = new Date('2026-01-01T00:00:00Z');
    let previous = cursor.getTime();
    for (let i = 0; i < 400; i += 1) {
      const next = nextOccurrence('30 8 * * *', cursor);
      expect(next).not.toBeNull();
      if (!next) break;
      expect(next.getTime()).toBeGreaterThan(previous);
      expect(next.getUTCHours()).toBe(8);
      expect(next.getUTCMinutes()).toBe(30);
      previous = next.getTime();
      cursor = next;
    }
    // 400 daily occurrences from 1 January 2026 lands in February 2027.
    expect(cursor.getUTCFullYear()).toBe(2027);
  });
});

describe('describeCron', () => {
  it('renders an expression an operator can check at a glance', () => {
    expect(describeCron('0 8 * * 1-5')).toContain('08:00');
    expect(describeCron('0 8 * * 1-5')).toContain('mon');
    expect(describeCron('0 0 1 * *')).toContain('day 1 of the month');
  });
});
