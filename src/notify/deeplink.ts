import type { Showtime } from '../types.js';

/**
 * 회차로 바로 가는 링크.
 *
 * 알림에서 가장 중요한 건 예쁜 포맷이 아니라 **손가락이 움직이는 거리**다.
 * 알림을 보고 앱을 열어 지점을 찾고 회차를 고르는 30초 동안 자리는 사라진다.
 *
 * ⚠️ 회차 단위 딥링크는 아직 실측하지 않았다.
 * GetPlaySequence / GetSeats 와 달리 이건 XHR 이 아니라 화면 주소라서
 * DevTools 캡처에 잡히지 않았다. 확인 방법:
 *
 *   1. 예매 화면에서 좌석 선택 단계까지 진입
 *   2. 주소창 URL 을 복사
 *   3. 회차마다 달라지는 조각(지점·상영관·회차 코드)을 찾아 아래 템플릿에 넣는다
 *   4. LOTTE_DEEPLINK 환경변수로 주입
 *
 * 템플릿에서 치환되는 것:
 *   {theaterId} {screenId} {playDate} {playDateDash} {playSequence} {movieId}
 *
 * 템플릿이 없으면 예매 첫 화면으로 보낸다. 링크가 없는 것보다는 낫고,
 * 잘못된 링크를 보내는 것보다는 훨씬 낫다.
 */

export const LOTTE_TICKETING_URL = 'https://www.lottecinema.co.kr/NLCHS/Ticketing';
export const CGV_TICKETING_URL = 'https://cgv.co.kr/cnm/movieBook';

/**
 * 체인마다 예매 첫 화면이 다르다.
 *
 * 이걸 안 나눠서 CGV 알림에 롯데 링크가 붙어 나갔다. 자리가 났다는 알림을
 * 받고 눌렀는데 다른 극장 예매 화면이 열리면 아무 쓸모가 없다.
 */
export function ticketingUrl(chain: string): string {
  return chain === 'cgv' ? CGV_TICKETING_URL : LOTTE_TICKETING_URL;
}

export function buildDeepLink(s: Showtime, template?: string): string {
  if (!template) return ticketingUrl(s.chain);

  const dash = `${s.playDate.slice(0, 4)}-${s.playDate.slice(4, 6)}-${s.playDate.slice(6, 8)}`;
  const vars: Record<string, string> = {
    theaterId: s.theaterId,
    screenId: s.screenId,
    playDate: s.playDate,
    playDateDash: dash,
    playSequence: s.playSequence,
    movieId: s.movieId,
  };

  return template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

/** 템플릿에 우리가 채울 수 없는 자리표시자가 남아 있으면 잡아낸다. */
export function unresolvedVars(template: string): string[] {
  const known = new Set([
    'theaterId',
    'screenId',
    'playDate',
    'playDateDash',
    'playSequence',
    'movieId',
  ]);
  return [...template.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1]!)
    .filter((k) => !known.has(k));
}
