import type { Seat, SeatMap, SeatState } from '../../types.js';

/**
 * searchIfSeatData 응답을 좌석맵으로 옮긴다.
 *
 * DOM 에서 긁던 것보다 훨씬 낫다. 특히 **통로가 명시되어 있다** —
 * leftPwayYn/rghtPwayYn 이 좌석 좌우의 통로를 그대로 알려준다.
 * 픽셀 간격의 중앙값으로 통로를 추측하던 것을 버릴 수 있다.
 * 리클라이너관에서 좌석 간격이 넓어 통로로 오해하던 문제도 같이 사라진다.
 *
 * 2026-08-10 영등포 5관(Laser) 320석 실측.
 */

export interface CgvWebSeat {
  seatLocNo: string;
  sbordNo: string;
  seatAreaNo: string;
  szoneNo: string;
  seatRowNm: string;
  seatNo: string;
  /** 좌석 종류. 01 일반석, 02 SWEETBOX */
  stkndCd: string;
  /** 존 종류. 01 일반존, 02 Light존 */
  szoneKindCd: string;
  /** 판매 형태. 01 일반, 04 이동식 */
  seatSalfrmCd: string;
  /** 좌석 상태 코드. 00 = 미정(= 아직 아무도 안 잡음) */
  seatStusCd: string;
  /** 팔 수 있는 자리인가 */
  seatSaleYn: string;
  /** 판매 번호. 차 있으면 팔린 것이다. */
  salNo?: string | null;
  /** 임시 점유 번호. 차 있으면 누가 잡고 있다. */
  movAtktNo?: string | null;
  xcoordStartVal: string;
  ycoordStartVal: string;
  /** 이 좌석 왼쪽이 통로인가 */
  leftPwayYn: string;
  /** 오른쪽이 통로인가 */
  rghtPwayYn: string;
}

export interface CgvSeatDataResponse {
  data?: {
    siteNo?: string;
    scnsNo?: string;
    scnYmd?: string;
    items?: { seats?: CgvWebSeat[] }[];
  };
}

/** 좌석 종류 코드. */
export const CGV_KIND = { GENERAL: '01', SWEETBOX: '02' } as const;
/** 아직 아무도 안 잡은 상태. */
export const CGV_STATUS_FREE = '00';

export interface CgvSeatOpts {
  /** 2석 묶음 커플석. 값도 다르고 혼자 사기 어렵다. */
  allowSweetbox?: boolean;
  /** 일반석이 아닌 종류를 전부 받을 것인가. 장애인석 등이 여기 들어온다. */
  allowSpecialKinds?: boolean;
}

/**
 * 좌석 상태.
 *
 * 팔린 좌석의 실제 필드 조합은 아직 못 봤다 — 실측 응답에 보인 320석 중
 * 표본으로 남은 둘이 모두 빈자리였다. 그래서 **빈자리의 모양을 정확히
 * 알 때만 free 라고 한다.** 모르는 조합은 찬 것으로 센다.
 *
 * 틀렸다면 조용히 넘어가지 않는다. main.ts 의 crossCheck 가 좌석맵의
 * 빈자리 수와 회차 잔여수(frSeatCnt)를 견줘서 어긋나면 경고한다.
 */
export function toSeatState(s: CgvWebSeat, opts: CgvSeatOpts = {}): SeatState {
  if (s.stkndCd === CGV_KIND.SWEETBOX && !opts.allowSweetbox) return 'blocked';
  if (s.stkndCd !== CGV_KIND.GENERAL && !opts.allowSweetbox && !opts.allowSpecialKinds) {
    return 'blocked';
  }
  if (s.seatSaleYn !== 'Y') return 'blocked';

  // 판매 번호가 있으면 팔린 것, 예매 번호만 있으면 누가 잡고 있는 것.
  if (s.salNo) return 'sold';
  if (s.movAtktNo) return 'held';
  if (s.seatStusCd !== CGV_STATUS_FREE) return 'sold';
  return 'free';
}

/**
 * 통로로 구획을 나눈다.
 *
 * 한 줄을 x 순으로 훑다가 왼쪽이 통로인 좌석을 만나면 새 구획을 연다.
 * 롯데의 SeatColumGroupNo 와 같은 역할이고, 정확도는 이쪽이 더 높다 —
 * 추측이 아니라 극장이 알려주는 값이다.
 */
export function assignGroups(seats: Seat[], pway: Map<string, boolean>): Seat[] {
  const byRow = new Map<string, Seat[]>();
  for (const s of seats) {
    const bucket = byRow.get(s.row);
    if (bucket) bucket.push(s);
    else byRow.set(s.row, [s]);
  }

  for (const rowSeats of byRow.values()) {
    rowSeats.sort((a, b) => a.x - b.x);
    let group = 0;
    for (const [i, seat] of rowSeats.entries()) {
      // 줄의 첫 좌석은 언제나 새 구획을 연다. 왼쪽이 통로든 벽이든 같다.
      if (i === 0 || pway.get(seat.id)) group++;
      seat.group = group;
    }
  }
  return seats;
}

export function parseSeatData(
  res: CgvSeatDataResponse,
  meta: { theaterId: string; screenId: string; playDate: string; playSequence: string },
  opts: CgvSeatOpts = {},
): SeatMap {
  // items 는 상영관을 구역으로 쪼갠 것이다. 한 관에 하나뿐인 게 보통이지만
  // 여러 개 와도 전부 합친다 — 롯데의 divisionCode 와 같은 상황이다.
  const raw = (res.data?.items ?? []).flatMap((i) => i.seats ?? []);

  const pway = new Map<string, boolean>();
  const seats: Seat[] = raw.map((r) => {
    pway.set(r.seatLocNo, r.leftPwayYn === 'Y');
    return {
      id: r.seatLocNo,
      row: r.seatRowNm,
      col: Number(r.seatNo),
      x: Number(r.xcoordStartVal),
      y: Number(r.ycoordStartVal),
      group: 1, // assignGroups 가 채운다
      state: toSeatState(r, opts),
    };
  });

  return {
    chain: 'cgv',
    ...meta,
    seats: assignGroups(seats, pway),
    fetchedAt: Date.now(),
  };
}
