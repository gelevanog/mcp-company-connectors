import { describe, expect, it } from 'vitest';

import { withinWorkingHours } from '../src/index.js';

const slot = (startIso: string, minutes: number): [Date, Date] => {
  const start = new Date(startIso);
  return [start, new Date(start.getTime() + minutes * 60_000)];
};

describe('withinWorkingHours', () => {
  it('accepts slots inside 09:00-17:00 local time, including ones ending exactly at 17:00', () => {
    expect(withinWorkingHours(...slot('2026-10-05T09:00:00Z', 30), 'UTC')).toBe(true);
    expect(withinWorkingHours(...slot('2026-10-05T14:00:00Z', 180), 'UTC')).toBe(true);
    expect(withinWorkingHours(...slot('2026-10-05T13:00:00Z', 240), 'America/New_York')).toBe(true); // 09:00-13:00 EDT
  });

  it('rejects slots that start before 09:00 or end after 17:00', () => {
    expect(withinWorkingHours(...slot('2026-10-05T08:30:00Z', 60), 'UTC')).toBe(false);
    expect(withinWorkingHours(...slot('2026-10-05T16:30:00Z', 60), 'UTC')).toBe(false);
  });

  // https://github.com/gelevanog/mcp-company-connectors/issues/1
  it('rejects late-night slots that cross local midnight', () => {
    expect(withinWorkingHours(...slot('2026-10-05T22:00:00Z', 180), 'UTC')).toBe(false);
    expect(withinWorkingHours(...slot('2026-10-05T21:30:00Z', 180), 'UTC')).toBe(false);
    expect(withinWorkingHours(...slot('2026-10-06T02:00:00Z', 180), 'America/New_York')).toBe(false); // 22:00-01:00 EDT
    expect(withinWorkingHours(...slot('2026-10-05T23:00:00Z', 60), 'UTC')).toBe(false); // ends exactly at midnight
  });

  it('rejects weekends in the attendee time zone', () => {
    expect(withinWorkingHours(...slot('2026-10-10T10:00:00Z', 30), 'UTC')).toBe(false); // Saturday
    expect(withinWorkingHours(...slot('2026-10-09T23:00:00Z', 30), 'Asia/Tokyo')).toBe(false); // Sat 08:00 in Tokyo
  });
});
