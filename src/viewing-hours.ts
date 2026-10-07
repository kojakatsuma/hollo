import { Temporal } from "@js-temporal/polyfill";

/**
 * A daily time range in minutes since local midnight.  The start is
 * inclusive and the end is exclusive.  When `end` is less than `start`,
 * the range crosses midnight (e.g., 23:00-01:00).
 */
export interface ViewingHoursRange {
  readonly start: number;
  readonly end: number;
}

export interface ViewingHours {
  readonly ranges: readonly ViewingHoursRange[];
  readonly timeZone: string;
}

export const DEFAULT_VIEWING_HOURS_TIME_ZONE = "Asia/Tokyo";

const RANGE_PATTERN = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

function parseMinutes(hour: string, minute: string): number | null {
  const h = Number.parseInt(hour, 10);
  const m = Number.parseInt(minute, 10);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Parses the `VIEWING_HOURS` value, e.g., `07:00-08:00,21:00-22:00`.
 * @param value The comma-separated list of `HH:MM-HH:MM` ranges.
 * @param timeZone The IANA time zone in which the ranges are interpreted.
 * @returns The parsed viewing hours, or `null` if `value` is unset or blank
 *          (which means viewing is not restricted).
 * @throws {TypeError} If `value` or `timeZone` is malformed.
 */
export function parseViewingHours(
  value: string | undefined,
  timeZone: string = DEFAULT_VIEWING_HOURS_TIME_ZONE,
): ViewingHours | null {
  if (value == null || value.trim() === "") return null;
  const ranges: ViewingHoursRange[] = [];
  for (const item of value.split(",")) {
    const match = RANGE_PATTERN.exec(item.trim());
    const start = match == null ? null : parseMinutes(match[1], match[2]);
    const end = match == null ? null : parseMinutes(match[3], match[4]);
    if (start == null || end == null || start === end) {
      throw new TypeError(
        `Invalid VIEWING_HOURS range: ${JSON.stringify(item.trim())}; ` +
          "expected HH:MM-HH:MM with different start and end times " +
          "(e.g., 07:00-08:00,23:00-01:00).",
      );
    }
    ranges.push({ start, end });
  }
  try {
    Temporal.Now.instant().toZonedDateTimeISO(timeZone);
  } catch {
    throw new TypeError(
      `Invalid VIEWING_HOURS_TZ: ${JSON.stringify(timeZone)}; ` +
        "expected an IANA time zone name (e.g., Asia/Tokyo).",
    );
  }
  return { ranges, timeZone };
}

/**
 * Checks if the given instant falls within the viewing hours.
 */
export function isViewingAllowed(
  hours: ViewingHours,
  now: Temporal.Instant,
): boolean {
  const local = now.toZonedDateTimeISO(hours.timeZone);
  const minutes = local.hour * 60 + local.minute;
  return hours.ranges.some(({ start, end }) =>
    start < end
      ? start <= minutes && minutes < end
      : start <= minutes || minutes < end,
  );
}

/**
 * Gets the earliest start of a viewing hours range strictly after the given
 * instant.  When viewing is not allowed at `now`, this is when it becomes
 * allowed next.
 */
export function getNextViewingStart(
  hours: ViewingHours,
  now: Temporal.Instant,
): Temporal.ZonedDateTime {
  const today = now.toZonedDateTimeISO(hours.timeZone).toPlainDate();
  let next: Temporal.ZonedDateTime | null = null;
  // Every range starts once a day, so today and tomorrow are enough;
  // the day after covers time zone transitions longer than a few hours.
  for (let days = 0; days <= 2; days++) {
    const date = today.add({ days });
    for (const { start } of hours.ranges) {
      const candidate = date.toZonedDateTime({
        timeZone: hours.timeZone,
        plainTime: new Temporal.PlainTime(Math.floor(start / 60), start % 60),
      });
      if (
        Temporal.Instant.compare(candidate.toInstant(), now) > 0 &&
        (next == null || Temporal.ZonedDateTime.compare(candidate, next) < 0)
      ) {
        next = candidate;
      }
    }
    if (next != null) break;
  }
  return next!;
}

export const VIEWING_HOURS: ViewingHours | null = parseViewingHours(
  // oxlint-disable-next-line typescript/dot-notation
  process.env["VIEWING_HOURS"],
  // oxlint-disable-next-line typescript/dot-notation
  process.env["VIEWING_HOURS_TZ"]?.trim() || DEFAULT_VIEWING_HOURS_TIME_ZONE,
);
