import type { Page } from 'playwright';

import type { Seat, SeatMap, SeatState } from '../../types.js';

/**
 * CGV 좌석맵을 브라우저 DOM 에서 읽는다.
 *
 * CGV 는 좌석 조회 API 에 서명이 필요하고 직접 호출이 막힌다. 그런데 어차피
 * 좌석을 잡으려면 브라우저를 띄워야 하므로, 그 화면에서 그대로 읽는다.
 * 서명 문제를 통째로 우회하고, 화면과 데이터가 어긋날 일도 없다.
 *
 * 좌석 하나는 이렇게 생겼다:
 *   <button data-seatlocno="00100100110023"
 *           class="seatMap_seatNumber__JHck5 seatMap_seatNormal__SojfU …"
 *           title="선택됨" style="top:456px; left:228px">
 *     <span>L5</span>
 *   </button>
 *
 * ⚠️ class 이름 뒤의 해시(`__JHck5`)는 CGV 가 빌드할 때마다 바뀐다.
 * 통째로 매칭하면 어느 날 조용히 좌석을 못 찾는다. 접두어만 본다.
 */

/** 좌석 하나에서 긁어낸 원본. 상태 판정 전 단계다. */
export interface RawCgvSeat {
  id: string;
  label: string;
  className: string;
  title: string;
  disabled: boolean;
  x: number;
  y: number;
}

/** 브라우저 안에서 실행되는 추출기. 좌석 요소를 찾아 필요한 것만 뽑는다. */
export const SEAT_ATTR = 'data-seatlocno';

export async function readRawSeats(page: Page): Promise<RawCgvSeat[]> {
  return page.$$eval(`[${SEAT_ATTR}]`, (els) =>
    els.map((el) => {
      const style = (el as HTMLElement).style;
      return {
        id: el.getAttribute('data-seatlocno') ?? '',
        label: (el.textContent ?? '').trim(),
        className: el.className ?? '',
        title: el.getAttribute('title') ?? '',
        disabled: (el as HTMLButtonElement).disabled === true,
        x: Number.parseFloat(style.left || '0'),
        y: Number.parseFloat(style.top || '0'),
      };
    }),
  );
}

/**
 * 상태 판정 규칙.
 *
 * class 접두어와 title 을 함께 본다. 어느 쪽이 신뢰할 만한지는 실측으로
 * 정해야 하므로 규칙을 밖에서 갈아끼울 수 있게 뒀다.
 */
export interface CgvSeatRules {
  /** 이 접두어가 class 에 있으면 살 수 있는 좌석 */
  freeClass: string;
  /** 이미 팔린 좌석 */
  soldClass: string;
  /** 지금 내가 고른 좌석. free 로 세면 잔여수가 부풀려진다. */
  activeClass: string;
  /** class 로 못 가리면 title 로 본다. */
  freeTitle?: RegExp;
  soldTitle?: RegExp;
}

/**
 * 실측 전 초기값.
 *
 * seatNormal 과 active 는 확인했다 — L5 를 선택한 상태의 요소에서 나왔다.
 * 판매완료 좌석의 class 는 아직 모른다. scripts/cgv-seatmap.ts 로 확인한다.
 */
export const CGV_SEAT_RULES: CgvSeatRules = {
  freeClass: 'seatMap_seatNormal',
  soldClass: 'seatMap_seatDisabled', // ← 실측 필요
  activeClass: 'seatMap_active',
  soldTitle: /판매완료|예매완료|선택불가/,
};

export function toSeatState(raw: RawCgvSeat, rules = CGV_SEAT_RULES): SeatState {
  if (raw.className.includes(rules.activeClass)) return 'held'; // 내가 잡은 것
  if (raw.className.includes(rules.soldClass)) return 'sold';
  if (rules.soldTitle?.test(raw.title)) return 'sold';
  if (raw.disabled) return 'blocked';
  if (raw.className.includes(rules.freeClass)) return 'free';
  return 'blocked';
}

/** 'L5' → { row: 'L', col: 5 } */
export function splitLabel(label: string): { row: string; col: number } {
  const m = label.match(/^([A-Za-z]+)(\d+)$/);
  return m ? { row: m[1]!.toUpperCase(), col: Number(m[2]) } : { row: label, col: 0 };
}

/**
 * 통로 구획을 좌표로 나눈다.
 *
 * 롯데는 SeatColumGroupNo 로 구획을 알려주지만 CGV 는 그런 게 없다.
 * 다행히 좌석마다 픽셀 좌표가 있어서 간격으로 끊을 수 있다 —
 * 좌석 폭(38px)보다 눈에 띄게 벌어지면 통로다.
 */
export function assignGroups(seats: Seat[]): Seat[] {
  const byRow = new Map<string, Seat[]>();
  for (const s of seats) {
    const bucket = byRow.get(s.row);
    if (bucket) bucket.push(s);
    else byRow.set(s.row, [s]);
  }

  for (const rowSeats of byRow.values()) {
    rowSeats.sort((a, b) => a.x - b.x);
    const gaps: number[] = [];
    for (let i = 1; i < rowSeats.length; i++) gaps.push(rowSeats[i]!.x - rowSeats[i - 1]!.x);
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)] ?? 1;

    let group = 1;
    for (let i = 0; i < rowSeats.length; i++) {
      if (i > 0 && rowSeats[i]!.x - rowSeats[i - 1]!.x > median * 1.6) group++;
      rowSeats[i]!.group = group;
    }
  }
  return seats;
}

export async function readSeatMap(
  page: Page,
  meta: { theaterId: string; screenId: string; playDate: string; playSequence: string },
  rules = CGV_SEAT_RULES,
): Promise<SeatMap> {
  const raw = await readRawSeats(page);

  const seats: Seat[] = raw
    .filter((r) => r.id)
    .map((r) => {
      const { row, col } = splitLabel(r.label);
      return {
        id: r.id,
        row,
        col,
        x: r.x,
        y: r.y,
        group: 1, // assignGroups 가 채운다
        state: toSeatState(r, rules),
      };
    });

  return {
    chain: 'cgv',
    ...meta,
    seats: assignGroups(seats),
    fetchedAt: Date.now(),
  };
}
