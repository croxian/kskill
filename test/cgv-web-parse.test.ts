import { describe, expect, it } from 'vitest';

import {
  CGV_KIND,
  parseSeatData,
  toSeatState,
  type CgvWebSeat,
} from '../src/adapters/cgv/web-parse.js';

/** 2026-08-10 영등포 5관(Laser) 실측 응답의 좌석 하나. */
const REAL: CgvWebSeat = {
  seatLocNo: '00100100390003',
  sbordNo: '001',
  seatAreaNo: '001',
  szoneNo: '02001',
  seatRowNm: 'B',
  seatNo: '18',
  stkndCd: '01',
  szoneKindCd: '02',
  seatSalfrmCd: '01',
  seatStusCd: '00',
  seatSaleYn: 'Y',
  salNo: '',
  movAtktNo: null,
  xcoordStartVal: '0039',
  ycoordStartVal: '0003',
  leftPwayYn: 'Y',
  rghtPwayYn: 'N',
};

const seat = (over: Partial<CgvWebSeat>): CgvWebSeat => ({ ...REAL, ...over });

const META = {
  theaterId: '0059',
  screenId: '005',
  playDate: '20260814',
  playSequence: '1',
};

describe('toSeatState', () => {
  it('실측 그대로면 빈자리다', () => {
    expect(toSeatState(REAL)).toBe('free');
  });

  it('판매 번호가 있으면 팔린 것', () => {
    expect(toSeatState(seat({ salNo: '20260810001' }))).toBe('sold');
  });

  it('예매 번호만 있으면 누가 잡고 있는 것', () => {
    expect(toSeatState(seat({ movAtktNo: '0059260810015642425' }))).toBe('held');
  });

  /**
   * 팔린 좌석의 실제 필드 조합을 아직 못 봤다. 모르는 상태를 빈자리로 세면
   * 없는 자리를 알리고, 최악의 경우 잡으러 갔다가 실패한다.
   * 모르면 찬 것으로 센다.
   */
  it('모르는 상태 코드는 빈자리로 세지 않는다', () => {
    expect(toSeatState(seat({ seatStusCd: '99' }))).toBe('sold');
    expect(toSeatState(seat({ seatStusCd: '10' }))).toBe('sold');
  });

  it('팔 수 없는 자리는 아예 제외', () => {
    expect(toSeatState(seat({ seatSaleYn: 'N' }))).toBe('blocked');
  });

  it('스윗박스는 기본으로 뺀다', () => {
    const sb = seat({ stkndCd: CGV_KIND.SWEETBOX });
    expect(toSeatState(sb)).toBe('blocked');
    expect(toSeatState(sb, { allowSweetbox: true })).toBe('free');
  });
});

describe('parseSeatData', () => {
  /**
   * 통로가 응답에 들어 있다. 픽셀 간격 중앙값으로 추측하던 것을 버릴 수 있다.
   * 리클라이너관에서 좌석 간격이 넓어 통로로 오해하던 문제도 같이 사라진다.
   */
  it('통로를 기준으로 구획을 나눈다', () => {
    const map = parseSeatData(
      {
        data: {
          items: [
            {
              seats: [
                seat({ seatLocNo: 'a', seatRowNm: 'A', seatNo: '1', xcoordStartVal: '0001', leftPwayYn: 'Y' }),
                seat({ seatLocNo: 'b', seatRowNm: 'A', seatNo: '2', xcoordStartVal: '0003', leftPwayYn: 'N' }),
                // 통로 건너
                seat({ seatLocNo: 'c', seatRowNm: 'A', seatNo: '3', xcoordStartVal: '0009', leftPwayYn: 'Y' }),
                seat({ seatLocNo: 'd', seatRowNm: 'A', seatNo: '4', xcoordStartVal: '0011', leftPwayYn: 'N' }),
              ],
            },
          ],
        },
      },
      META,
    );

    const g = Object.fromEntries(map.seats.map((s) => [s.id, s.group]));
    expect(g['a']).toBe(g['b']);
    expect(g['c']).toBe(g['d']);
    expect(g['a']).not.toBe(g['c']);
  });

  /** 줄의 첫 좌석은 왼쪽이 벽이든 통로든 새 구획이다. */
  it('줄마다 구획이 1부터 다시 센다', () => {
    const map = parseSeatData(
      {
        data: {
          items: [
            {
              seats: [
                seat({ seatLocNo: 'a1', seatRowNm: 'A', xcoordStartVal: '0001', leftPwayYn: 'N' }),
                seat({ seatLocNo: 'b1', seatRowNm: 'B', xcoordStartVal: '0001', leftPwayYn: 'N' }),
              ],
            },
          ],
        },
      },
      META,
    );
    expect(map.seats.every((s) => s.group === 1)).toBe(true);
  });

  it('구역이 여러 개면 합친다', () => {
    const map = parseSeatData(
      {
        data: {
          items: [
            { seats: [seat({ seatLocNo: 'x', seatRowNm: 'A' })] },
            { seats: [seat({ seatLocNo: 'y', seatRowNm: 'B' })] },
          ],
        },
      },
      META,
    );
    expect(map.seats).toHaveLength(2);
  });

  it('좌표와 행·열을 그대로 옮긴다', () => {
    const map = parseSeatData({ data: { items: [{ seats: [REAL] }] } }, META);
    const s = map.seats[0]!;
    expect(s).toMatchObject({ id: '00100100390003', row: 'B', col: 18, x: 39, y: 3 });
    expect(map.chain).toBe('cgv');
    expect(map.screenId).toBe('005');
  });

  it('좌석이 없어도 터지지 않는다', () => {
    expect(parseSeatData({}, META).seats).toEqual([]);
    expect(parseSeatData({ data: { items: [] } }, META).seats).toEqual([]);
  });
});
