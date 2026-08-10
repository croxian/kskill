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

describe('판매 종료 시각', () => {
  /**
   * CGV 는 상영 시작 뒤에도 15분 더 판다 (실측: 18:00 회차의 판매마감 18:15).
   * "30분 전 중단" 으로 잡으면 취소표가 가장 많이 나오는 45분을 통째로 버린다.
   */
  it('stopAt 이 있으면 상영 시작 뒤에도 계속 본다', () => {
    const showAt = at(-5); // 이미 5분 전에 시작했다
    const stopAt = at(10); // 판매는 10분 뒤에 끝난다

    expect(intervalMs(showAt, NOW, { ...fixed, stopAt })).toBeGreaterThan(0);
    expect(intervalMs(showAt, NOW, fixed)).toBe(STOP); // stopAt 이 없으면 진작 접었다
  });

  it('판매가 끝나면 그때 접는다', () => {
    expect(intervalMs(at(-5), NOW, { ...fixed, stopAt: at(-1) })).toBe(STOP);
  });

  it('stopAt 이 stopBeforeMin 을 이긴다', () => {
    // 20분 뒤 상영이라 stopBeforeMin(30) 기준으로는 접어야 하지만,
    // 판매는 35분 뒤까지 이어진다
    expect(intervalMs(at(20), NOW, { ...fixed, stopAt: at(35), stopBeforeMin: 30 })).toBe(45_000);
  });

  it('회차마다 다른 stopAt 을 각각 적용한다', () => {
    const ms = nextWakeMs(
      [
        { showAt: at(-5), stopAt: at(10) }, // 아직 판매 중
        { showAt: at(10 * 60) }, // 10시간 뒤
      ],
      NOW,
      fixed,
    );
    expect(ms).toBe(45_000); // 임박한 쪽에 맞춘다
  });
});

/**
 * 기본 간격표는 "난 자리가 얼마나 오래 남아 있는가" 를 기준으로 짠 것이다.
 * 한산한 회차라면 사흘 전에 난 자리는 몇 시간 남아 있다. 매진된 특별관은
 * 사흘 전이든 세 시간 전이든 나오는 즉시 사라진다 — 거기서는 전제가 무너진다.
 */
describe('intervalMs — 상한', () => {
  const NOW = Date.parse('2026-08-10T00:00:00Z');
  const daysOut = (n: number) => new Date(NOW + n * 86_400_000);
  const plain = { jitter: 0, random: () => 0 };

  it('상한이 없으면 멀수록 느긋하다', () => {
    expect(intervalMs(daysOut(5), NOW, plain)).toBe(1800_000);
  });

  it('상한을 주면 아무리 멀어도 그보다는 자주 본다', () => {
    expect(intervalMs(daysOut(5), NOW, { ...plain, maxSec: 60 })).toBe(60_000);
    expect(intervalMs(daysOut(2), NOW, { ...plain, maxSec: 60 })).toBe(60_000);
  });

  it('이미 상한보다 촘촘한 구간은 건드리지 않는다', () => {
    // 2시간 뒤면 원래 45초다. 상한 60초가 이를 늦추면 안 된다.
    const soon = new Date(NOW + 2 * 3_600_000);
    expect(intervalMs(soon, NOW, { ...plain, maxSec: 60 })).toBe(45_000);
  });

  /** 하한 30초는 어떤 경우에도 깨지 않는다. 상한이 더 짧아도 마찬가지다. */
  it('상한이 하한보다 짧아도 하한을 지킨다', () => {
    expect(intervalMs(daysOut(5), NOW, { ...plain, maxSec: 5, floorSec: 30 })).toBe(30_000);
  });
});
