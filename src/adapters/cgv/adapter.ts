import type { Showtime } from '../../types.js';
import type { TheaterRef } from '../../core/spec.js';
import { CgvBrowserClient } from './browser.js';
import { fetchSiteTimetable } from './client.js';
import { parseCgvTimetable } from './parse.js';

/**
 * CGV 1단 감시.
 *
 * 직접 호출이 403 이면 브라우저로 넘어가고, 한 번 넘어가면 계속 그쪽을 쓴다.
 * 매번 직접 호출을 시도해 실패하는 건 폴링마다 낭비다.
 *
 * 브라우저는 하나를 열어두고 재사용한다. 폴링마다 띄우면 회당 2~3초가 날아가고,
 * 어차피 좌석을 잡으려면 브라우저가 필요하다.
 */
export interface CgvAdapterOpts {
  timeoutMs?: number;
  profileDir?: string;
  /** 직접 호출을 건너뛰고 처음부터 브라우저로. */
  forceBrowser?: boolean;
  /** 테스트에서 브라우저를 갈아끼우기 위한 구멍. */
  browserClient?: Pick<CgvBrowserClient, 'siteTimetable' | 'close'>;
}

export function createCgvAdapter(theaters: TheaterRef[], opts: CgvAdapterOpts = {}) {
  const browser =
    opts.browserClient ??
    new CgvBrowserClient({
      ...(opts.profileDir ? { profileDir: opts.profileDir } : {}),
      headless: true,
    });
  let useBrowser = opts.forceBrowser ?? false;

  return {
    /** 지금 어느 경로를 쓰고 있는지. 로그에 찍어두면 진단이 쉽다. */
    get transport(): 'direct' | 'browser' {
      return useBrowser ? 'browser' : 'direct';
    },

    async listShowtimes(theaterIdx: number, playDate: string): Promise<Showtime[]> {
      const t = theaters[theaterIdx];
      if (!t) throw new Error(`알 수 없는 지점 인덱스: ${theaterIdx}`);

      if (!useBrowser) {
        try {
          const items = await fetchSiteTimetable({
            theaterCode: t.theaterId,
            playDate,
            ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
          });
          return parseCgvTimetable(items);
        } catch (err) {
          // 403 은 우리가 고칠 수 있는 게 아니다. 한 번 겪으면 바로 갈아탄다.
          if (!isBlocked(err)) throw err;
          useBrowser = true;
        }
      }
      return parseCgvTimetable(await browser.siteTimetable(t.theaterId, playDate));
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };
}

function isBlocked(err: unknown): boolean {
  return err instanceof Error && /HTTP 40[ervy3]|403/.test(err.message);
}
