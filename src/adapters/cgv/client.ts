import { createHmac } from 'node:crypto';

import { CGV, type CgvScnItem } from './api.js';

/**
 * CGV HTTP 클라이언트.
 *
 * daiso 를 거치지 않고 직접 호출한다. 이유는 두 가지다.
 *   1. 중간 서버가 죽으면 감시가 멈춘다
 *   2. daiso 는 응답 필드를 골라 버린다 — 원본에 있는 상영관 정보가 사라진다
 */

export class CgvApiError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CgvApiError';
  }
}

/** base64( HMAC-SHA256( secret, `${timestamp}|${path}|${body}` ) ) */
export function sign(path: string, body: string, timestamp: string): string {
  return createHmac('sha256', CGV.SIGNING_SECRET)
    .update(`${timestamp}|${path}|${body}`)
    .digest('base64');
}

export async function callCgv(
  path: string,
  params: Record<string, string>,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ data?: unknown; [key: string]: unknown }> {
  const { timeoutMs = 15_000, fetchImpl = fetch } = opts;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const query = new URLSearchParams(params).toString();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${CGV.BASE_URL}${path}?${query}`, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'ko-KR',
        'X-TIMESTAMP': timestamp,
        // 서명은 쿼리스트링이 아니라 경로만 포함한다. 본문은 GET 이라 빈 문자열.
        'X-SIGNATURE': sign(path, '', timestamp),
      },
      signal: ac.signal,
    });
    if (!res.ok) throw new CgvApiError(`HTTP ${res.status}`, path, res.status);

    const text = await res.text();
    try {
      return JSON.parse(text) as { data?: unknown };
    } catch {
      throw new CgvApiError(text.slice(0, 120) || '응답 파싱 실패', path);
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new CgvApiError(`timeout after ${timeoutMs}ms`, path);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 한 지점의 하루치 전 회차. 영화를 나누지 않아도 한 번에 온다. */
export async function fetchSiteTimetable(args: {
  theaterCode: string;
  playDate: string; // 'YYYYMMDD'
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<CgvScnItem[]> {
  const res = await callCgv(
    CGV.TIMETABLE_BY_SITE,
    {
      coCd: CGV.COMPANY_CODE,
      siteNo: args.theaterCode,
      scnYmd: args.playDate,
      rtctlScopCd: CGV.SCOPE_BY_SITE,
    },
    {
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    },
  );
  return Array.isArray(res.data) ? (res.data as CgvScnItem[]) : [];
}

export async function fetchTheaters(opts: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<unknown[]> {
  const res = await callCgv(CGV.THEATER_LIST, { coCd: CGV.COMPANY_CODE }, opts);
  return Array.isArray(res.data) ? res.data : [];
}
