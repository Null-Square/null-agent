import { describe, expect, it } from 'vitest';
import {
  selectRateWindow,
  isRateCardEffective,
  validateRateWindows,
} from '@/domains/platform/models/ModelRateRepository';

const windows = [
  {
    id: 'peak-1',
    rateCardId: 'rate-1',
    name: 'peak',
    startMinuteUtc: 60,
    endMinuteUtc: 240,
    cacheHitInputPer1m: 0.044,
    cacheMissInputPer1m: 1.32,
    outputPer1m: 3.96,
  },
  {
    id: 'peak-2',
    rateCardId: 'rate-1',
    name: 'peak',
    startMinuteUtc: 360,
    endMinuteUtc: 600,
    cacheHitInputPer1m: 0.044,
    cacheMissInputPer1m: 1.32,
    outputPer1m: 3.96,
  },
];
const asInput = (window: (typeof windows)[number]) => {
  const { id: _id, rateCardId: _rateCardId, ...input } = window;
  return input;
};

describe('model rate windows', () => {
  it('uses inclusive starts and exclusive ends in UTC', () => {
    expect(selectRateWindow(windows, new Date('2026-08-20T00:59:59Z'))).toBeNull();
    expect(selectRateWindow(windows, new Date('2026-08-20T01:00:00Z'))?.id).toBe('peak-1');
    expect(selectRateWindow(windows, new Date('2026-08-20T03:59:59Z'))?.id).toBe('peak-1');
    expect(selectRateWindow(windows, new Date('2026-08-20T04:00:00Z'))).toBeNull();
    expect(selectRateWindow(windows, new Date('2026-08-20T05:59:59Z'))).toBeNull();
    expect(selectRateWindow(windows, new Date('2026-08-20T06:00:00Z'))?.id).toBe('peak-2');
    expect(selectRateWindow(windows, new Date('2026-08-20T09:59:59Z'))?.id).toBe('peak-2');
    expect(selectRateWindow(windows, new Date('2026-08-20T10:00:00Z'))).toBeNull();
  });

  it('uses inclusive card starts and exclusive card ends at the global cutover', () => {
    const cutover = new Date('2026-08-16T16:00:00Z');
    const oldCard = {
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: cutover,
    };
    const newCard = { effectiveFrom: cutover, effectiveTo: null };

    expect(isRateCardEffective(oldCard, new Date('2026-08-16T15:59:59Z'))).toBe(true);
    expect(isRateCardEffective(oldCard, cutover)).toBe(false);
    expect(isRateCardEffective(newCard, cutover)).toBe(true);
    expect(isRateCardEffective(newCard, new Date('2026-08-16T16:00:01Z'))).toBe(true);
  });

  it('rejects overlap, invalid minutes, and negative prices', () => {
    expect(() => validateRateWindows([
      { ...asInput(windows[0]!), startMinuteUtc: 60, endMinuteUtc: 240 },
      { ...asInput(windows[1]!), startMinuteUtc: 200, endMinuteUtc: 300 },
    ])).toThrow('must not overlap');
    expect(() => validateRateWindows([
      { ...asInput(windows[0]!), startMinuteUtc: -1 },
    ])).toThrow('Invalid UTC rate window');
    expect(() => validateRateWindows([
      { ...asInput(windows[0]!), cacheHitInputPer1m: -1 },
    ])).toThrow('finite non-negative');
  });
});
