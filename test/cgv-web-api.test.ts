import { describe, expect, it } from 'vitest';

import { parsePrmpLimit } from '../src/adapters/cgv/web-api.js';

describe('parsePrmpLimit', () => {
  /**
   * seatTempPrmpLimitDt 에는 시간대 표시가 없다. UTC 로 읽으면 9시간 뒤로
   * 밀려서, 이미 풀린 좌석을 아직 붙들고 있다고 믿게 된다.
   */
  it('KST 로 읽는다', () => {
    expect(parsePrmpLimit('20260810104124')).toBe(Date.parse('2026-08-10T10:41:24+09:00'));
  });

  it('모양이 다르면 null', () => {
    expect(parsePrmpLimit('2026-08-10 10:41:24')).toBeNull();
    expect(parsePrmpLimit('')).toBeNull();
    expect(parsePrmpLimit('202608101041')).toBeNull();
  });
});
