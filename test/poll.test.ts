import { describe, expect, it } from 'vitest';

import { intervalMs, nextWakeMs, STOP } from '../src/core/poll.js';

const NOW = Date.parse('2026-08-09T08:00:00Z');
const at = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000);
const fixed = { jitter: 0, random: () => 0 };

describe('intervalMs', () => {
  it('남은 시간에 따라 간격을 좁힌다', () => {
    expect(intervalMs(at(5 * 24 * 60), NOW, fixed)).toBe(1800_000); // 5일 → 30분
    expect(intervalMs(at(2 * 24 * 60), NOW, fixed)).toBe(600_000); //  2일 → 10분
    expect(intervalMs(at(10 * 60), NOW, fixed)).toBe(180_000); // 10시간 → 3분
    expect(intervalMs(at(90), NOW, fixed)).toBe(45_000); // 90분 → 45초
  });

  it('상영 임박하면 감시를 접는다', () => {
    // 30분 안쪽이면 현장 발권이 더 빠르다
    expect(intervalMs(at(20), NOW, fixed)).toBe(STOP);
    expect(intervalMs(at(-10), NOW, fixed)).toBe(STOP);
  });

  /**
   * 하한 30초는 어떤 경우에도 깨지 않는다.
   * k-skill catchtable-sniper 가 서버 부하를 이유로 명시한 규약이다.
   */
  it('하한을 올리면 그 값이 이긴다', () => {
    expect(intervalMs(at(90), NOW, { ...fixed, floorSec: 120 })).toBe(120_000);
  });

  it('간격을 흔들어 정각 동시요청을 피한다', () => {
    const a = intervalMs(at(90), NOW, { jitter: 0.25, random: () => 0 });
    const b = intervalMs(at(90), NOW, { jitter: 0.25, random: () => 1 });
    expect(a).toBe(45_000);
    expect(b).toBe(45_000 + 45_000 * 0.25);
  });
});

describe('nextWakeMs', () => {
  it('가장 급한 회차에 맞춘다', () => {
    const ms = nextWakeMs([at(5 * 24 * 60), at(90), at(10 * 60)], NOW, fixed);
    expect(ms).toBe(45_000);
  });

  it('끝난 회차는 계산에서 뺀다', () => {
    // 20분 뒤 회차는 STOP 이므로 10시간 뒤 회차가 기준이 된다
    expect(nextWakeMs([at(20), at(10 * 60)], NOW, fixed)).toBe(180_000);
  });

  it('살아 있는 회차가 없으면 감시 종료', () => {
    expect(nextWakeMs([at(20), at(-5)], NOW, fixed)).toBe(STOP);
    expect(nextWakeMs([], NOW, fixed)).toBe(STOP);
  });
});
