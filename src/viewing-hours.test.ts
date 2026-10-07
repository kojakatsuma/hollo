import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";

import {
  getNextViewingStart,
  isViewingAllowed,
  parseViewingHours,
  type ViewingHours,
} from "./viewing-hours";

function at(isoDateTime: string, timeZone = "Asia/Tokyo"): Temporal.Instant {
  return Temporal.PlainDateTime.from(isoDateTime)
    .toZonedDateTime(timeZone)
    .toInstant();
}

function parse(value: string, timeZone?: string): ViewingHours {
  const hours = parseViewingHours(value, timeZone);
  if (hours == null) throw new Error("Expected viewing hours.");
  return hours;
}

describe("parseViewingHours", () => {
  it("returns null when unset or blank", () => {
    expect.assertions(3);
    expect(parseViewingHours(undefined)).toBeNull();
    expect(parseViewingHours("")).toBeNull();
    expect(parseViewingHours("   ")).toBeNull();
  });

  it("parses multiple ranges in Asia/Tokyo by default", () => {
    expect.assertions(1);
    expect(parseViewingHours("07:00-08:00, 12:00-12:30,23:00-1:00")).toEqual({
      ranges: [
        { start: 7 * 60, end: 8 * 60 },
        { start: 12 * 60, end: 12 * 60 + 30 },
        { start: 23 * 60, end: 60 },
      ],
      timeZone: "Asia/Tokyo",
    });
  });

  it.each([
    "7",
    "07:00",
    "07:00-",
    "07:00-08:00,",
    "07:00-08:00,,12:00-13:00",
    "24:00-01:00",
    "07:60-08:00",
    "07:00-07:00",
    "07:00~08:00",
    "07:00-08:00-09:00",
    "aa:bb-cc:dd",
  ])("throws on a malformed value %j", (value) => {
    expect.assertions(1);
    expect(() => parseViewingHours(value)).toThrow(TypeError);
  });

  it("throws on an unknown time zone", () => {
    expect.assertions(1);
    expect(() => parseViewingHours("07:00-08:00", "Mars/Olympus")).toThrow(
      /VIEWING_HOURS_TZ/,
    );
  });
});

describe("isViewingAllowed", () => {
  it("handles a normal range with an inclusive start and exclusive end", () => {
    expect.assertions(5);
    const hours = parse("07:00-08:00");
    expect(isViewingAllowed(hours, at("2026-10-08T06:59:59"))).toBe(false);
    expect(isViewingAllowed(hours, at("2026-10-08T07:00:00"))).toBe(true);
    expect(isViewingAllowed(hours, at("2026-10-08T07:59:59"))).toBe(true);
    expect(isViewingAllowed(hours, at("2026-10-08T08:00:00"))).toBe(false);
    expect(isViewingAllowed(hours, at("2026-10-08T15:00:00"))).toBe(false);
  });

  it("handles a range crossing midnight", () => {
    expect.assertions(6);
    const hours = parse("23:00-01:00");
    expect(isViewingAllowed(hours, at("2026-10-08T22:59:00"))).toBe(false);
    expect(isViewingAllowed(hours, at("2026-10-08T23:00:00"))).toBe(true);
    expect(isViewingAllowed(hours, at("2026-10-08T23:59:59"))).toBe(true);
    expect(isViewingAllowed(hours, at("2026-10-09T00:00:00"))).toBe(true);
    expect(isViewingAllowed(hours, at("2026-10-09T00:59:59"))).toBe(true);
    expect(isViewingAllowed(hours, at("2026-10-09T01:00:00"))).toBe(false);
  });

  it("handles multiple ranges", () => {
    expect.assertions(5);
    const hours = parse("07:00-08:00,12:00-12:30,21:00-22:00");
    expect(isViewingAllowed(hours, at("2026-10-08T07:30:00"))).toBe(true);
    expect(isViewingAllowed(hours, at("2026-10-08T10:00:00"))).toBe(false);
    expect(isViewingAllowed(hours, at("2026-10-08T12:15:00"))).toBe(true);
    expect(isViewingAllowed(hours, at("2026-10-08T12:30:00"))).toBe(false);
    expect(isViewingAllowed(hours, at("2026-10-08T21:00:00"))).toBe(true);
  });

  it("interprets ranges in the configured time zone", () => {
    expect.assertions(4);
    const tokyo = parse("07:00-08:00", "Asia/Tokyo");
    const utc = parse("07:00-08:00", "UTC");
    // 07:30 in Tokyo is 22:30 UTC on the previous day:
    const instant = at("2026-10-08T07:30:00", "Asia/Tokyo");
    expect(isViewingAllowed(tokyo, instant)).toBe(true);
    expect(isViewingAllowed(utc, instant)).toBe(false);
    expect(isViewingAllowed(utc, at("2026-10-08T07:30:00", "UTC"))).toBe(true);
    expect(isViewingAllowed(tokyo, at("2026-10-08T07:30:00", "UTC"))).toBe(
      false,
    );
  });
});

describe("getNextViewingStart", () => {
  const hours = parse("07:00-08:00,12:00-12:30,21:00-22:00");

  it("returns the next start later on the same day", () => {
    expect.assertions(2);
    const next = getNextViewingStart(hours, at("2026-10-08T08:00:00"));
    expect(next.toString({ timeZoneName: "never" })).toBe(
      "2026-10-08T12:00:00+09:00",
    );
    expect(
      getNextViewingStart(hours, at("2026-10-08T12:30:00")).toPlainTime(),
    ).toEqual(new Temporal.PlainTime(21, 0));
  });

  it("returns the first start on the next day after the last range", () => {
    expect.assertions(1);
    const next = getNextViewingStart(hours, at("2026-10-08T22:00:00"));
    expect(next.toString({ timeZoneName: "never" })).toBe(
      "2026-10-09T07:00:00+09:00",
    );
  });

  it("returns the start of a range crossing midnight", () => {
    expect.assertions(2);
    const crossing = parse("23:00-01:00");
    expect(
      getNextViewingStart(crossing, at("2026-10-09T01:00:00")).toString({
        timeZoneName: "never",
      }),
    ).toBe("2026-10-09T23:00:00+09:00");
    expect(
      getNextViewingStart(crossing, at("2026-10-08T22:59:00")).toString({
        timeZoneName: "never",
      }),
    ).toBe("2026-10-08T23:00:00+09:00");
  });

  it("returns times in the configured time zone", () => {
    expect.assertions(1);
    const utc = parse("07:00-08:00", "UTC");
    expect(
      getNextViewingStart(
        utc,
        at("2026-10-08T07:30:00", "Asia/Tokyo"),
      ).toString({ timeZoneName: "never" }),
    ).toBe("2026-10-08T07:00:00+00:00");
  });
});
