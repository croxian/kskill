import { LOTTE } from './api.js';

/**
 * 롯데시네마 HTTP 클라이언트.
 *
 * 로그인·세션이 전혀 필요 없는 공개 조회 경로만 다룬다.
 * 좌석 점유는 이 계층이 아니라 로그인된 브라우저를 모는 별도 계층에서 한다.
 */

export interface LotteResponse {
  IsOK?: boolean;
  ResultCode?: string;
  ResultMessage?: string;
  [key: string]: unknown;
}

export class LotteApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LotteApiError';
  }
}

/** 롯데 응답은 노드마다 { Items: [...] } 로 감싸이기도 하고 아니기도 하다. */
export function items<T>(node: unknown): T[] {
  if (Array.isArray(node)) return node as T[];
  if (node && typeof node === 'object' && 'Items' in node) {
    const inner = (node as { Items?: unknown }).Items;
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

export async function callLotte(
  methodName: string,
  fields: Record<string, string | number>,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LotteResponse> {
  const { timeoutMs = 15_000, fetchImpl = fetch } = opts;

  const paramList = JSON.stringify({
    MethodName: methodName,
    ...LOTTE.COMMON,
    ...fields,
  });

  const body = new FormData();
  body.append('paramList', paramList);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${LOTTE.BASE_URL}${LOTTE.TICKETING_PATH}`, {
      method: 'POST',
      headers: { Accept: 'application/json, text/javascript, */*; q=0.01' },
      body,
      signal: ac.signal,
    });

    if (!res.ok) {
      throw new LotteApiError(`HTTP ${res.status}`, methodName, res.status);
    }

    const json = (await res.json()) as LotteResponse;
    if (json.IsOK === false) {
      throw new LotteApiError(json.ResultMessage || 'IsOK=false', methodName);
    }
    return json;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new LotteApiError(`timeout after ${timeoutMs}ms`, methodName);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 한 지점·한 날짜의 **전 영화 전 회차**를 한 번에 받는다.
 *
 * representationMovieCode 를 빈 문자열로 두는 것이 핵심이다.
 * 영화별로 나눠 호출하면 (지점 × 영화) 만큼 요청이 늘어날 뿐 얻는 게 없다.
 * 폴링 1회당 요청 수 = 감시 지점 수. 영화를 몇 편 걸든 변하지 않는다.
 */
export function fetchPlaySequences(args: {
  cinemaId: string; // "1|0001|1016"
  playDate: string; // 'YYYY-MM-DD'
  movieCode?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<LotteResponse> {
  return callLotte(
    LOTTE.METHODS.PLAY_SEQUENCE,
    {
      playDate: args.playDate,
      cinemaID: args.cinemaId,
      representationMovieCode: args.movieCode ?? '',
    },
    { timeoutMs: args.timeoutMs, fetchImpl: args.fetchImpl },
  );
}

/**
 * 한 회차의 좌석 배치도.
 *
 * ⚠️ 파라미터 이름이 GetPlaySequence 와 미묘하게 다르다.
 *   GetPlaySequence : cinemaID (대문자 D) — "1|0001|1016" 합성 문자열
 *   GetSeats        : cinemaId (소문자 d) — 1016 숫자
 * 헷갈리면 에러 없이 빈 응답만 돌아온다.
 *
 * screenDivisionCode 는 필터가 아니다. 100 을 보내도 리클라이너까지
 * 전 좌석(360석)이 온다. 구역 구분은 응답 쪽 필드로 한다.
 */
export function fetchSeats(args: {
  theaterId: string | number;
  screenId: string | number;
  playDate: string; // 'YYYY-MM-DD'
  playSequence: string | number;
  screenDivisionCode?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<LotteResponse> {
  return callLotte(
    LOTTE.METHODS.SEATS,
    {
      cinemaId: Number(args.theaterId),
      screenId: Number(args.screenId),
      playDate: args.playDate,
      playSequence: Number(args.playSequence),
      screenDivisionCode: args.screenDivisionCode ?? 100,
    },
    { timeoutMs: args.timeoutMs, fetchImpl: args.fetchImpl },
  );
}

/** 'YYYYMMDD' → 'YYYY-MM-DD'. 요청은 하이픈 형식을 받는다. */
export function toRequestDate(yyyymmdd: string): string {
  if (/^\d{8}$/.test(yyyymmdd)) {
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }
  return yyyymmdd;
}
