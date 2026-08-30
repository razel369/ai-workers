#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
env_file="${repo_root}/.env"
compose_file="${repo_root}/compose.oci.yaml"

if [ ! -f "${env_file}" ]; then
  echo "Missing .env. Run sudo ./deploy/oci/bootstrap.sh first." >&2
  exit 1
fi

if [ "$(stat -c '%a' "${env_file}")" != "600" ]; then
  echo ".env must have mode 600. Run: chmod 600 .env" >&2
  exit 1
fi

if sed -n '/^[[:space:]]*#/d; /REPLACE_ME/p' "${env_file}" | read -r _placeholder; then
  echo ".env still contains REPLACE_ME; deployment stopped before build/start." >&2
  exit 1
fi

domain="$(sed -n 's/^AI_WORKERS_DOMAIN=//p' "${env_file}" | tail -n 1)"
if [[ ! "${domain}" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  echo "AI_WORKERS_DOMAIN must be a plain public hostname, without https:// or a path." >&2
  exit 1
fi

cd -- "${repo_root}"
docker compose --env-file "${env_file}" -f "${compose_file}" config --quiet
docker compose --env-file "${env_file}" -f "${compose_file}" up -d --build

echo "Deployment started. Verify all gates before publishing:"
echo "  curl -fsS https://${domain}/health"
echo "  curl -fsS https://${domain}/infra-ready"
echo "  curl -fsS https://${domain}/ready"
