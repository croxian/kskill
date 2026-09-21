# -*- coding: utf-8 -*-
"""
ktx_watch.py - KTX 빈자리 감시 (개인용)

본인이 탈 표 한 장을 잡기 위한 도구입니다.
서버에 부담을 주지 않도록 조회 간격과 총 실행 시간을 코드 안에서 강제합니다.

기본 동작은 "감시 + 알림"입니다. 자리를 찾으면 소리를 내고 멈춥니다.
--reserve 를 붙였을 때만 예약까지 시도하고, 결제는 하지 않습니다.
(코레일 예약은 보통 10분 안에 직접 결제해야 유지됩니다. 앱에서 결제하세요.)

사용 예:
    python ktx_watch.py --dep 서울 --arr 부산 --date 20260925 --time 060000
    python ktx_watch.py --dep 서울 --arr 부산 --date 20260925 --time 060000 --reserve
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# 안전장치. 명령줄로 더 공격적으로 바꿀 수 없도록 여기서 못을 박아 둡니다.
# ---------------------------------------------------------------------------
MIN_INTERVAL_SEC = 30      # 조회 간격의 하한. 이보다 짧게는 절대 돌지 않습니다.
MAX_RUNTIME_MIN = 60       # 총 실행 시간의 상한. 밤새 돌리지 않습니다.
MAX_CONSECUTIVE_ERRORS = 3  # 에러가 이만큼 연달아 나면 멈춥니다.


def load_secrets() -> None:
    """~/.config/k-skill/secrets.env 를 읽어 환경변수로 올립니다.

    파일이 없으면 조용히 넘어갑니다. 이미 환경변수가 있으면 덮어쓰지 않습니다.
    (Windows 에서 Path.home() 은 C:\\Users\\사용자이름 입니다.)
    """
    path = Path.home() / ".config" / "k-skill" / "secrets.env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def beep() -> None:
    """자리를 찾았을 때 소리를 냅니다. 실패해도 프로그램은 계속 갑니다."""
    try:
        if sys.platform == "win32":
            import winsound

            for _ in range(3):
                winsound.Beep(880, 300)
                time.sleep(0.1)
        else:
            print("\a", end="", flush=True)
    except Exception:
        pass


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="KTX 빈자리 감시 (개인용)")
    p.add_argument("--dep", required=True, help="출발역. 예: 서울")
    p.add_argument("--arr", required=True, help="도착역. 예: 부산")
    p.add_argument("--date", required=True, help="날짜 8자리. 예: 20260925")
    p.add_argument("--time", default="000000", help="이 시각 이후로 검색. 6자리. 예: 060000")
    p.add_argument(
        "--interval",
        type=int,
        default=MIN_INTERVAL_SEC,
        help=f"조회 간격(초). {MIN_INTERVAL_SEC}초 미만은 {MIN_INTERVAL_SEC}초로 올립니다.",
    )
    p.add_argument(
        "--minutes",
        type=int,
        default=30,
        help=f"몇 분간 감시할지. 최대 {MAX_RUNTIME_MIN}분.",
    )
    p.add_argument(
        "--reserve",
        action="store_true",
        help="자리를 찾으면 예약까지 시도합니다. 결제는 하지 않습니다.",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    load_secrets()

    korail_id = os.environ.get("KSKILL_KTX_ID")
    korail_pw = os.environ.get("KSKILL_KTX_PASSWORD")
    if not korail_id or not korail_pw:
        print("[중단] 아이디/비밀번호를 찾지 못했습니다.")
        print("       ~/.config/k-skill/secrets.env 에 아래 두 줄을 채워 주세요.")
        print("       KSKILL_KTX_ID=아이디")
        print("       KSKILL_KTX_PASSWORD=비밀번호")
        return 1

    try:
        from korail2 import Korail
    except ImportError:
        print("[중단] korail2 가 설치되어 있지 않습니다.")
        print("       python -m pip install korail2-ncard pycryptodome")
        return 1

    # 안전장치를 실제 값에 적용합니다.
    interval = max(args.interval, MIN_INTERVAL_SEC)
    minutes = min(args.minutes, MAX_RUNTIME_MIN)
    deadline = time.time() + minutes * 60

    print(f"[설정] {args.dep} -> {args.arr}  {args.date} {args.time} 이후")
    print(f"[설정] {interval}초 간격으로 최대 {minutes}분간 감시합니다.")
    print(f"[설정] 예약 시도: {'예' if args.reserve else '아니오 (알림만)'}")
    print("[안내] 멈추려면 Ctrl+C 를 누르세요.\n")

    # 로그인은 딱 한 번만 합니다. 반복할수록 서버에 부담이 됩니다.
    korail = Korail(korail_id, korail_pw)

    attempts = 0
    errors = 0

    while time.time() < deadline:
        attempts += 1
        stamp = time.strftime("%H:%M:%S")

        try:
            trains = korail.search_train(args.dep, args.arr, args.date, args.time)
            errors = 0  # 성공했으니 에러 카운터를 되돌립니다.
        except Exception as exc:
            name = type(exc).__name__
            if name in ("NoResultsError", "SoldOutError"):
                # 매진입니다. 정상적인 상황이므로 에러로 세지 않습니다.
                print(f"[{stamp}] {attempts}회 - 빈자리 없음")
                trains = []
            else:
                errors += 1
                print(f"[{stamp}] {attempts}회 - 문제 발생: {name}: {exc}")
                if errors >= MAX_CONSECUTIVE_ERRORS:
                    print("\n[중단] 에러가 연달아 발생했습니다. 더 두드리지 않고 멈춥니다.")
                    print("       비밀번호, 역 이름, 날짜를 다시 확인해 주세요.")
                    return 1
                trains = []

        if trains:
            print(f"\n[{stamp}] 빈자리를 찾았습니다.")
            for t in trains:
                print(f"    {t}")
            beep()

            if not args.reserve:
                print("\n[완료] 코레일톡 앱에서 직접 예매하세요.")
                return 0

            try:
                reservation = korail.reserve(trains[0])
            except Exception as exc:
                print(f"\n[실패] 예약이 되지 않았습니다: {type(exc).__name__}: {exc}")
                print("       한발 늦었을 수 있습니다. 앱에서 직접 확인해 보세요.")
                return 1

            print(f"\n[예약됨] {reservation}")
            print("[중요] 결제는 되지 않았습니다.")
            print("       코레일톡 앱에서 제한시간(보통 10분) 안에 결제하세요.")
            return 0

        # 다음 조회까지 대기. 남은 시간이 간격보다 짧으면 그냥 끝냅니다.
        if time.time() + interval >= deadline:
            break
        time.sleep(interval)

    print(f"\n[종료] {minutes}분 동안 빈자리를 찾지 못했습니다. (총 {attempts}회 조회)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n[종료] 사용자가 중단했습니다.")
        sys.exit(130)
