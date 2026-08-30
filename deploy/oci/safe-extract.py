#!/usr/bin/env python3
"""Strict tar.gz extraction for an isolated AI Workers restore drill."""

import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile


MAX_MEMBERS = int(os.environ.get("RESTORE_MAX_MEMBERS", "100000"))
MAX_BYTES = int(os.environ.get("RESTORE_MAX_UNCOMPRESSED_BYTES", str(50 * 1024 * 1024 * 1024)))
ALLOWED_FILE_TYPES = {tarfile.REGTYPE, tarfile.AREGTYPE}


class UnsafeArchive(Exception):
    pass


def normalized_member_name(raw_name):
    if not isinstance(raw_name, str) or not raw_name or "\x00" in raw_name or "\\" in raw_name:
        raise UnsafeArchive("archive member has an invalid name")
    if len(raw_name.encode("utf-8", errors="surrogateescape")) > 4096:
        raise UnsafeArchive("archive member name is too long")
    path = PurePosixPath(raw_name)
    if path.is_absolute() or raw_name.startswith("/") or any(part == ".." for part in path.parts):
        raise UnsafeArchive("archive member escapes the restore root")
    parts = tuple(part for part in path.parts if part not in ("", "."))
    return PurePosixPath(*parts)


def inspect_members(archive):
    members = archive.getmembers()
    if len(members) > MAX_MEMBERS:
        raise UnsafeArchive("archive contains too many members")
    total_bytes = 0
    seen = set()
    checked = []
    for member in members:
        normalized = normalized_member_name(member.name)
        if not normalized.parts:
            if member.type != tarfile.DIRTYPE:
                raise UnsafeArchive("archive root entry is not a directory")
            continue
        key = normalized.as_posix()
        if key in seen:
            raise UnsafeArchive("archive contains duplicate member paths")
        seen.add(key)
        if member.type == tarfile.DIRTYPE:
            checked.append((member, normalized, "directory"))
            continue
        if member.type not in ALLOWED_FILE_TYPES:
            raise UnsafeArchive("archive contains a link, device, fifo, or unsupported member")
        if member.size < 0:
            raise UnsafeArchive("archive member has a negative size")
        total_bytes += member.size
        if total_bytes > MAX_BYTES:
            raise UnsafeArchive("archive exceeds the uncompressed restore limit")
        checked.append((member, normalized, "file"))
    return checked, total_bytes


def ensure_safe_parent(root, target):
    if root not in target.parents:
        raise UnsafeArchive("restore target escaped its root")
    current = root
    for part in target.relative_to(root).parts[:-1]:
        current = current / part
        if current.exists() and (current.is_symlink() or not current.is_dir()):
            raise UnsafeArchive("archive parent is not a real directory")
        current.mkdir(mode=0o700, exist_ok=True)


def safe_extract(archive_path, destination):
    archive_path = Path(archive_path).resolve(strict=True)
    destination = Path(destination).resolve()
    if destination.exists() and any(destination.iterdir()):
        raise UnsafeArchive("restore destination must be empty")
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.is_symlink() or not destination.is_dir():
        raise UnsafeArchive("restore destination is not a real directory")

    with tarfile.open(str(archive_path), mode="r:gz", errorlevel=2) as archive:
        checked, total_bytes = inspect_members(archive)
        for member, normalized, kind in checked:
            target = destination.joinpath(*normalized.parts)
            ensure_safe_parent(destination, target)
            if kind == "directory":
                if target.exists() and (target.is_symlink() or not target.is_dir()):
                    raise UnsafeArchive("directory collides with an existing path")
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                os.chmod(target, 0o700)
                continue
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise UnsafeArchive("regular archive member has no data")
            copied = 0
            with source, open(target, "xb") as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > member.size:
                        raise UnsafeArchive("archive member exceeded its declared size")
                    output.write(chunk)
            if copied != member.size:
                raise UnsafeArchive("archive member was truncated")
            os.chmod(target, 0o600)
    return {"members": len(checked), "uncompressedBytes": total_bytes}


def _write_test_archive(path, entries):
    with tarfile.open(path, "w:gz") as archive:
        for entry in entries:
            info = tarfile.TarInfo(entry["name"])
            info.type = entry.get("type", tarfile.REGTYPE)
            info.linkname = entry.get("linkname", "")
            payload = entry.get("payload", b"")
            info.size = len(payload) if info.type in ALLOWED_FILE_TYPES else 0
            archive.addfile(info, io.BytesIO(payload) if info.size else None)


def self_test():
    rejected = 0
    with tempfile.TemporaryDirectory(prefix="aiw-safe-extract-test-") as temp:
        root = Path(temp)
        valid = root / "valid.tar.gz"
        _write_test_archive(valid, [
            {"name": "./", "type": tarfile.DIRTYPE},
            {"name": "./earnings.db", "payload": b"sqlite-placeholder"},
            {"name": "./tenants/", "type": tarfile.DIRTYPE},
            {"name": "./tenants/ten_safe/workers.db", "payload": b"tenant-placeholder"},
        ])
        result = safe_extract(valid, root / "valid-output")
        if result["members"] != 3 or not (root / "valid-output/earnings.db").is_file():
            raise AssertionError("valid archive did not extract as expected")

        cases = [
            {"name": "../escape", "payload": b"x"},
            {"name": "/absolute", "payload": b"x"},
            {"name": "safe\\windows-escape", "payload": b"x"},
            {"name": "symlink", "type": tarfile.SYMTYPE, "linkname": "/etc/passwd"},
            {"name": "hardlink", "type": tarfile.LNKTYPE, "linkname": "../outside"},
            {"name": "character", "type": tarfile.CHRTYPE},
            {"name": "block", "type": tarfile.BLKTYPE},
            {"name": "fifo", "type": tarfile.FIFOTYPE},
        ]
        for index, entry in enumerate(cases):
            archive_path = root / f"unsafe-{index}.tar.gz"
            _write_test_archive(archive_path, [entry])
            try:
                safe_extract(archive_path, root / f"unsafe-output-{index}")
            except UnsafeArchive:
                rejected += 1
            else:
                raise AssertionError(f"unsafe archive case {index} was accepted")
    return {"ok": True, "unsafeCasesRejected": rejected}


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        print(json.dumps(self_test(), sort_keys=True))
        return
    if len(sys.argv) != 3:
        raise UnsafeArchive("usage: safe-extract.py ARCHIVE.tar.gz EMPTY_DESTINATION")
    result = safe_extract(sys.argv[1], sys.argv[2])
    print(json.dumps({"ok": True, **result}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (UnsafeArchive, tarfile.TarError, OSError, ValueError) as error:
        print(f"Unsafe backup rejected: {error}", file=sys.stderr)
        sys.exit(1)
