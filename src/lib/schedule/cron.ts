/**
 * Cron expression parser and occurrence calculator.
 *
 * Five fields — minute, hour, day-of-month, month, day-of-week — with ranges,
 * steps, lists, names and the `*` wildcard. This is a real calendar walk, not a
 * fixed-interval approximation: `0 8 * * 1-5` fires at 08:00 on weekdays and
 * skips weekends, and `0 0 31 * *` correctly skips the months that have no
 * 31st rather than firing on the 1st.
 *
 * Day-of-month and day-of-week follow the POSIX rule: when both are restricted
 * the match is their union (either one satisfies the expression), and when only
 * one is restricted the other is ignored. That rule is surprising but it is what
 * every cron implementation does, so a schedule copied from a crontab behaves
 * the way its author expects.
 *
 * All computation is in UTC. A deployment that wants local firing times sets
 * SCHEDULER_TIMEZONE_OFFSET_MINUTES, which shifts the calendar the expression is
 * evaluated against; the returned instants are still absolute.
 */

export class CronParseError extends Error {
  readonly code = 'CRON_PARSE_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

export interface CronFields {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  readonly daysOfWeek: readonly number[];
  /** True when the field was `*`, which changes the day-matching rule. */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

const SPECS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day-of-week', min: 0, max: 7, names: DAY_NAMES },
];

function resolveName(token: string, spec: FieldSpec): number | null {
  if (!spec.names) return null;
  const index = spec.names.indexOf(token.toLowerCase());
  return index === -1 ? null : index + (spec.name === 'month' ? 1 : 0);
}

function parseBound(token: string, spec: FieldSpec): number {
  const named = resolveName(token, spec);
  if (named !== null) return named;
  if (!/^\d+$/.test(token)) {
    throw new CronParseError(`"${token}" is not a valid ${spec.name} value`);
  }
  const value = Number(token);
  if (value < spec.min || value > spec.max) {
    throw new CronParseError(`${spec.name} value ${value} is outside ${spec.min}-${spec.max}`);
  }
  return value;
}

function parseField(field: string, spec: FieldSpec): { values: number[]; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;

  for (const part of field.split(',')) {
    const token = part.trim();
    if (token.length === 0) throw new CronParseError(`empty ${spec.name} entry`);

    const [rangePart = '', stepPart] = token.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        throw new CronParseError(`"${stepPart}" is not a valid ${spec.name} step`);
      }
      step = Number(stepPart);
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
      if (stepPart !== undefined) restricted = true;
    } else if (rangePart.includes('-')) {
      const [from = '', to = ''] = rangePart.split('-');
      start = parseBound(from, spec);
      end = parseBound(to, spec);
      if (end < start) throw new CronParseError(`${spec.name} range ${rangePart} runs backwards`);
      restricted = true;
    } else {
      start = parseBound(rangePart, spec);
      end = stepPart === undefined ? start : spec.max;
      restricted = true;
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }

  // Cron accepts both 0 and 7 for Sunday; normalise so matching is a set lookup.
  if (spec.name === 'day-of-week' && values.has(7)) {
    values.delete(7);
    values.add(0);
  }

  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) throw new CronParseError(`${spec.name} matched no values`);
  return { values: sorted, restricted };
}

export function parseCron(expression: string): CronFields {
  const raw = expression.trim().toLowerCase();
  const normalised = MACROS[raw] ?? raw;
  const fields = normalised.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(`expected 5 cron fields, received ${fields.length} in "${expression}"`);
  }

  const parsed = fields.map((field, index) => {
    const spec = SPECS[index];
    if (!spec) throw new CronParseError('internal field specification mismatch');
    return parseField(field, spec);
  });

  const [minute, hour, dom, month, dow] = parsed;
  if (!minute || !hour || !dom || !month || !dow) {
    throw new CronParseError(`could not parse "${expression}"`);
  }

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    dayOfMonthRestricted: dom.restricted,
    dayOfWeekRestricted: dow.restricted,
  };
}

/** True when the expression parses; used to validate operator input. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(fields: CronFields, dayOfMonth: number, dayOfWeek: number): boolean {
  const domHit = fields.daysOfMonth.includes(dayOfMonth);
  const dowHit = fields.daysOfWeek.includes(dayOfWeek);
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return domHit || dowHit;
  if (fields.dayOfMonthRestricted) return domHit;
  if (fields.dayOfWeekRestricted) return dowHit;
  return true;
}

/**
 * The next instant strictly after `after` that satisfies the expression.
 *
 * The search walks forward a minute at a time but skips whole days and whole
 * months when their calendar fields cannot match, so the worst case is bounded
 * by the number of candidate days rather than by minutes. Four years of lookahead
 * covers every expression that can ever fire, including 29 February.
 */
export function nextOccurrence(
  expression: string | CronFields,
  after: Date = new Date(),
  timezoneOffsetMinutes = 0,
): Date | null {
  const fields = typeof expression === 'string' ? parseCron(expression) : expression;
  const offsetMs = timezoneOffsetMinutes * 60_000;

  // Work in "local" milliseconds: shift into the target offset, match calendar
  // fields with UTC getters, then shift back when returning an absolute instant.
  const startLocal = new Date(after.getTime() + offsetMs);
  const cursor = new Date(
    Date.UTC(
      startLocal.getUTCFullYear(),
      startLocal.getUTCMonth(),
      startLocal.getUTCDate(),
      startLocal.getUTCHours(),
      startLocal.getUTCMinutes(),
    ) + 60_000, // strictly after
  );
  const limit = cursor.getTime() + 4 * 366 * 24 * 60 * 60_000;

  while (cursor.getTime() <= limit) {
    if (!fields.months.includes(cursor.getUTCMonth() + 1)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(fields, cursor.getUTCDate(), cursor.getUTCDay())) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hours.includes(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minutes.includes(cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(cursor.getTime() - offsetMs);
  }
  return null;
}

/** Describes an expression in plain language for the schedules table. */
export function describeCron(expression: string): string {
  const fields = parseCron(expression);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const times = fields.hours
    .flatMap((h) => fields.minutes.map((m) => `${pad(h)}:${pad(m)}`))
    .slice(0, 6)
    .join(', ');
  const many = fields.hours.length * fields.minutes.length > 6 ? ' …' : '';

  let days = 'every day';
  if (fields.dayOfWeekRestricted) {
    days = `on ${fields.daysOfWeek.map((d) => DAY_NAMES[d] ?? String(d)).join(', ')}`;
  } else if (fields.dayOfMonthRestricted) {
    days = `on day ${fields.daysOfMonth.join(', ')} of the month`;
  }
  const months =
    fields.months.length === 12 ? '' : ` in ${fields.months.map((m) => MONTH_NAMES[m - 1] ?? String(m)).join(', ')}`;

  return `at ${times}${many} ${days}${months}`.trim();
}
