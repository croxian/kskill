/**
 * 지점 코드.
 *
 * 실측으로 확인한 것만 적는다. 코드를 지어내면 조회가 조용히 빈 목록을
 * 돌려주고, 사용자는 "그날 회차가 없나 보다" 로 오해한다.
 *
 * 목록에 없는 지점은 UI 에서 코드를 직접 넣거나, 지점 목록 불러오기로
 * 받아올 수 있다.
 */
export interface CgvTheater {
  code: string;
  name: string;
  /** 실측으로 확인했는가. 확인 안 된 것은 목록에 넣지 않는다. */
  verified: true;
}

export const CGV_THEATERS: CgvTheater[] = [
  { code: '0013', name: '용산아이파크몰', verified: true },
  { code: '0059', name: '영등포타임스퀘어', verified: true },
];
