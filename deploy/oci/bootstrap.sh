#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [ "${EUID}" -ne 0 ]; then
  echo "Run this once as root: sudo bash ./deploy/oci/bootstrap.sh" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

if [ ! -f "${repo_root}/compose.oci.yaml" ] || [ ! -f "${repo_root}/package.json" ]; then
  echo "Could not locate the AI Workers repository root." >&2
  exit 1
fi

if [ ! -r /etc/os-release ]; then
  echo "This bootstrap expects an Ubuntu Oracle A1 VM." >&2
  exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "Unsupported OS '${ID:-unknown}'. Create the documented Ubuntu AArch64 image." >&2
  exit 1
fi

if [ "${VERSION_ID:-}" != "24.04" ]; then
  echo "Unsupported Ubuntu version '${VERSION_ID:-unknown}'. Use the documented Ubuntu 24.04 image." >&2
  exit 1
fi

if [ "$(uname -m)" != "aarch64" ]; then
  echo "Unsupported architecture '$(uname -m)'. Use the Always Free A1 ARM64 shape." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git docker.io docker-compose-v2 openssl python3 rclone
systemctl enable --now docker

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is unavailable; no application service was started." >&2
  exit 1
fi

install -d -m 0750 "${repo_root}/data" "${repo_root}/backups"

if [ ! -e "${repo_root}/.env" ]; then
  install -m 0600 "${repo_root}/.env.oci.example" "${repo_root}/.env"
  echo "Created ${repo_root}/.env from the safe template."
else
  chmod 0600 "${repo_root}/.env"
  echo "Kept the existing ${repo_root}/.env file."
fi

echo
echo "Bootstrap complete; nothing has been deployed yet."
echo "Next: edit ${repo_root}/.env, replace every REPLACE_ME value, then run:"
echo "  cd ${repo_root}"
echo "  sudo bash ./deploy/oci/deploy.sh"
