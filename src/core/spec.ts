import type { Chain, Showtime } from '../types.js';
import type { SeatBlock } from './block.js';
import type { PartySpec } from './runs.js';

/**
 * 감시 스펙.
 *
 * "특정 상영관·영화·시간대를 전부 멀티 체크"는 UI 문제가 아니라 자료구조 문제다.
 * 각 축을 배열로 두고 **축 사이는 AND, 축 안은 OR** 로 정의하면
 * 조합 폭발 없이 정리된다.
 */

export interface TheaterRef {
  chain: Chain;
  theaterId: string;
  /** 체인이 조회 축을 따로 요구할 때 쓴다 (롯데 cinemaID 앞 두 조각). */
  region?: { division: string; detail: string };
  label?: string;
}

/** 'HH:mm'. 심야 회차는 24 를 넘어간다 — 롯데 실측에 24:35, 종료 25:42 가 있다. */
export interface TimeWindow {
  from: string;
  to: string;
}

export interface WatchSpec {
  id: string;

  // ── 축: 서로 AND, 배열 안은 OR ──────────────────────────────
  theaters: TheaterRef[];
  /** 영화 코드. 비우면 전 상영작. 요청 수에는 영향이 없다. */
  movies: string[];
  /** KST 'YYYYMMDD' */
  dates: string[];
  /** 시작 시각 기준. 비우면 전 시간대. */
  windows: TimeWindow[];
  /** 상영관 번호로 좁히기. 번호는 극장마다 달라서 여러 지점을 볼 땐 위험하다. */
  screens?: string[];
  /**
   * 상영관 **이름**으로 좁히기. 여러 지점을 감시할 땐 이쪽을 써야 한다.
   *
   * CGV 실측: IMAX 관 번호가 용산은 018, 영등포는 017 이다. 그런데 용산의
   * 017 은 박찬욱관이라, 번호 목록으로 두 IMAX 를 잡으려 하면 엉뚱한 관이
   * 딸려온다. 이름은 두 곳 다 "IMAX관" 으로 같다.
   */
  screenPattern?: string;

  /**
   * 회차를 딱 집어서 보기. `"지점:상영관:회차순번"` 형식.
   *
   *   ["0013:018:4", "0059:017:3"]   용산 IMAX 4회차, 영등포 IMAX 3회차
   *
   * 조건을 넓게 걸면 그 지점·날짜의 회차 수십 개가 다 잡힌다. 요청량은
   * 같지만 — 한 번 조회에 전 회차가 오므로 — 알림이 쏟아진다. 볼 회차가
   * 정해져 있으면 이걸로 좁힌다. `npm run ui` 가 채워준다.
   *
   * 지점을 빼면 안 된다. 상영관 번호는 지점 안에서만 고유해서, 용산 018 과
   * 영등포 018 이 한 키로 뭉개진다. 두 지점을 같이 볼 때 엉뚱한 회차가 걸린다.
   */
  showtimes?: string[];

  // ── 좌석 조건 ──────────────────────────────────────────────
  block: SeatBlock | null;
  party: PartySpec;
  /**
   * 잔여수가 한 번에 이만큼 늘었을 때만 알린다. 기본 1.
   *
   * 좌석맵을 못 보는 체인에서 단석·연석을 흉내 내는 수단이다. 한 번에 2석이
   * 풀렸다면 둘이 같이 취소한 것이고, 그러면 붙어 있을 가능성이 크다.
   *
   * **보장은 아니다.** 서로 떨어진 자리 둘이 같은 주기에 풀렸을 수도 있다.
   * 그래서 알림에도 "연석이라는 보장은 없다" 고 적는다. 좌석맵을 보는
   * 롯데에서는 party 로 진짜 연석을 판정하므로 이걸 쓸 이유가 없다.
   */
  minIncrease?: number;

  // ── 동작 ──────────────────────────────────────────────────
  action: 'notify' | 'hold';
  /**
   * 폴링 간격 하한(초).
   *
   * 예전에는 30초로 못 박았는데, 그건 요청 하나를 기준으로 삼은 규칙이었다.
   * 서버가 실제로 느끼는 건 총량이다 — 1짝을 20초마다 보는 것(180회/시)이
   * 10짝을 45초마다 보는 것(800회/시)보다 훨씬 가볍다. 그래서 총량 예산을
   * 따로 두고, 이 값은 하한으로만 남긴다.
   *
   * (800 은 그 설정의 이론상 최대치를 계산한 것이지 측정값이 아니다.)
   */
  pollFloorSec: number;
  /**
   * 시간당 요청 상한. 이걸로 총량을 정한다.
   *
   * 간격을 짝 수로 나눠 쓴다. 짝이 하나면 촘촘하게, 열이면 성기게 —
   * 감시 대상을 늘려도 서버가 받는 부담은 같다. 감시 대상과 촘촘함 사이에서
   * 무엇을 살지 사람이 정하는 값이다.
   *
   * ⚠️ 안전한 값을 우리는 모른다. 한때 "차단 당시가 800회/시였다" 고 적어
   * 두었는데, 그건 설정에서 계산한 이론상 최대치였지 측정값이 아니다.
   * 2026-08-10 에 실제로 차단을 부른 것은 좌석 API 를 403 받으면서 되풀이
   * 호출한 일과 탐색기 한 세션이었다 — 다른 엔드포인트, 다른 패턴이다.
   *
   * 그러니 이 값은 "여기까지는 안전하다" 가 아니라 "여기까지만 쓰겠다" 는
   * 선언으로 다뤄야 한다. 밀리면 감시기가 알아서 물러선다.
   */
  maxRequestsPerHour?: number;
  /**
   * 한 번의 폴링에서 보낼 알림 상한.
   *
   * 첫 폴링은 전 회차를 훑으므로, 조건이 넓으면 수십 건이 한꺼번에 나간다.
   * 텔레그램은 같은 대화방에 초당 한 건 남짓만 받아주고, 무엇보다
   * 40번 울리는 알림은 아무도 읽지 않는다. 점수 높은 순으로 자르고
   * 나머지는 다음 폴링에서 다시 후보가 된다.
   */
  maxAlertsPerRun?: number;
  /** 무한 감시 금지. 반드시 만료시각을 둔다. ISO 8601. */
  expiresAt: string;
  /** 상영 시각이 이만큼 안쪽이면 감시를 접는다. 현장 발권이 더 빠르다. */
  stopBeforeMin?: number;
  /**
   * 아무리 멀어도 이 간격보다는 자주 본다(초).
   *
   * 기본 간격표는 남은 시간이 많으면 느긋하게 본다 — 한산한 회차에서는
   * 난 자리가 한동안 남아 있기 때문이다. 매진된 특별관은 다르다.
   * 사흘 전에 나도 몇 초면 사라진다. 그런 회차를 볼 때 켠다.
   *
   * 켜면 요청이 그만큼 늘어난다. 감시 대상을 좁혀서 상쇄하는 게 좋다.
   */
  maxIntervalSec?: number;
}

/**
 * 어떤 경우에도 이보다 촘촘하게는 안 본다.
 *
 * 총량 예산이 주된 안전장치지만 하한도 남긴다. 초 단위로 두드리면 총량과
 * 무관하게 순간 요청률이 튀고, 그건 엣지가 창 단위로 보는 값이다.
 *
 * 5초까지 내리자는 얘기가 있었는데 10초에서 멈췄다. 근거는 "5초가 위험한
 * 값이라고 재봤기 때문" 이 아니다 — 안전선이 어디인지 우리는 모른다.
 * 10초로 둔 것은 임의의 보수적 선택이고, 필요하면 바꿀 수 있는 값이다.
 */
export const POLL_FLOOR_SEC = 10;

/** 하한을 강제하고 빠진 값을 채운다. 스펙을 만드는 모든 경로가 이걸 통과해야 한다. */
export function normalizeSpec(spec: WatchSpec): WatchSpec {
  return {
    ...spec,
    pollFloorSec: Math.max(POLL_FLOOR_SEC, spec.pollFloorSec || POLL_FLOOR_SEC),
    ...(spec.maxRequestsPerHour ? { maxRequestsPerHour: Math.max(1, spec.maxRequestsPerHour) } : {}),
    stopBeforeMin: spec.stopBeforeMin ?? 30,
    ...(spec.minIncrease && spec.minIncrease > 1 ? { minIncrease: spec.minIncrease } : {}),
    ...(spec.maxIntervalSec
      ? { maxIntervalSec: Math.max(POLL_FLOOR_SEC, spec.maxIntervalSec) }
      : {}),
    maxAlertsPerRun: Math.max(1, spec.maxAlertsPerRun ?? 5),
    party:
      spec.party.mode === 'single'
        ? { mode: 'single', size: 1 }
        : { mode: 'adjacent', size: Math.max(2, spec.party.size) },
  };
}

/** 'HH:mm' → 분. 24 를 넘는 심야 표기를 그대로 받는다. '24:35' → 1475 */
export function toMinutes(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function inWindow(startTime: string, windows: TimeWindow[]): boolean {
  if (windows.length === 0) return true;
  const t = toMinutes(startTime);
  if (Number.isNaN(t)) return false;
  return windows.some((w) => t >= toMinutes(w.from) && t <= toMinutes(w.to));
}

/** 회차가 스펙의 필터를 통과하는가. 지점·날짜는 조회 단계에서 이미 걸러진다. */
/** 회차 하나를 가리키는 키. 지점까지 넣어야 전역에서 고유하다. */
export function showtimeRef(s: Showtime): string {
  return `${s.theaterId}:${s.screenId}:${s.playSequence}`;
}

export function matchesSpec(s: Showtime, spec: WatchSpec): boolean {
  // 회차를 집어서 골랐으면 그것만 본다. 다른 조건은 볼 필요가 없다.
  if (spec.showtimes?.length) return spec.showtimes.includes(showtimeRef(s));

  if (spec.movies.length > 0 && !spec.movies.includes(s.movieId)) return false;
  if (spec.screens?.length && !spec.screens.includes(s.screenId)) return false;
  if (spec.screenPattern && !new RegExp(spec.screenPattern, 'i').test(s.screenName)) return false;
  return inWindow(s.startTime, spec.windows);
}

/**
 * 회차의 실제 상영 시각(UTC 기준 Date).
 *
 * playDate 는 KST 날짜이고 startTime 은 24 를 넘을 수 있다.
 * Date.UTC 가 자릿수 넘침을 알아서 다음 날로 넘겨준다.
 */
export function showtimeAt(playDate: string, startTime: string): Date {
  const year = Number(playDate.slice(0, 4));
  const month = Number(playDate.slice(4, 6));
  const day = Number(playDate.slice(6, 8));
  const mins = toMinutes(startTime);
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return new Date(Date.UTC(year, month - 1, day, hh - 9, mm)); // KST = UTC+9
}
