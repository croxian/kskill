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
 * 실측 결과 title 은 거의 비어 있다 (400개 중 398개가 빈 값). class 로만 본다.
 *
 *   seatMap_seatNormal                          선택 가능      230
 *   seatMap_seatDisabled + seatMap_seatNormal   판매완료       144
 *   seatMap_seatSweetbox                        스윗박스 2연석  20
 *   seatMap_seatPreferential                    장애인석         4
 *   seatMap_active                              내가 고른 것
 *
 * 주의: 판매완료 좌석에도 seatMap_seatNormal 이 함께 붙는다.
 * disabled 를 먼저 보지 않으면 팔린 자리를 빈자리로 센다.
 */
export interface CgvSeatRules {
  freeClass: string;
  soldClass: string;
  /** 지금 내가 고른 좌석. free 로 세면 잔여수가 부풀려진다. */
  activeClass: string;
  /** 2석 묶음 커플석. 값도 다르고 혼자 사기 어렵다. */
  sweetboxClass: string;
  /** 장애인석. 비어 있어도 아무나 살 자리가 아니다. */
  preferentialClass: string;
  /** 기본은 제외. 원하면 켠다. */
  allowSweetbox?: boolean;
  allowPreferential?: boolean;
}

export const CGV_SEAT_RULES: CgvSeatRules = {
  freeClass: 'seatMap_seatNormal',
  soldClass: 'seatMap_seatDisabled',
  activeClass: 'seatMap_active',
  sweetboxClass: 'seatMap_seatSweetbox',
  preferentialClass: 'seatMap_seatPreferential',
};

export function toSeatState(raw: RawCgvSeat, rules = CGV_SEAT_RULES): SeatState {
  const cls = raw.className;

  if (cls.includes(rules.activeClass)) return 'held';
  // 판매완료에도 seatNormal 이 붙으므로 이걸 먼저 봐야 한다.
  if (cls.includes(rules.soldClass) || raw.disabled) return 'sold';
  if (cls.includes(rules.sweetboxClass)) return rules.allowSweetbox ? 'free' : 'blocked';
  if (cls.includes(rules.preferentialClass)) {
    return rules.allowPreferential ? 'free' : 'blocked';
  }
  if (cls.includes(rules.freeClass)) return 'free';
  return 'blocked';
}

/**
 * 라벨에서 행과 번호를 뽑는다.
 *
 * 스윗박스는 '연접좌석N5' 처럼 한글 접두어가 붙는다. 앞에서부터 맞추면
 * 통째로 실패해 row 가 '연접좌석N5', col 이 0 이 된다.
 * 뒤에서 '문자+숫자' 만 집어낸다.
 */
export function splitLabel(label: string): { row: string; col: number } {
  const m = label.match(/([A-Za-z]+)\s*(\d+)\s*$/);
  return m ? { row: m[1]!.toUpperCase(), col: Number(m[2]) } : { row: label, col: 0 };
}

/**
 * 같은 좌석이 두 번 잡히는 걸 걸러낸다.
 *
 * CGV 좌석맵은 DOM 에 좌석을 두 벌 렌더한다 — 실측에서 200석짜리 관이
 * 400개로 잡혔고 x 간격에 0 이 반복됐다. 그대로 두면 잔여수가 정확히
 * 두 배가 되고, 연석 판정도 같은 자리를 두 번 세서 무너진다.
 *
 * 두 벌 중 상태가 반영된 쪽(선택됨 등)을 남긴다.
 */
export function dedupeSeats(raw: RawCgvSeat[]): RawCgvSeat[] {
  const byId = new Map<string, RawCgvSeat>();
  for (const r of raw) {
    const key = r.id || `${r.label}@${r.x},${r.y}`;
    const prev = byId.get(key);
    const better =
      !prev ||
      (!prev.className.includes('seatMap_active') && r.className.includes('seatMap_active'));
    if (better) byId.set(key, r);
  }
  return [...byId.values()];
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
  const raw = dedupeSeats(await readRawSeats(page));

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
