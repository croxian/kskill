# -*- coding: utf-8 -*-
"""
check_waitlist.py - 예약대기 지원 여부 확인 + 하루 전체 좌석 현황

search_train 은 한 번에 10건쯤만 돌려줍니다. 그래서 00:00 부터 찾으면
새벽 열차만 보이고 "전부 매진"처럼 보입니다. 이 스크립트는 하루 전체를
훑어서 실제로 어느 열차에 자리가 있는지 보여줍니다.

동시에 이 라이브러리가 예약대기(waiting list)를 지원하는지 확인합니다.

조회만 합니다. 예매도 예약대기 신청도 하지 않습니다.

    python check_waitlist.py
"""

from __future__ import annotations

import datetime as dt
import getpass
import inspect
import os
import time
from pathlib import Path


def keep_supported(fn, candidates: dict) -> dict:
    """fn 이 실제로 받는 인자만 남깁니다.

    search_train 과 search_train_allday 는 받는 인자가 서로 다릅니다.
    한쪽 기준으로 만든 인자를 다른 쪽에 그대로 넘기면 TypeError 가 납니다.
    """
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return dict(candidates)
    # **kwargs 를 받는 함수면 전부 통과시킵니다.
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(candidates)
    return {k: v for k, v in candidates.items() if k in params}


def line(title: str) -> None:
    print("\n" + "=" * 64)
    print(title)
    print("=" * 64)


def load_secrets() -> None:
    path = Path.home() / ".config" / "k-skill" / "secrets.env"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


SCRIPT_VERSION = "2026-09-21e"
print(f"*** check_waitlist.py 버전: {SCRIPT_VERSION} ***")

import korail2
from korail2 import Korail

# --- 1. 이 라이브러리가 무엇을 할 수 있는지 -------------------------------
line("1. 라이브러리가 지원하는 기능")

has_allday = hasattr(Korail, "search_train_allday")
print("하루 전체 조회 (search_train_allday):", "있음" if has_allday else "없음")
if has_allday:
    try:
        print("  search_train_allday", inspect.signature(Korail.search_train_allday))
    except Exception as exc:
        print("  시그니처 확인 실패:", exc)

print("\nreserve 가 받는 인자:")
try:
    print("  reserve", inspect.signature(Korail.reserve))
except Exception as exc:
    print("  확인 실패:", exc)

# 예약대기 신청용 함수나 옵션이 있는지 찾아봅니다.
print("\n예약대기 관련으로 보이는 것:")
hits = []
for name in dir(korail2):
    low = name.lower()
    if "wait" in low or "reserveoption" in low or "option" in low:
        hits.append(name)
for name in dir(Korail):
    if name.startswith("_"):
        continue
    if "wait" in name.lower():
        hits.append(f"Korail.{name}")
print("  " + (", ".join(hits) if hits else "(없음)"))

# ReserveOption 이 있으면 어떤 값이 있는지 봅니다.
ReserveOption = getattr(korail2, "ReserveOption", None)
if ReserveOption is not None:
    opts = [n for n in dir(ReserveOption) if not n.startswith("_")]
    print("  ReserveOption 값:", ", ".join(opts))


# --- 2. 로그인 -------------------------------------------------------------
line("2. 로그인")
load_secrets()
korail_id = os.environ.get("KSKILL_KTX_ID") or input("코레일 아이디: ").strip()
korail_pw = os.environ.get("KSKILL_KTX_PASSWORD") or getpass.getpass("비밀번호(안 보입니다): ")

korail = Korail(korail_id, korail_pw)
print("로그인 상태:", getattr(korail, "logined", "(확인 불가)"))


# --- 3. 하루 전체 조회 -----------------------------------------------------
line("3. 하루 전체 좌석 현황")

dep = (input("출발역 [서울]: ").strip() or "서울").removesuffix("역") or "서울"
arr = (input("도착역 [부산]: ").strip() or "부산").removesuffix("역") or "부산"
raw_date = "".join(c for c in input("날짜 [내일]: ") if c.isdigit())
date = raw_date[:8] if len(raw_date) >= 8 else (dt.date.today() + dt.timedelta(days=1)).strftime("%Y%m%d")

print(f"\n{dep} -> {arr}  {date}  (첫차부터 끝차까지)\n")

def sweep_day(max_calls: int = 15, pause: float = 1.0):
    """search_train 을 시각을 옮겨가며 여러 번 불러 하루를 훑습니다.

    search_train_allday 는 한 번에 끝나지만 include_waiting_list 를 안 받습니다.
    예약대기 정보를 보려면 include_waiting_list 를 받는 search_train 을 써야 하고,
    그건 한 번에 10여 대만 주므로 이렇게 나눠 부릅니다.
    """
    seen = {}
    order = []
    cur = "000000"
    for _ in range(max_calls):
        try:
            batch = korail.search_train(
                dep, arr, date, cur,
                include_no_seats=True, include_waiting_list=True,
            )
        except Exception as exc:
            if type(exc).__name__ in ("NoResultsError", "SoldOutError"):
                break
            raise
        if not batch:
            break

        fresh = 0
        for t in batch:
            key = (getattr(t, "train_no", None), getattr(t, "dep_time", None), str(t))
            if key not in seen:
                seen[key] = t
                order.append(t)
                fresh += 1

        print(f"  ... {cur[:2]}:{cur[2:4]} 이후 {len(batch)}건 (누적 {len(order)}건)")
        last = getattr(batch[-1], "dep_time", None)
        if not last or fresh == 0:
            break                      # 더 나아가지 못하면 멈춥니다
        cur = f"{int(last) + 1:06d}"   # 마지막 열차 1초 뒤부터 이어서
        if cur >= "240000":
            break
        time.sleep(pause)              # 연속 요청 사이에 한 박자 쉽니다
    return order


search_params = inspect.signature(Korail.search_train).parameters
can_ask_waiting = "include_waiting_list" in search_params
asked_waiting = can_ask_waiting

try:
    if can_ask_waiting:
        print("예약대기 정보를 보려면 나눠서 조회해야 합니다. 잠시 걸립니다...\n")
        trains = sweep_day()
    elif has_allday:
        print("(이 버전은 예약대기 조회를 지원하지 않습니다)\n")
        trains = korail.search_train_allday(
            dep, arr, date, "000000",
            **keep_supported(korail.search_train_allday, {"include_no_seats": True}),
        )
    else:
        print("(하루 전체 조회가 없어 앞쪽 일부만 보입니다)\n")
        trains = korail.search_train(dep, arr, date, "000000", include_no_seats=True)
except Exception as exc:
    print(f"[실패] {type(exc).__name__}: {exc}")
    raise SystemExit(1)

print(f"총 {len(trains)}건\n")


def call(train, method: str):
    """train.has_seat() 같은 걸 있으면 부르고, 없으면 None 을 돌려줍니다."""
    fn = getattr(train, method, None)
    if not callable(fn):
        return None
    try:
        return bool(fn())
    except Exception:
        return None


# 이 라이브러리가 예약대기 여부를 알려줄 수 있는지부터 확인합니다.
# 알려줄 수 없는데 "예약대기 0건"이라고 하면 거짓말이 됩니다.
can_judge_wait = bool(trains) and callable(getattr(trains[0], "has_waiting_list", None))
print("예약대기 판단 가능:", "예" if can_judge_wait else "아니오 (has_waiting_list 함수가 없음)")

if trains:
    print("\n첫 열차가 들고 있는 정보 (예약대기 관련 항목이 있는지 보세요):")
    try:
        for k, v in sorted(vars(trains[0]).items()):
            print(f"    {k} = {v!r}")
    except TypeError:
        names = [n for n in dir(trains[0]) if not n.startswith("_")]
        print("    " + ", ".join(names))
print()

free = 0
waitable = 0
soldout = 0
unknown = 0
hidden = []

for t in trains:
    seat = call(t, "has_seat")
    wait = call(t, "has_waiting_list")

    if seat:
        mark, free = "[빈자리]", free + 1
    elif wait:
        mark, waitable = "[예약대기]", waitable + 1
    elif seat is None:
        mark, unknown = "[판단불가]", unknown + 1
    else:
        mark, soldout = "[매진]  ", soldout + 1
        if soldout > 3:
            hidden.append(t)      # 매진은 앞의 3대만 보여줍니다
            continue

    print(f"  {mark} {t}")

if hidden:
    print(f"  ... 외 {len(hidden)}대 매진 (생략)")

line("4. 결론")
print(f"조회된 열차       : {len(trains)}건")
print(f"빈자리 있는 열차   : {free}건")
print(f"매진              : {soldout}건")
if can_judge_wait:
    print(f"예약대기 가능 열차 : {waitable}건")
else:
    print("예약대기 가능 열차 : 알 수 없음 (이 라이브러리가 알려주지 않습니다)")
if unknown:
    print(f"판단 불가         : {unknown}건")

if free:
    print("\n자리가 있습니다. 지금 코레일톡으로 바로 예매하세요.")
elif waitable:
    print(f"\n빈자리는 없지만 예약대기를 걸 수 있는 열차가 {waitable}건 있습니다.")
    print("위 목록에서 [예약대기] 표시된 열차를 코레일톡 앱에서 찾아 신청하세요.")
    print("")
    print("예약대기는 코레일 공식 대기열입니다.")
    print("  - 자리가 나면 코레일이 순서대로 배정합니다")
    print("  - 컴퓨터를 켜두거나 계속 조회할 필요가 없습니다")
    print("  - 이 경우 ktx_watch.py 는 쓰지 않으셔도 됩니다")
elif not can_judge_wait:
    print("\n빈자리는 없습니다. 예약대기는 이 스크립트로 확인할 수 없습니다.")
    print("반드시 코레일톡 앱에서 직접 확인하세요. 앱에는 뜰 수 있습니다.")
else:
    print("\n빈자리도 예약대기도 없습니다.")
    print("남은 방법은 취소표를 기다리는 것뿐입니다.")
    print("  - 코레일톡 앱에도 예약대기가 안 뜨는지 한 번 확인해 보세요")
    print("  - 다른 날짜, 다른 시간대, 구포/밀양 같은 중간역도 보세요")
    print("  - ktx_watch.py --allday 로 취소표를 감시할 수 있습니다")

if not asked_waiting:
    print("\n[주의] 이 조회는 예약대기 열차를 빼고 가져왔을 수 있습니다.")
    print("       (search_train_allday 가 include_waiting_list 를 안 받습니다)")
    print("       예약대기 가능 여부는 코레일톡 앱에서 확인하는 것이 정확합니다.")

print("\n위 출력을 전부 복사해서 보여주시면 더 도와드릴 수 있습니다.")
