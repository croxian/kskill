import { describe, expect, it } from 'vitest';

import { Backoff, isThrottled } from '../src/core/throttle.js';

describe('isThrottled', () => {
  it('밀어내는 응답을 알아본다', () => {
    expect(isThrottled(new Error('CGV HTTP 429'))).toBe(true);
    expect(isThrottled(new Error('CGV HTTP 403: /booking'))).toBe(true);
    expect(isThrottled(new Error('timeout after 15000ms'))).toBe(true);
    expect(isThrottled(new Error('Too Many Requests'))).toBe(true);
  });

  it('평범한 고장을 밀린 것으로 오해하지 않는다', () => {
    expect(isThrottled(new Error('HTTP 500'))).toBe(false);
    expect(isThrottled(new Error('socket hang up'))).toBe(false);
    expect(isThrottled(new Error('응답 파싱 실패'))).toBe(false);
    expect(isThrottled('문자열')).toBe(false);
  });
});

describe('Backoff', () => {
  it('밀릴 때마다 배로 물러선다', () => {
    const b = new Backoff({ factor: 2 });
    expect(b.multiplier).toBe(1);
    b.trip();
    expect(b.multiplier).toBe(2);
    b.trip();
    expect(b.multiplier).toBe(4);
  });

  it('바닥이 있다 — 무한정 느려지면 감시가 아니다', () => {
    const b = new Backoff({ factor: 2, maxLevel: 2 });
    b.trip();
    b.trip();
    expect(b.trip()).toBe(false);
    expect(b.multiplier).toBe(4);
  });

  /**
   * 한 번 성공했다고 바로 원래 속도로 뛰면, 밀리고 돌아오기를 반복하면서
   * 평균적으로는 계속 두드리는 꼴이 된다.
   */
  it('바로 돌아오지 않는다', () => {
    const b = new Backoff({ factor: 2, easeAfter: 3 });
    b.trip();

    expect(b.ease()).toBe(false);
    expect(b.ease()).toBe(false);
    expect(b.ease()).toBe(true); // 세 번 조용해야 한 단
    expect(b.multiplier).toBe(1);
  });

  it('다시 밀리면 조용했던 횟수를 잊는다', () => {
    const b = new Backoff({ factor: 2, easeAfter: 3 });
    b.trip();
    b.ease();
    b.ease();
    b.trip(); // 여기서 초기화
    expect(b.ease()).toBe(false);
    expect(b.ease()).toBe(false);
    expect(b.ease()).toBe(true);
  });

  /** 설정한 예산이 천장이다. 스스로 올라가지 않는다. */
  it('원래 속도보다 빨라지지 않는다', () => {
    const b = new Backoff();
    for (let i = 0; i < 20; i++) b.ease();
    expect(b.multiplier).toBe(1);
    expect(b.steps).toBe(0);
  });
});
