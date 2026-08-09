import type { BrowserContext } from 'playwright';

import { CGV, type CgvScnItem } from './api.js';
import { signedHeaders } from './client.js';

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
