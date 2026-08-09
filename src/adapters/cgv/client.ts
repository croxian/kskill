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

/**
 * 서명 + 브라우저처럼 보이는 헤더.
 *
 * daiso 의 직접 호출 경로는 서명 헤더 두 개만 보내고, 403 이 오면
 * 유료 프록시(Zyte)로 넘긴다. 즉 저자들도 직접 호출이 막히는 걸 알고 있었다.
 * 헤더를 더 붙여서 통과하는지 먼저 확인하고, 안 되면 브라우저로 간다.
 */
export function signedHeaders(path: string, timestamp: string): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    Origin: 'https://www.cgv.co.kr',
    Referer: 'https://www.cgv.co.kr/',
    'X-TIMESTAMP': timestamp,
    // 서명은 쿼리스트링이 아니라 경로만 포함한다. 본문은 GET 이라 빈 문자열.
    'X-SIGNATURE': sign(path, '', timestamp),
  };
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
      headers: signedHeaders(path, timestamp),
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
