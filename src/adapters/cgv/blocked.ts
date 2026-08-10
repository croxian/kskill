/**
 * CGV 가 "비정상 접근" 으로 막았을 때.
 *
 * 2026-08-10 실측:
 *   HTTP 403
 *   "비정상적으로 CGV에 접속한 것이 확인되어 이용이 제한되었어요.
 *    자세한 내용은 고객센터( 1544-1122 )로 문의해 주세요.
 *    RAY_ID a28b84adcd3730fe CLIENT_IP 211.193.53.49"
 *
 * 이건 다시 시도해서 될 일이 아니다. 그런데 감시 루프는 실패를 네트워크
 * 문제로 보고 60초 뒤에 또 두드린다 — 막힌 상태에서 계속 두드리면 제한이
 * 길어지기만 한다. 그래서 이 신호를 만나면 **CGV 조회를 아예 멈춘다.**
 *
 * 우회하지 않는다. 대신 사람에게 알린다.
 */

export class CgvBlockedError extends Error {
  constructor(readonly detail: string) {
    super(
      'CGV 가 비정상 접근으로 판단해 이용을 제한했습니다. ' +
        '조회를 멈춥니다. 우회하지 않습니다.\n  ' +
        detail,
    );
    this.name = 'CgvBlockedError';
  }
}

/** 차단 화면인가. 문구가 바뀔 수 있어 여러 실마리를 본다. */
export function isBlockMessage(text: string): boolean {
  return (
    /비정상적으로\s*CGV/.test(text) ||
    /이용이\s*제한/.test(text) ||
    // 문구가 바뀌어도 이 조합은 남을 가능성이 크다
    (/RAY_ID/.test(text) && /CLIENT_IP/.test(text))
  );
}

/** 사람에게 보낼 안내. 무엇을 해야 하는지까지 적는다. */
export const CGV_BLOCKED_WARNING =
  '🚫 <b>CGV 가 접근을 제한했습니다</b>\n\n' +
  'CGV 조회를 멈췄습니다. 우회는 하지 않습니다.\n\n' +
  '• 평소 쓰시는 브라우저에서 cgv.co.kr 이 열리는지 확인해 주세요\n' +
  '• 보통 몇 시간에서 하루면 풀립니다. 그동안 감시기를 CGV 로 돌리지 마세요\n' +
  '• 막힌 상태에서 계속 두드리면 제한이 길어집니다\n\n' +
  '롯데시네마 감시는 영향을 받지 않습니다.';
