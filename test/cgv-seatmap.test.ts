import { describe, expect, it } from 'vitest';

import {
  assignGroups,
  CGV_SEAT_RULES,
  dedupeSeats,
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

  /**
   * 실측에서 disabled 144개와 seatMap_seatDisabled 144개가 정확히 일치했다.
   * CGV 에서 disabled 는 "비어 있지만 못 산다" 가 아니라 "팔렸다" 는 뜻이다.
   */
  it('disabled 는 판매완료를 뜻한다', () => {
    expect(toSeatState({ ...SELECTED, className: 'seatMap_seatNumber__x', disabled: true })).toBe(
      'sold',
    );
  });

  /**
   * title 로 판정하려던 계획은 접었다. 실측에서 400개 중 398개가 빈 값이었고
   * 채워진 둘은 내가 고른 좌석의 "선택됨" 뿐이었다. class 로만 본다.
   */
  it('title 은 판정에 쓰지 않는다', () => {
    const free = { ...SELECTED, className: 'seatMap_seatNormal__x', title: '' };
    expect(toSeatState(free)).toBe('free');
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

describe('중복 좌석', () => {
  const twin = (over: Partial<RawCgvSeat>): RawCgvSeat => ({
    id: '00100100010001', label: 'A1',
    className: 'seatMap_seatNumber__x seatMap_seatNormal__y',
    title: '', disabled: false, x: 38, y: 38, ...over,
  });

  /**
   * CGV 좌석맵은 DOM 에 좌석을 두 벌 렌더한다. 실측에서 200석 관이 400개로
   * 잡혔고 x 간격에 0 이 반복됐다. 그대로 두면 잔여수가 정확히 두 배가 된다.
   */
  it('같은 좌석이 두 번 잡히면 하나로 줄인다', () => {
    expect(dedupeSeats([twin({}), twin({})])).toHaveLength(1);
  });

  it('두 벌 중 상태가 반영된 쪽을 남긴다', () => {
    const plain = twin({});
    const active = twin({ className: 'seatMap_seatNumber__x seatMap_active__z' });

    expect(toSeatState(dedupeSeats([plain, active])[0]!)).toBe('held');
    expect(toSeatState(dedupeSeats([active, plain])[0]!)).toBe('held');
  });

  it('서로 다른 좌석은 남긴다', () => {
    expect(dedupeSeats([twin({}), twin({ id: '2', label: 'A2' })])).toHaveLength(2);
  });
});

describe('실측 class 조합', () => {
  const seat = (className: string, disabled = false): RawCgvSeat => ({
    id: 'x', label: 'A1', className, title: '', disabled, x: 0, y: 0,
  });

  /** 판매완료에도 seatNormal 이 함께 붙는다. 순서를 잘못 보면 팔린 자리를 빈자리로 센다. */
  it('판매완료가 seatNormal 과 같이 와도 sold 로 본다', () => {
    expect(toSeatState(seat('seatMap_seatDisabled__a seatMap_seatNormal__b', true))).toBe('sold');
  });

  it('선택 가능한 좌석', () => {
    expect(toSeatState(seat('seatMap_seatNormal__a seatMap_seatNumber__b'))).toBe('free');
  });

  /** 스윗박스는 2석 묶음이라 값도 다르고 혼자 사기 어렵다. 장애인석도 마찬가지. */
  it('스윗박스와 장애인석은 기본적으로 뺀다', () => {
    expect(toSeatState(seat('seatMap_seatNumber__a seatMap_seatSweetbox__b'))).toBe('blocked');
    expect(toSeatState(seat('seatMap_seatNormal__a seatMap_seatPreferential__b'))).toBe('blocked');
  });

  it('원하면 켤 수 있다', () => {
    const rules = { ...CGV_SEAT_RULES, allowSweetbox: true };
    expect(toSeatState(seat('seatMap_seatNumber__a seatMap_seatSweetbox__b'), rules)).toBe('free');
  });
});

describe('스윗박스 라벨', () => {
  /** '연접좌석N5' 처럼 한글 접두어가 붙는다. 앞에서 맞추면 통째로 실패한다. */
  it('한글 접두어가 붙어도 행과 번호를 뽑는다', () => {
    expect(splitLabel('연접좌석N5')).toEqual({ row: 'N', col: 5 });
    expect(splitLabel('연접좌석N14')).toEqual({ row: 'N', col: 14 });
  });
});
