# -*- coding: utf-8 -*-
"""
ktx_watch.py - KTX 빈자리 감시 (개인용)

본인이 탈 표 한 장을 잡기 위한 도구입니다.
서버에 부담을 주지 않도록 조회 간격과 총 실행 시간을 코드 안에서 강제합니다.

기본 동작은 "감시 + 알림"입니다. 자리를 찾으면 소리를 내고 멈춥니다.
--reserve 를 붙였을 때만 예약까지 시도하고, 결제는 하지 않습니다.
(코레일 예약은 보통 10분 안에 직접 결제해야 유지됩니다. 앱에서 결제하세요.)

주의: search_train 은 지정한 시각부터 10여 대만 돌려줍니다. 하루 전체를 보려면
--allday 를 붙이세요. 안 붙이면 첫차 근처만 보고 "전부 매진"처럼 보입니다.

사용 예:
    python ktx_watch.py
    python ktx_watch.py --dep 서울 --arr 부산 --date 20260925 --allday
    python ktx_watch.py --dep 서울 --arr 부산 --date 20260925 --time 060000 --ktx-only
"""

from __future__ import annotations

import argparse
import datetime as dt
import inspect
import os
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# 안전장치. 명령줄로 더 공격적으로 바꿀 수 없도록 여기서 못을 박아 둡니다.
# ---------------------------------------------------------------------------
MIN_INTERVAL_SEC = 30      # 조회 간격의 하한. 이보다 짧게는 절대 돌지 않습니다.
MIN_INTERVAL_ALLDAY = 60   # --allday 는 한 번에 여러 번 요청하므로 더 길게 잡습니다.
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


def clean_station(name: str) -> str:
    """역 이름을 다듬습니다. '서울역' 처럼 뒤에 '역'을 붙여도 받아줍니다."""
    name = name.strip()
    if len(name) > 2 and name.endswith("역"):
        name = name[:-1]
    return name


def clean_date(text: str) -> str:
    """날짜를 8자리로 맞춥니다. 2026-09-25, 2026.09.25, 0925 전부 받습니다."""
    digits = "".join(c for c in text if c.isdigit())
    if not digits:
        return (dt.date.today() + dt.timedelta(days=1)).strftime("%Y%m%d")
    if len(digits) == 4:
        return f"{dt.date.today().year}{digits}"   # 월일만 적으면 올해를 붙입니다
    return digits[:8]


def clean_time(text: str) -> str:
    """시각을 6자리로 맞춥니다. 6, 06, 0600, 06:00 전부 060000 이 됩니다."""
    digits = "".join(c for c in text if c.isdigit())
    if not digits:
        return "000000"
    if len(digits) % 2:               # 6 -> 06,  630 -> 0630
        digits = digits.zfill(len(digits) + 1)
    return digits.ljust(6, "0")[:6]   # 06 -> 060000,  0630 -> 063000


def ask(prompt: str, default: str = "") -> str:
    """물어보고 답을 받습니다. 그냥 엔터를 치면 기본값을 씁니다."""
    suffix = f" [{default}]" if default else ""
    return input(f"{prompt}{suffix}: ").strip() or default


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="KTX 빈자리 감시 (개인용). 인자 없이 실행하면 하나씩 물어봅니다."
    )
    p.add_argument("--dep", help="출발역. 예: 서울")
    p.add_argument("--arr", help="도착역. 예: 부산")
    p.add_argument("--date", help="날짜. 예: 20260925")
    p.add_argument("--time", help="이 시각 이후로 검색. 예: 060000")
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
        "--allday",
        action="store_true",
        help="첫차부터 끝차까지 하루 전체를 봅니다. 기본값은 지정 시각부터 10여 대뿐입니다.",
    )
    p.add_argument(
        "--ktx-only",
        action="store_true",
        help="KTX 만 봅니다. 기본값은 ITX-새마을, 무궁화 등도 함께 봅니다.",
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

    # 명령줄로 안 준 값은 여기서 직접 물어봅니다.
    interactive = args.dep is None or args.arr is None or args.date is None
    if interactive:
        print("KTX 빈자리 감시. 그냥 엔터를 치면 [] 안의 값을 씁니다.\n")
    tomorrow = (dt.date.today() + dt.timedelta(days=1)).strftime("%Y%m%d")
    dep = clean_station(args.dep or ask("출발역", "서울"))
    arr = clean_station(args.arr or ask("도착역", "부산"))
    date = clean_date(args.date or ask("날짜 (예: 20260925)", tomorrow))
    if args.time is not None:
        depart_time = clean_time(args.time)
    elif interactive:
        depart_time = clean_time(ask("몇 시 이후 (예: 06)", "000000"))
    else:
        depart_time = "000000"

    if dep == arr:
        print("[중단] 출발역과 도착역이 같습니다.")
        return 1

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

    print(f"\n[설정] {dep} -> {arr}  {date} {depart_time} 이후")
    print(f"[설정] {interval}초 간격으로 최대 {minutes}분간 감시합니다.")
    print(f"[설정] 예약 시도: {'예' if args.reserve else '아니오 (알림만)'}")
    print("[안내] 멈추려면 Ctrl+C 를 누르세요.\n")

    # 로그인은 딱 한 번만 합니다. 반복할수록 서버에 부담이 됩니다.
    korail = Korail(korail_id, korail_pw)

    # 이 버전의 라이브러리가 뭘 지원하는지 시작할 때 한 번만 확인합니다.
    search_params = set(inspect.signature(Korail.search_train).parameters)
    supports_no_seats = "include_no_seats" in search_params
    supports_allday = hasattr(Korail, "search_train_allday")

    extra = {}
    if args.ktx_only:
        try:
            from korail2 import TrainType

            extra["train_type"] = TrainType.KTX
        except Exception:
            print("[알림] KTX 만 걸러내지 못했습니다. 전체 열차를 봅니다.")

    use_allday = args.allday and supports_allday
    if args.allday and not supports_allday:
        print("[알림] 이 버전은 하루 전체 조회를 지원하지 않습니다. 앞쪽 일부만 봅니다.")
    if use_allday:
        # 하루 전체 조회는 내부에서 여러 번 요청합니다. 간격을 더 벌립니다.
        interval = max(interval, MIN_INTERVAL_ALLDAY)
        print(f"[설정] 하루 전체를 봅니다. 요청이 많아 간격을 {interval}초로 올렸습니다.")

    # rich_mode: 매진까지 한 번에 받아와 직접 걸러내는 방식.
    # 요청 횟수는 그대로면서 "전체 몇 대 중 몇 대 빈자리"를 보여줄 수 있습니다.
    rich_mode = supports_no_seats

    def seat_state(train):
        """빈자리 여부. 판단할 수 없으면 None 입니다."""
        fn = getattr(train, "has_seat", None)
        if not callable(fn):
            return None
        try:
            return bool(fn())
        except Exception:
            return None

    def fetch():
        kwargs = dict(extra)
        if rich_mode:
            kwargs["include_no_seats"] = True
        if use_allday:
            return korail.search_train_allday(dep, arr, date, depart_time, **kwargs)
        return korail.search_train(dep, arr, date, depart_time, **kwargs)

    attempts = 0
    errors = 0

    while time.time() < deadline:
        attempts += 1
        stamp = time.strftime("%H:%M:%S")

        total = None
        try:
            trains = fetch()
            errors = 0  # 성공했으니 에러 카운터를 되돌립니다.

            if rich_mode:
                states = [seat_state(t) for t in trains]
                if trains and all(s is None for s in states):
                    # 빈자리 여부를 읽을 수 없는 버전입니다. 안전하게 옛 방식으로 돌아갑니다.
                    print("[알림] 좌석 상태를 읽지 못해 기본 조회 방식으로 바꿉니다.")
                    rich_mode = False
                    trains = fetch()
                else:
                    total = len(trains)
                    trains = [t for t, s in zip(trains, states) if s]
        except Exception as exc:
            name = type(exc).__name__
            if name in ("NoResultsError", "SoldOutError"):
                # 매진입니다. 정상적인 상황이므로 에러로 세지 않습니다.
                trains = []
            else:
                errors += 1
                print(f"[{stamp}] {attempts}회 - 문제 발생: {name}: {exc}")
                if errors >= MAX_CONSECUTIVE_ERRORS:
                    print("\n[중단] 에러가 연달아 발생했습니다. 더 두드리지 않고 멈춥니다.")
                    print("       비밀번호, 역 이름, 날짜를 다시 확인해 주세요.")
                    return 1
                trains = []

        if not trains:
            # 라이브러리가 에러 대신 빈 목록을 주는 경우도 있어 여기서 한 번에 찍습니다.
            # 이 줄이 없으면 대기 중에 화면이 멈춘 것처럼 보입니다.
            if total:
                print(f"[{stamp}] {attempts}회 - 열차 {total}대 전부 매진")
            else:
                print(f"[{stamp}] {attempts}회 - 빈자리 없음")

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
