import { describe, expect, it } from 'vitest';

import {
  assignGroups,
  splitLabel,
  toSeatState,
  type RawCgvSeat,
} from '../src/adapters/cgv/seatmap.js';
import type { Seat } from '../src/types.js';

/** 실제 CGV 좌석 요소에서 옮긴 것 (L5 선택 상태) */
const SELECTED: RawCgvSeat = {
  id: '00100100110023',
  label: 'L5',
  className: 'seatMap_seatNumber__JHck5 seatMap_seatNormal__SojfU seatMap_active__I_XA6',
  title: '선택됨',
  disabled: false,
  x: 228,
  y: 456,
};

describe('좌석 상태 판정', () => {
  /**
   * class 이름 뒤 해시(__JHck5)는 CGV 가 빌드할 때마다 바뀐다.
   * 통째로 매칭하면 어느 날 조용히 좌석을 못 찾는다.
   */
  it('해시 접미어가 바뀌어도 알아본다', () => {
    const rebuilt = { ...SELECTED, className: 'seatMap_seatNumber__aB1 seatMap_seatNormal__xY9' };
    expect(toSeatState(rebuilt)).toBe('free');
  });

  it('내가 고른 좌석은 free 로 세지 않는다', () => {
    // free 로 세면 잔여수가 부풀려진다
    expect(toSeatState(SELECTED)).toBe('held');
  });

  it('disabled 좌석은 살 수 없다', () => {
    expect(toSeatState({ ...SELECTED, className: 'seatMap_seatNumber__x', disabled: true })).toBe(
      'blocked',
    );
  });

  it('title 로도 판매완료를 가려낸다', () => {
    const sold = { ...SELECTED, className: 'seatMap_seatNumber__x', title: '판매완료' };
    expect(toSeatState(sold)).toBe('sold');
  });
});

describe('splitLabel', () => {
  it('행과 번호를 가른다', () => {
    expect(splitLabel('L5')).toEqual({ row: 'L', col: 5 });
    expect(splitLabel('A14')).toEqual({ row: 'A', col: 14 });
  });
});

describe('assignGroups', () => {
  /**
   * 롯데는 SeatColumGroupNo 로 통로를 알려주지만 CGV 는 없다.
   * 픽셀 좌표로 끊어야 한다 — 좌석 폭보다 눈에 띄게 벌어지면 통로다.
   */
  it('좌표 간격으로 통로를 찾는다', () => {
    const seat = (col: number, x: number): Seat => ({
      id: `s${col}`, row: 'H', col, x, y: 0, group: 1, state: 'free',
    });
    // 38px 좌석이 42px 간격으로 늘어서다가, 5번과 6번 사이만 120px 벌어진다
    const seats = assignGroups([
      seat(3, 0), seat(4, 42), seat(5, 84), seat(6, 204), seat(7, 246),
    ]);

    expect(seats.map((s) => s.group)).toEqual([1, 1, 1, 2, 2]);
  });

  it('통로가 없으면 한 구획이다', () => {
    const seats = assignGroups(
      [0, 42, 84, 126].map((x, i) => ({
        id: `s${i}`, row: 'A', col: i + 1, x, y: 0, group: 1, state: 'free' as const,
      })),
    );
    expect(new Set(seats.map((s) => s.group)).size).toBe(1);
  });
});
