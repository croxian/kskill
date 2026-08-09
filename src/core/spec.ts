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
  /** 특정 상영관만 (IMAX·수퍼플렉스 등). 비우면 전체. */
  screens?: string[];

  // ── 좌석 조건 ──────────────────────────────────────────────
  block: SeatBlock | null;
  party: PartySpec;

  // ── 동작 ──────────────────────────────────────────────────
  action: 'notify' | 'hold';
  /** 폴링 간격 하한(초). 30 미만은 받지 않는다. */
  pollFloorSec: number;
  /** 무한 감시 금지. 반드시 만료시각을 둔다. ISO 8601. */
  expiresAt: string;
  /** 상영 시각이 이만큼 안쪽이면 감시를 접는다. 현장 발권이 더 빠르다. */
  stopBeforeMin?: number;
}

export const POLL_FLOOR_SEC = 30;

/** 하한을 강제하고 빠진 값을 채운다. 스펙을 만드는 모든 경로가 이걸 통과해야 한다. */
export function normalizeSpec(spec: WatchSpec): WatchSpec {
  return {
    ...spec,
    pollFloorSec: Math.max(POLL_FLOOR_SEC, spec.pollFloorSec || POLL_FLOOR_SEC),
    stopBeforeMin: spec.stopBeforeMin ?? 30,
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
export function matchesSpec(s: Showtime, spec: WatchSpec): boolean {
  if (spec.movies.length > 0 && !spec.movies.includes(s.movieId)) return false;
  if (spec.screens?.length && !spec.screens.includes(s.screenId)) return false;
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
