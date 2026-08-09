import { describe, expect, it } from 'vitest';

import {
  CGV_FLOW,
  cgvScreenPattern,
  cgvSelectorsAreStubs,
  cgvShowtimePattern,
} from '../src/hold/cgv-flow.js';

describe('CGV 예매 흐름 셀렉터', () => {
  /**
   * 회차 버튼 이름에 잔여석이 들어간다.
   *   ":30-10:32 128/200석 6관 (Laser)"
   * 통째로 맞추면 한 자리라도 팔리는 순간 못 찾는다. 롯데와 같은 함정이다.
   */
  it('회차는 잔여석이 아니라 시작 시각으로 맞춘다', () => {
    const re = cgvShowtimePattern('07:30');
    expect(re.test(':30-10:32 128/200석 6관 (Laser)')).toBe(true);
    expect(re.test(':30-10:32 3/200석 6관 (Laser)')).toBe(true); // 잔여석이 변해도
    expect(re.test(':00-13:02 128/200석 6관 (Laser)')).toBe(false);
  });

  it('상영관 이름도 회차 버튼에서 확인할 수 있다', () => {
    expect(cgvScreenPattern('IMAX관').test(':00-10:02 6/624석 IMAX관')).toBe(true);
    expect(cgvScreenPattern('IMAX관').test(':00-10:02 6/200석 6관 (Laser)')).toBe(false);
  });

  /**
   * ⛔ 좌석 화면의 "원  결제하기" 와 결제 화면의 "결제하기" 는 이름이 겹친다.
   * 헷갈리면 돈이 나간다. 우리 코드에는 후자를 클릭하는 경로가 없어야 한다.
   */
  it('넘어가는 버튼과 실제 결제 버튼을 다르게 둔다', () => {
    expect(CGV_FLOW.toPayment).not.toBe(CGV_FLOW.payNever);
    expect(CGV_FLOW.toPayment).toContain('원');
  });

  it('좌석 셀렉터가 아직 실측 전임을 스스로 안다', () => {
    expect(cgvSelectorsAreStubs(CGV_FLOW)).toBe(true);
  });
});
