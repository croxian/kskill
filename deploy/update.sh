#!/usr/bin/env bash
# 최신 코드를 받아 서버에 반영하고 봇을 다시 시작합니다.
#
#   cd ~/kskill && bash deploy/update.sh
#
# sudo 를 앞에 붙이지 마세요. 필요한 부분에서만 알아서 씁니다.

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "sudo 없이 실행하세요:  bash deploy/update.sh" >&2
  exit 1
fi

say "1/4 내가 고친 파일이 있는지 확인"
DIRTY=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  DIRTY=1
  echo "    직접 고친 파일이 있습니다:"
  git --no-pager diff --name-only | sed 's/^/      /'
  echo "    이 수정을 그대로 서버에 반영합니다"
else
  echo "    깨끗합니다"
fi

say "2/4 최신 코드 받기"
if [ "$DIRTY" -eq 1 ]; then
  # 고친 파일이 있으면 받아오기를 건너뜁니다. pull 이 수정을 덮어쓸 수
  # 있기 때문입니다. 배포는 그대로 진행합니다 - 고친 목적이 반영이므로
  # 여기서 멈추면 아무것도 반영되지 않습니다.
  echo "    내 수정이 있어 받아오기는 건너뜁니다"
  echo "    나중에 최신 코드까지 받으려면:"
  echo "      git stash && git pull --ff-only && git stash pop"
else
  BEFORE="$(git rev-parse HEAD)"
  git pull --ff-only
  AFTER="$(git rev-parse HEAD)"
  if [ "$BEFORE" = "$AFTER" ]; then
    echo "    이미 최신입니다"
  else
    echo "    바뀐 파일:"
    git --no-pager diff --name-only "$BEFORE" "$AFTER" | sed 's/^/      /'
  fi
fi

say "3/4 서버에 반영 (/opt/ktx-bot 으로 복사)"
sudo bash deploy/setup-ubuntu.sh >/dev/null
echo "    완료"

say "4/4 봇 다시 시작"
sudo systemctl restart ktx-bot
sleep 2
sudo systemctl status ktx-bot --no-pager | head -12

echo
say "반영 확인"
for f in ktx_watch.py ktx_bot.py; do
  if cmp -s "$f" "/opt/ktx-bot/$f"; then
    echo "    $f : 서버와 일치"
  else
    echo "    $f : 다릅니다 (반영 실패)"
  fi
done
echo
echo "    서버에 적용된 조회 간격:"
grep -E "^MIN_INTERVAL_SEC|^MIN_INTERVAL_ALLDAY" /opt/ktx-bot/ktx_watch.py | sed 's/^/      /'

echo
echo "로그를 보려면:  sudo journalctl -u ktx-bot -f"
echo
