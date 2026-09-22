#!/usr/bin/env bash
# KTX 감시 봇을 Ubuntu 서버에 설치합니다.
#
#   sudo bash deploy/setup-ubuntu.sh
#
# 여러 번 실행해도 안전합니다. secrets.env 는 절대 덮어쓰지 않습니다.

set -euo pipefail

PREFIX="${PREFIX:-/opt/ktx-bot}"
SERVICE_USER="${SERVICE_USER:-ktxbot}"
SECRETS_DIR="$PREFIX/.config/k-skill"
SECRETS="$SECRETS_DIR/secrets.env"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "이 스크립트는 관리자 권한이 필요합니다. 앞에 sudo 를 붙여 주세요:" >&2
  echo "  sudo bash $0" >&2
  exit 1
fi

say "1/6 필요한 패키지 설치"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip ca-certificates
info "python3 $(python3 --version 2>&1 | awk '{print $2}')"

say "2/6 전용 사용자 만들기"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  info "$SERVICE_USER 사용자가 이미 있습니다"
else
  # 로그인 불가능한 시스템 계정. 봇이 털려도 서버 전체로 번지지 않게 합니다.
  useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER"
  info "$SERVICE_USER 사용자를 만들었습니다"
fi

say "3/6 파일 복사"
mkdir -p "$PREFIX"
for f in ktx_bot.py ktx_watch.py; do
  if [ ! -f "$SRC_DIR/$f" ]; then
    echo "[중단] $SRC_DIR/$f 이 없습니다. 레포 폴더 안에서 실행하세요." >&2
    exit 1
  fi
  install -m 0644 "$SRC_DIR/$f" "$PREFIX/$f"
  info "$f"
done

say "4/6 파이썬 라이브러리 설치"
if [ ! -x "$PREFIX/venv/bin/python" ]; then
  python3 -m venv "$PREFIX/venv"
fi
"$PREFIX/venv/bin/pip" install --quiet --upgrade pip
"$PREFIX/venv/bin/pip" install --quiet korail2-ncard pycryptodome
info "korail2-ncard, pycryptodome 준비 완료"

say "5/6 비밀 파일 준비"
mkdir -p "$SECRETS_DIR"
if [ -f "$SECRETS" ]; then
  info "이미 있습니다. 건드리지 않습니다: $SECRETS"
else
  cat > "$SECRETS" <<'TEMPLATE'
# 아래 네 줄을 실제 값으로 채우세요. 따옴표 없이, 등호 앞뒤 공백 없이.
KSKILL_KTX_ID=
KSKILL_KTX_PASSWORD=
KSKILL_TELEGRAM_TOKEN=
KSKILL_TELEGRAM_CHAT_ID=
TEMPLATE
  info "빈 양식을 만들었습니다: $SECRETS"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"
chmod 700 "$SECRETS_DIR"
chmod 600 "$SECRETS"

say "6/6 서비스 등록"
# systemctl 명령이 있어도 systemd 가 실제로 돌고 있지 않으면(컨테이너 등)
# daemon-reload 가 실패합니다. /run/systemd/system 이 있는지로 판별합니다.
HAVE_SYSTEMD=0
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  HAVE_SYSTEMD=1
fi

if [ "$HAVE_SYSTEMD" -eq 1 ]; then
  install -m 0644 "$SRC_DIR/deploy/ktx-bot.service" /etc/systemd/system/ktx-bot.service
  systemctl daemon-reload
  systemctl enable ktx-bot >/dev/null 2>&1 || true
  info "등록했습니다. 재부팅해도 자동으로 켜집니다"
  info "아직 시작하지는 않았습니다"
else
  info "systemd 가 돌고 있지 않아 서비스 등록을 건너뜁니다"
  info "직접 실행: $PREFIX/venv/bin/python $PREFIX/ktx_bot.py"
fi

# 값이 다 찼는지 확인합니다. 값 자체는 절대 출력하지 않습니다.
missing=()
for key in KSKILL_KTX_ID KSKILL_KTX_PASSWORD KSKILL_TELEGRAM_TOKEN KSKILL_TELEGRAM_CHAT_ID; do
  value="$(grep -E "^${key}=" "$SECRETS" 2>/dev/null | head -1 | cut -d= -f2-)"
  [ -z "$value" ] && missing+=("$key")
done

echo
if [ ${#missing[@]} -eq 0 ] && [ "$HAVE_SYSTEMD" -eq 1 ]; then
  say "설치 완료. 이제 시작하세요."
  echo "    sudo systemctl start ktx-bot"
  echo "    sudo systemctl status ktx-bot     # 잘 떴는지 확인"
  echo "    sudo journalctl -u ktx-bot -f     # 실시간 로그"
elif [ ${#missing[@]} -eq 0 ]; then
  say "설치 완료."
  echo "    $PREFIX/venv/bin/python $PREFIX/ktx_bot.py"
else
  say "설치 완료. 다만 아직 채워야 할 값이 있습니다."
  for key in "${missing[@]}"; do echo "    $key"; done
  echo
  echo "    sudo nano $SECRETS"
  echo
  echo "채운 뒤에 시작하세요:"
  echo "    sudo systemctl start ktx-bot"
fi
echo
