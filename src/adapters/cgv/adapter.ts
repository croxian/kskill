import type { Showtime } from '../../types.js';
import type { TheaterRef } from '../../core/spec.js';
import { CgvBlockedError, isBlockMessage } from './blocked.js';
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
  /**
   * 차단당하면 더 두드리지 않는다.
   *
   * 감시 루프는 조회 실패를 네트워크 문제로 보고 60초 뒤에 또 시도한다.
   * 차단은 그렇게 풀리지 않고, 막힌 상태에서 계속 두드리면 제한만 길어진다.
   * 한 번 막히면 요청 자체를 만들지 않고 같은 사실을 계속 알린다.
   */
  let blocked: CgvBlockedError | null = null;

  return {
    /** 차단당했는가. main.ts 가 이걸 보고 감시를 멈춘다. */
    get blocked(): CgvBlockedError | null {
      return blocked;
    },

    /** 지금 어느 경로를 쓰고 있는지. 로그에 찍어두면 진단이 쉽다. */
    get transport(): 'direct' | 'browser' {
      return useBrowser ? 'browser' : 'direct';
    },

    async listShowtimes(theaterIdx: number, playDate: string): Promise<Showtime[]> {
      if (blocked) throw blocked;

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
          if (asBlock(err)) throw (blocked = asBlock(err)!);
          // 그냥 403 은 우리가 고칠 수 있는 게 아니다. 한 번 겪으면 바로 갈아탄다.
          if (!isRefused(err)) throw err;
          useBrowser = true;
        }
      }
      try {
        return parseCgvTimetable(await browser.siteTimetable(t.theaterId, playDate));
      } catch (err) {
        if (asBlock(err)) throw (blocked = asBlock(err)!);
        throw err;
      }
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };
}

/** 그냥 거절인가 (재시도·경로 전환의 여지가 있다). */
function isRefused(err: unknown): boolean {
  return err instanceof Error && /HTTP 40[ervy3]|403/.test(err.message);
}

/**
 * "이용이 제한되었어요" 인가.
 *
 * 브라우저 경로는 CgvBlockedError 를 그대로 던지지만, 직접 호출 경로는
 * 본문을 메시지에 담아 평범한 Error 로 온다. 둘 다 잡는다.
 */
function asBlock(err: unknown): CgvBlockedError | null {
  if (err instanceof CgvBlockedError) return err;
  if (err instanceof Error && isBlockMessage(err.message)) return new CgvBlockedError(err.message);
  return null;
}
