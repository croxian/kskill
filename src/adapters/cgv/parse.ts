import type { Showtime } from '../../types.js';
import type { CgvScnItem } from './api.js';

/**
 * CGV 원본 응답 → 도메인 모델.
 *
 * 롯데와 다른 점이 두 가지 있고, 둘 다 여기서 흡수한다.
 */

/**
 * ⚠️ CGV 는 회차 고유 식별자를 주지 않는다.
 *
 * 실측(용산 8/14): daiso 가 만든 scheduleId `2026081400131` 하나에
 * 06:40 · 06:50 · 07:00 · 07:25 · 07:30 다섯 회차가 붙어 있었고,
 * 좌석 수도 190·134·201·142·624 로 제각각이라 상영관 번호도 아니었다.
 *
 * 그래서 시작 시각을 회차 키로 쓴다. 한 상영관에서 같은 시각에 두 편을
 * 틀 수는 없으므로 (지점, 날짜, 상영관, 시작시각) 이면 충분히 고유하다.
 * 브라우저로 좌석을 잡을 때도 시작 시각으로 회차를 클릭하므로 일관된다.
 */
export function parseCgvTimetable(items: CgvScnItem[]): Showtime[] {
  return items
    .filter((i) => i.siteNo && i.scnYmd && i.scnsrtTm)
    .map((i) => {
      const total = num(i.stcnt);
      return {
        chain: 'cgv' as const,
        theaterId: String(i.siteNo),
        theaterName: stripPrefix(i.siteNm ?? ''),
        movieId: String(i.movNo ?? ''),
        movieName: i.movNm ?? i.prodNm ?? '',
        screenId: screenFingerprint(total),
        screenName: `${total}석`,
        playDate: String(i.scnYmd),
        // 회차 번호가 없으므로 시작 시각이 그 역할을 한다.
        playSequence: formatTime(i.scnsrtTm),
        startTime: formatTime(i.scnsrtTm),
        divisionCode: '*',
        totalSeats: total,
        // frSeatCnt 는 이름 그대로 판매 가능 좌석 수다. 롯데처럼 뒤집혀 있지 않다.
        // 근거: 금요일 프라임타임 IMAX(18:00)가 0 이었다. "예매된 수 0" 이면
        // 한 장도 안 팔렸다는 뜻이 되는데 말이 안 된다.
        remainingSeats: num(i.frSeatCnt ?? i.frtmpSeatCnt),
      };
    });
}

/**
 * 상영관 지문.
 *
 * CGV 응답에 상영관 이름이 없어서 좌석 수로 구분한다. 한 지점 안에서
 * 상영관마다 좌석 수가 다르므로 충분히 갈린다.
 * 용산아이파크몰 실측: 624(IMAX) · 204 · 201 · 200 · 190 · 142 · 134
 *
 * 원본에 상영관 이름 필드가 있는 것으로 확인되면 그걸로 갈아탄다 —
 * 좌석 수는 좌석 재배치가 있으면 바뀔 수 있는 값이다.
 */
export function screenFingerprint(totalSeats: number): string {
  return String(totalSeats);
}

/** 감시 스펙에서 IMAX 만 보려면 screens 에 이 값을 넣는다. */
export const YONGSAN_IMAX = screenFingerprint(624);

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
