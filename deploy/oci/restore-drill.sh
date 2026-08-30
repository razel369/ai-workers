#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: sudo bash ./deploy/oci/restore-drill.sh /absolute/path/to/ai-workers-data-TIMESTAMP.tar.gz.enc" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
env_file="${repo_root}/.env"
compose_file="${repo_root}/compose.oci.yaml"
manifest_tool="${script_dir}/backup-manifest.mjs"
extractor="${script_dir}/safe-extract.py"

if [ -L "$1" ] || [ ! -f "$1" ]; then
  echo "The selected encrypted archive must be a regular, non-symlink file." >&2
  exit 1
fi
archive="$(realpath -- "$1")"
archive_name="$(basename -- "${archive}")"
manifest="${archive}.manifest"
manifest_signature="${manifest}.hmac"
if [[ ! "${archive_name}" =~ ^ai-workers-data-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.enc$ ]]; then
  echo "The selected file is not a recognized encrypted AI Workers backup." >&2
  exit 1
fi
if [ ! -f "${manifest}" ] || [ -L "${manifest}" ] || [ ! -f "${manifest_signature}" ] || [ -L "${manifest_signature}" ]; then
  echo "The encrypted archive, signed manifest, and manifest HMAC must all exist as regular files." >&2
  exit 1
fi
if [ ! -f "${env_file}" ]; then
  echo "Missing .env; restore secrets and the deployed app image cannot be selected safely." >&2
  exit 1
fi
for command_name in docker openssl node python3; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required restore command is unavailable: ${command_name}" >&2
    exit 1
  fi
done

read_env_value() {
  local key="$1"
  awk -v wanted="${key}" '
    index($0, wanted "=") == 1 { value = substr($0, length(wanted) + 2) }
    END { print value }
  ' "${env_file}"
}

backup_encryption_secret="${BACKUP_ENCRYPTION_SECRET:-}"
backup_manifest_secret="${BACKUP_MANIFEST_SECRET:-}"
if [ -z "${backup_encryption_secret}" ]; then backup_encryption_secret="$(read_env_value BACKUP_ENCRYPTION_SECRET)"; fi
if [ -z "${backup_manifest_secret}" ]; then backup_manifest_secret="$(read_env_value BACKUP_MANIFEST_SECRET)"; fi
if [ "${#backup_encryption_secret}" -lt 32 ] || [ "${#backup_manifest_secret}" -lt 32 ]; then
  echo "Valid backup encryption and manifest secrets are required for a restore drill." >&2
  exit 1
fi
export BACKUP_ENCRYPTION_SECRET="${backup_encryption_secret}"
export BACKUP_MANIFEST_SECRET="${backup_manifest_secret}"

# Authenticate the ciphertext and all decryption parameters before creating any
# plaintext. The helper also binds the manifest to this exact archive filename.
node "${manifest_tool}" verify "${archive}" "${manifest}" "${manifest_signature}" >/dev/null

restore_dir="$(mktemp -d /tmp/ai-workers-restore-drill.XXXXXX)"
plaintext_archive="${restore_dir}/payload.tar.gz"
payload_dir="${restore_dir}/payload"
cleanup() {
  find "${restore_dir}" -depth -mindepth 1 -delete 2>/dev/null || true
  rmdir "${restore_dir}" 2>/dev/null || true
}
trap cleanup EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 \
  -pass env:BACKUP_ENCRYPTION_SECRET \
  -in "${archive}" -out "${plaintext_archive}"
mkdir -m 0700 -- "${payload_dir}"
python3 "${extractor}" "${plaintext_archive}" "${payload_dir}"
rm -f -- "${plaintext_archive}"

# Run SQLite verification without container root. Under sudo we hand the
# isolated temp tree to uid/gid 65534; otherwise use the invoking uid/gid.
if [ "$(id -u)" -eq 0 ]; then
  verify_uid=65534
  verify_gid=65534
  chown -R "${verify_uid}:${verify_gid}" "${payload_dir}"
else
  verify_uid="$(id -u)"
  verify_gid="$(id -g)"
fi
chmod 0700 "${payload_dir}"

cd -- "${repo_root}"
docker compose --env-file "${env_file}" -f "${compose_file}" run --rm --no-deps \
  --user "${verify_uid}:${verify_gid}" \
  --entrypoint node \
  -v "${payload_dir}:/restore:ro" \
  app /app/deploy/oci/verify-restore.mjs /restore

echo "Restore drill passed for ${archive_name}."
echo "The signed ciphertext, strict extraction, and SQLite integrity passed in isolation; live data was not overwritten."
