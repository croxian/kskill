import type { Showtime } from '../../types.js';
import type { CgvScnItem } from './api.js';

/**
 * CGV 원본 응답 → 도메인 모델.
 *
 * daiso 를 거치지 않고 직접 부르면 필드가 훨씬 많이 온다. 실측 비교에서
 * daiso 는 용산 8/14 의 49개 회차 중 38개만 넘겼고, 상영관 정보도 통째로
 * 버렸다. 아래 매핑은 원본 필드를 그대로 쓴다.
 */

/**
 * 회차 고유 키는 (상영관, 회차순번) 이다.
 *
 * daiso 는 scheduleId 를 `scnYmd + siteNo + scnSseq` 로 조립하면서
 * **상영관을 빼먹었다.** 그래서 서로 다른 관의 같은 순번 회차가 한 ID 로
 * 뭉개졌다 — 실측에서 `2026081400131` 하나에 06:40·07:00·07:30 이
 * 붙어 있었고 좌석 수도 190·201·624 로 제각각이었다.
 * scnsNo 를 넣으면 해결된다.
 */
export function parseCgvTimetable(items: CgvScnItem[]): Showtime[] {
  return items
    .filter((i) => i.siteNo && i.scnYmd && i.scnsrtTm)
    .map((i) => ({
      chain: 'cgv' as const,
      theaterId: String(i.siteNo),
      theaterName: stripPrefix(i.siteNm ?? ''),
      movieId: String(i.movNo ?? ''),
      movieName: i.movNm ?? i.prodNm ?? '',
      screenId: String(i.scnsNo ?? ''),
      screenName: i.scnsNm ?? '',
      playDate: String(i.scnYmd),
      playSequence: String(i.scnSseq ?? ''),
      startTime: formatTime(i.scnsrtTm),
      divisionCode: '*',
      totalSeats: num(i.stcnt),
      // frSeatCnt 는 이름 그대로 판매 가능 좌석 수다. 롯데의 BookingSeatCount 와
      // 달리 뒤집혀 있지 않다. 금요일 프라임타임 IMAX(18:00)가 0 인 게 근거다 —
      // "예매된 수 0" 이면 한 장도 안 팔렸다는 뜻이 되는데 말이 안 된다.
      remainingSeats: num(i.frSeatCnt ?? i.frtmpSeatCnt),
      ...(i.salEndTm ? { salesEndAt: formatTime(i.salEndTm) } : {}),
    }));
}

/**
 * 판매 종료 시각.
 *
 * CGV 는 `salEndTm` 으로 언제까지 팔지를 직접 알려준다 (실측: 18:00 회차의
 * salEndTm 이 18:15 — 상영 시작 15분 뒤까지 판매).
 * "상영 30분 전에 감시를 접는다" 같은 어림짐작보다 이 값이 정확하다.
 */
export function saleEndsAt(item: CgvScnItem): string | undefined {
  return item.salEndTm ? formatTime(item.salEndTm) : undefined;
}

/**
 * 특별관 판별.
 *
 * `scnsNm` 에 관 종류가 들어 있다 — "1관 (Laser)", "IMAX관" 같은 식이다.
 * 좌석 수로 지문을 삼는 것보다 안전하다. 좌석 수는 좌석 재배치가 있으면 바뀐다.
 */
export function isSpecialScreen(screenName: string, kind: RegExp): boolean {
  return kind.test(screenName);
}

export const SCREEN_KIND = {
  IMAX: /IMAX/i,
  FOURDX: /4DX/i,
  SCREENX: /SCREENX/i,
  LASER: /Laser/i,
  GOLD: /GOLD\s*CLASS|프리미엄/i,
} as const;

/** 스펙의 screens 에 넣을 상영관 번호를 이름으로 찾는다. */
export function screensMatching(showtimes: Showtime[], kind: RegExp): string[] {
  return [
    ...new Set(
      showtimes.filter((s) => isSpecialScreen(s.screenName, kind)).map((s) => s.screenId),
    ),
  ];
}

/** '0730' → '07:30'. 24 를 넘는 심야 표기도 그대로 살린다 (CGV 에 25:00 이 있다). */
function formatTime(raw: unknown): string {
  const s = String(raw ?? '').padStart(4, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

/** 'CGV 용산아이파크몰' → '용산아이파크몰'. 예매 화면의 지점 링크와 맞추기 위해서다. */
function stripPrefix(name: string): string {
  return name.replace(/^CGV\s*/, '').trim();
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
