import { describe, expect, it, vi } from 'vitest';

import { cgvShowtimeKey } from '../src/adapters/cgv/api.js';
import { createCgvAdapter } from '../src/adapters/cgv/adapter.js';
import { sign } from '../src/adapters/cgv/client.js';
import {
  parseCgvTimetable,
  saleEndsAt,
  SCREEN_KIND,
  screensMatching,
} from '../src/adapters/cgv/parse.js';
import { collapseDivisions, seatMapKey } from '../src/core/diff.js';
import { matchesSpec, type WatchSpec } from '../src/core/spec.js';

/**
 * 2026-08-14 CGV 용산아이파크몰(0013) 직접 호출 응답에서 옮긴 것.
 *
 * 06:40 과 07:00 은 서로 다른 관인데 scnSseq 가 둘 다 '1' 이다.
 * daiso 가 상영관을 빼고 키를 만들어 뭉갰던 바로 그 케이스다.
 */
const RAW = [
  { siteNo: '0013', siteNm: 'CGV 용산아이파크몰', scnsNo: '003', scnsNm: '3관 (Laser)',  scnYmd: '20260814', scnSseq: '1', movNo: '30001323', movNm: '오디세이',   scnsrtTm: '0640', salEndTm: '0655', stcnt: 190, frSeatCnt: 174 },
  { siteNo: '0013', siteNm: 'CGV 용산아이파크몰', scnsNo: '005', scnsNm: '5관 (Laser)',  scnYmd: '20260814', scnSseq: '1', movNo: '30001192', movNm: '스파이더맨', scnsrtTm: '0700', salEndTm: '0715', stcnt: 201, frSeatCnt: 192 },
  { siteNo: '0013', siteNm: 'CGV 용산아이파크몰', scnsNo: '002', scnsNm: 'IMAX관',       scnYmd: '20260814', scnSseq: '1', movNo: '30001323', movNm: '오디세이',   scnsrtTm: '0730', salEndTm: '0745', stcnt: 624, frSeatCnt: 6 },
  { siteNo: '0013', siteNm: 'CGV 용산아이파크몰', scnsNo: '002', scnsNm: 'IMAX관',       scnYmd: '20260814', scnSseq: '4', movNo: '30001323', movNm: '오디세이',   scnsrtTm: '1800', salEndTm: '1815', stcnt: 624, frSeatCnt: 0 },
  { siteNo: '0013', siteNm: 'CGV 용산아이파크몰', scnsNo: '002', scnsNm: 'IMAX관',       scnYmd: '20260814', scnSseq: '6', movNo: '30001323', movNm: '오디세이',   scnsrtTm: '2500', salEndTm: '2515', stcnt: 624, frSeatCnt: 6 },
];

describe('parseCgvTimetable', () => {
  const rows = parseCgvTimetable(RAW);

  it('시간을 HH:mm 으로 맞춘다', () => {
    expect(rows.map((r) => r.startTime)).toEqual(['06:40', '07:00', '07:30', '18:00', '25:00']);
  });

  /** CGV 에도 자정 넘김이 있다. 25:00 을 01:00 으로 접으면 심야 회차가 통째로 빠진다. */
  it('24 를 넘는 심야 표기를 그대로 살린다', () => {
    expect(rows.find((r) => r.startTime === '25:00')).toBeDefined();
  });

  it('지점명에서 CGV 접두어를 뗀다', () => {
    // 예매 화면의 지점 링크 이름과 맞춰야 브라우저가 클릭할 수 있다
    expect(rows[0]!.theaterName).toBe('용산아이파크몰');
  });

  it('상영관 번호와 이름을 원본에서 그대로 가져온다', () => {
    const imax = rows.find((r) => r.startTime === '07:30')!;
    expect(imax.screenId).toBe('002');
    expect(imax.screenName).toBe('IMAX관');
  });

  /**
   * frSeatCnt 는 롯데의 BookingSeatCount 와 달리 뒤집혀 있지 않다.
   * 금요일 프라임타임 IMAX(18:00)가 0 인 게 근거다 — "예매된 수 0" 이면
   * 한 장도 안 팔렸다는 뜻이 되는데 말이 안 된다.
   */
  it('frSeatCnt 를 잔여석으로 그대로 읽는다', () => {
    const prime = rows.find((r) => r.startTime === '18:00')!;
    expect(prime.remainingSeats).toBe(0);
    expect(prime.totalSeats).toBe(624);
  });

  /** 상영 시작 뒤에도 잠깐 판다. "30분 전 중단" 같은 어림짐작보다 정확하다. */
  it('판매 종료 시각을 읽는다', () => {
    expect(saleEndsAt(RAW[3]!)).toBe('18:15');
    expect(saleEndsAt({ siteNo: '0013' })).toBeUndefined();
  });
});

describe('회차 식별', () => {
  /**
   * daiso 는 scheduleId 를 `scnYmd + siteNo + scnSseq` 로 만들면서 상영관을
   * 빼먹었다. 아래 세 회차는 전부 scnSseq '1' 이라 그 방식으로는 하나로 뭉개진다.
   */
  it('상영관이 다르면 같은 scnSseq 라도 다른 회차다', () => {
    const rows = parseCgvTimetable(RAW.slice(0, 3));
    expect(new Set(rows.map(seatMapKey)).size).toBe(3);
  });

  it('같은 상영관 안에서는 순번으로 갈린다', () => {
    const imax = parseCgvTimetable(RAW.filter((r) => r.scnsNo === '002'));
    expect(new Set(imax.map(seatMapKey)).size).toBe(3);
  });

  it('구역 병합이 CGV 회차를 뭉개지 않는다', () => {
    // 롯데는 한 회차가 구역별로 쪼개져 오지만 CGV 는 그렇지 않다.
    expect(collapseDivisions(parseCgvTimetable(RAW))).toHaveLength(5);
  });

  it('키 헬퍼가 상영관을 포함한다', () => {
    expect(cgvShowtimeKey('0013', '20260814', '002', '4')).toBe('0013:20260814:002:4');
  });
});

describe('특별관 고르기', () => {
  const rows = parseCgvTimetable(RAW);

  /** scnsNm 에 관 종류가 들어 있다. 좌석 수를 지문으로 쓰는 것보다 안전하다. */
  it('상영관 이름으로 IMAX 를 찾는다', () => {
    expect(screensMatching(rows, SCREEN_KIND.IMAX)).toEqual(['002']);
    expect(screensMatching(rows, SCREEN_KIND.LASER).sort()).toEqual(['003', '005']);
  });

  it('찾은 상영관 번호로 감시를 좁힌다', () => {
    const spec = {
      screens: screensMatching(rows, SCREEN_KIND.IMAX),
      movies: [],
      windows: [],
    } as unknown as WatchSpec;

    const imax = rows.filter((r) => matchesSpec(r, spec));
    expect(imax).toHaveLength(3);
    expect(imax.every((r) => r.screenName === 'IMAX관')).toBe(true);
  });
});

describe('서명', () => {
  /** base64( HMAC-SHA256( secret, `${ts}|${path}|${body}` ) ) */
  it('타임스탬프·경로·본문을 파이프로 이어 서명한다', () => {
    const a = sign('/cnm/atkt/searchMovScnInfo', '', '1000');
    const b = sign('/cnm/atkt/searchMovScnInfo', '', '1001');
    const c = sign('/cnm/atkt/searchRegnList', '', '1000');

    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(a).not.toBe(b); // 타임스탬프가 바뀌면 서명도 바뀐다
    expect(a).not.toBe(c); // 경로가 바뀌어도
  });
});

describe('createCgvAdapter — 전송 경로', () => {
  const theaters = [{ chain: 'cgv' as const, theaterId: '0013' }];
  const ok = { data: RAW };

  it('직접 호출이 되면 브라우저를 쓰지 않는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(ok) })),
    );
    const cgv = createCgvAdapter(theaters);

    expect(await cgv.listShowtimes(0, '20260814')).toHaveLength(5);
    expect(cgv.transport).toBe('direct');
    vi.unstubAllGlobals();
  });

  /**
   * 브라우저처럼 보이는 헤더를 붙이면 통과하지만, 언제 다시 막힐지 모른다.
   * 403 을 겪으면 브라우저로 넘어가고 폴링마다 실패할 요청을 반복하지 않는다.
   */
  it('403 을 겪으면 브라우저로 넘어가 결과를 돌려준다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, text: async () => '' })),
    );
    const siteTimetable = vi.fn(async () => RAW);
    const cgv = createCgvAdapter(theaters, {
      browserClient: { siteTimetable, close: async () => {} },
    });

    expect(await cgv.listShowtimes(0, '20260814')).toHaveLength(5);
    expect(cgv.transport).toBe('browser');
    expect(siteTimetable).toHaveBeenCalledWith('0013', '20260814');
    vi.unstubAllGlobals();
  });

  it('한 번 갈아탄 뒤에는 직접 호출을 다시 시도하지 않는다', async () => {
    const direct = vi.fn(async () => ({ ok: false, status: 403, text: async () => '' }));
    vi.stubGlobal('fetch', direct);

    const cgv = createCgvAdapter(theaters, {
      browserClient: { siteTimetable: async () => RAW, close: async () => {} },
    });
    await cgv.listShowtimes(0, '20260814');
    await cgv.listShowtimes(0, '20260814');
    await cgv.listShowtimes(0, '20260814');

    expect(direct).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('403 이 아닌 오류는 삼키지 않는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })),
    );
    const cgv = createCgvAdapter(theaters, {
      browserClient: { siteTimetable: async () => RAW, close: async () => {} },
    });

    await expect(cgv.listShowtimes(0, '20260814')).rejects.toThrow(/500/);
    expect(cgv.transport).toBe('direct');
    vi.unstubAllGlobals();
  });

  it('없는 지점 인덱스는 조용히 넘어가지 않는다', async () => {
    await expect(createCgvAdapter(theaters).listShowtimes(9, '20260814')).rejects.toThrow(
      /지점 인덱스/,
    );
  });
});
