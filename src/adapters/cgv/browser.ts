import type { BrowserContext, Page } from 'playwright';

import { CGV, type CgvScnItem } from './api.js';
import { signedHeaders } from './client.js';
import { CGV_WEB } from './web-api.js';
import type { CgvSeatDataResponse } from './web-parse.js';

/**
 * 진짜 브라우저로 CGV API 를 부른다.
 *
 * Node 의 fetch 로 직접 부르면 403 이다. 서명이 틀려서가 아니라 —
 * daiso 의 직접 호출 경로와 헤더까지 동일한데도 막힌다 — CGV 가 서버 단에서
 * 브라우저가 아닌 클라이언트를 걸러내기 때문이다. TLS 지문이든 IP 평판이든
 * 우리가 헤더로 흉내 낼 수 없는 층이다.
 *
 * 실제 브라우저는 통과한다. 사람이 CGV 를 정상적으로 쓰고 있으니까.
 * 그래서 폴링도 브라우저를 통해 한다. 어차피 좌석을 잡으려면 브라우저를
 * 띄워야 하므로, 하나를 계속 열어두고 조회와 점유에 같이 쓴다.
 */

export class CgvBrowserClient {
  private ctx: BrowserContext | null = null;

  constructor(
    private readonly opts: {
      profileDir?: string;
      headless?: boolean;
      launch?(profileDir: string, headless: boolean): Promise<BrowserContext>;
    } = {},
  ) {}

  /**
   * 브라우저를 하나 열어두고 계속 쓴다.
   * 폴링마다 띄우면 회당 2~3초가 그냥 날아간다.
   */
  private async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;

    const dir = this.opts.profileDir ?? '.profile';
    const headless = this.opts.headless ?? true;

    if (this.opts.launch) {
      this.ctx = await this.opts.launch(dir, headless);
      return this.ctx;
    }
    const { chromium } = await import('playwright');
    this.ctx = await chromium.launchPersistentContext(dir, { headless });
    return this.ctx;
  }

  async close(): Promise<void> {
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  /**
   * 서명 헤더를 실어 API 주소로 직접 이동한다.
   *
   * fetch 를 페이지 안에서 부르면 www → api 가 교차 출처라 CORS 에 걸린다.
   * 주소로 이동하면 그런 제약이 없고, 요청은 브라우저 네트워크 스택을 그대로 탄다.
   */
  async get(path: string, params: Record<string, string>): Promise<unknown> {
    const ctx = await this.context();
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    const timestamp = Math.floor(Date.now() / 1000).toString();
    await ctx.setExtraHTTPHeaders(signedHeaders(path, timestamp));

    const url = `${CGV.BASE_URL}${path}?${new URLSearchParams(params).toString()}`;
    const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (!res) throw new Error(`CGV 응답 없음: ${path}`);
    if (!res.ok()) throw new Error(`CGV HTTP ${res.status()}: ${path}`);

    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`CGV 응답 파싱 실패: ${text.slice(0, 120)}`);
    }
  }

  /**
   * cgv.co.kr/api/v1 쪽 호출.
   *
   * api.cgv.co.kr 과 달리 서명이 없다. 웹앱이 자기 출처로 부르는 REST 라
   * 세션 쿠키만 있으면 된다.
   *
   * **주소로 이동하면 403 이다.** api.cgv.co.kr 에서 쓰던 수법인데 여기서는
   * 통하지 않는다. 최상위 이동은 Sec-Fetch-Dest: document 로 나가고 Referer
   * 가 없어서, 서버가 보기에 사람이 주소창에 API 주소를 친 것과 같다.
   *
   * 대신 페이지 안에서 fetch 한다. 여기는 같은 출처라 CORS 가 없고 —
   * api.cgv.co.kr 때 페이지 안 fetch 를 못 쓴 이유가 그거였다 — 쿠키도
   * Referer 도 Sec-Fetch-* 도 브라우저가 알아서 진짜와 똑같이 붙인다.
   */
  async getWeb(path: string, params: Record<string, string>): Promise<unknown> {
    const page = await this.onSite();
    const url = `${CGV_WEB.PATH_PREFIX}${path}?${new URLSearchParams(params).toString()}`;

    const res = await page.evaluate(async (u: string) => {
      const r = await fetch(u, {
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*' },
      });
      return { status: r.status, text: await r.text() };
    }, url);

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`CGV HTTP ${res.status}: ${path}\n  ${readable(res.text)}`);
    }
    try {
      return JSON.parse(res.text) as unknown;
    } catch {
      // 로그인이 풀리면 JSON 대신 로그인 화면 HTML 이 온다.
      throw new Error(
        res.text.includes('<')
          ? `CGV 가 JSON 대신 화면을 보냈습니다 (로그인 만료?): ${path}`
          : `CGV 응답 파싱 실패: ${path}`,
      );
    }
  }

  /** 페이지를 cgv.co.kr 에 올려둔다. 같은 출처여야 fetch 가 진짜처럼 나간다. */
  private async onSite(): Promise<Page> {
    const ctx = await this.context();
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    // 앞선 api.cgv.co.kr 호출이 남긴 서명 헤더를 지운다. 여기서는 방해만 된다.
    await ctx.setExtraHTTPHeaders({});
    if (!page.url().startsWith(CGV_WEB.SITE_URL)) {
      await page.goto(CGV_WEB.SITE_URL, { waitUntil: 'domcontentloaded' });
    }
    return page;
  }

  /** 한 회차의 좌석맵. custNo 는 계정 식별자라 넣지 않아도 되는지 실측으로 확인한다. */
  async seatData(args: {
    theaterCode: string;
    playDate: string;
    screenNo: string;
    scnSseq: string;
    custNo?: string;
  }): Promise<CgvSeatDataResponse> {
    return (await this.getWeb(CGV_WEB.SEAT_MAP, {
      coCd: CGV_WEB.COMPANY_CODE,
      siteNo: args.theaterCode,
      scnYmd: args.playDate,
      scnsNo: args.screenNo,
      scnSseq: args.scnSseq,
      ...(args.custNo ? { custNo: args.custNo } : {}),
    })) as CgvSeatDataResponse;
  }

  async siteTimetable(theaterCode: string, playDate: string): Promise<CgvScnItem[]> {
    const res = (await this.get(CGV.TIMETABLE_BY_SITE, {
      coCd: CGV.COMPANY_CODE,
      siteNo: theaterCode,
      scnYmd: playDate,
      rtctlScopCd: CGV.SCOPE_BY_SITE,
    })) as { data?: unknown };
    return Array.isArray(res.data) ? (res.data as CgvScnItem[]) : [];
  }
}

/**
 * 차단 화면에서 사람이 읽을 부분만 뽑는다.
 *
 * 그냥 앞 200자를 자르면 <style> 안의 CSS 만 나온다. 실제로 그랬고,
 * 차단인지 로그인 만료인지 구분할 수 없었다.
 */
export function readable(html: string): string {
  if (!html.includes('<')) return html.slice(0, 200);
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 300) || '(읽을 수 있는 글자가 없습니다)';
}
