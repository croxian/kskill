import { describe, expect, it } from 'vitest';

import { CgvBlockedError, isBlockMessage } from '../src/adapters/cgv/blocked.js';
import { createCgvAdapter } from '../src/adapters/cgv/adapter.js';

const REAL_BLOCK =
  '비정상적으로 CGV에 접속한 것이 확인되어 이용이 제한되었어요. ' +
  '자세한 내용은 고객센터( 1544-1122 )로 문의해 주세요. ' +
  'RAY_ID a28b84adcd3730fe CLIENT_IP 211.193.53.49';

describe('isBlockMessage', () => {
  it('실측 차단 문구를 알아본다', () => {
    expect(isBlockMessage(REAL_BLOCK)).toBe(true);
  });

  /** 문구는 바뀔 수 있다. RAY_ID + CLIENT_IP 조합은 남을 가능성이 크다. */
  it('문구가 바뀌어도 차단 화면의 흔적으로 알아본다', () => {
    expect(isBlockMessage('Access denied RAY_ID abc CLIENT_IP 1.2.3.4')).toBe(true);
  });

  it('평범한 실패를 차단으로 오해하지 않는다', () => {
    expect(isBlockMessage('CGV HTTP 500')).toBe(false);
    expect(isBlockMessage('조회 되었습니다.')).toBe(false);
    expect(isBlockMessage('로그인이 필요합니다')).toBe(false);
  });
});

describe('createCgvAdapter 차단 처리', () => {
  const theaters = [{ chain: 'cgv' as const, theaterId: '0013', label: '용산' }];

  /**
   * 감시 루프는 조회 실패를 네트워크 문제로 보고 곧 다시 시도한다.
   * 차단은 그렇게 풀리지 않고, 두드릴수록 제한만 길어진다.
   */
  it('한 번 차단당하면 요청을 더 만들지 않는다', async () => {
    let calls = 0;
    const adapter = createCgvAdapter(theaters, {
      forceBrowser: true,
      browserClient: {
        siteTimetable: async () => {
          calls++;
          throw new CgvBlockedError(REAL_BLOCK);
        },
        close: async () => {},
      },
    });

    await expect(adapter.listShowtimes(0, '20260814')).rejects.toThrow(CgvBlockedError);
    await expect(adapter.listShowtimes(0, '20260814')).rejects.toThrow(CgvBlockedError);
    await expect(adapter.listShowtimes(0, '20260815')).rejects.toThrow(CgvBlockedError);

    expect(calls).toBe(1); // 첫 번째만 실제로 나갔다
    expect(adapter.blocked).toBeInstanceOf(CgvBlockedError);
  });

  it('차단이 아닌 실패는 계속 시도한다', async () => {
    let calls = 0;
    const adapter = createCgvAdapter(theaters, {
      forceBrowser: true,
      browserClient: {
        siteTimetable: async () => {
          calls++;
          throw new Error('socket hang up');
        },
        close: async () => {},
      },
    });

    await expect(adapter.listShowtimes(0, '20260814')).rejects.toThrow(/socket/);
    await expect(adapter.listShowtimes(0, '20260814')).rejects.toThrow(/socket/);

    expect(calls).toBe(2);
    expect(adapter.blocked).toBeNull();
  });
});
