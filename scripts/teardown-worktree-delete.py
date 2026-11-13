"""Delete a checked candidate using only verified directory-relative operations."""

import json
import os
import posixpath
import stat
import sys


def identity(info):
    return str(info.st_dev), str(info.st_ino)


def verify(info, expected):
    if identity(info) != (expected["dev"], expected["ino"]):
        raise RuntimeError("Checked filesystem identity changed; refusing deletion.")


def main():
    request = json.load(sys.stdin)
    removed = []
    removed_bytes = 0
    entries = {entry["path"]: entry for entry in request["entries"]}
    ancestors = {entry["path"]: entry for entry in request["ancestors"]}
    candidate = request["candidate"]
    children = {}
    for path in entries:
        if path != candidate:
            children.setdefault(posixpath.dirname(path), []).append(posixpath.basename(path))

    def open_directory(parent, name, expected):
        descriptor = os.open(
            name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent
        )
        try:
            verify(os.fstat(descriptor), expected)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def remove(parent, name, path):
        nonlocal removed_bytes
        expected = entries[path]
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        verify(info, expected)
        if path == candidate and stat.S_ISLNK(info.st_mode):
            raise RuntimeError("Candidate became a symlink; refusing deletion.")
        if stat.S_ISDIR(info.st_mode):
            descriptor = open_directory(parent, name, expected)
            try:
                for child in children.get(path, []):
                    remove(descriptor, child, path + "/" + child)
            finally:
                os.close(descriptor)
            verify(os.stat(name, dir_fd=parent, follow_symlinks=False), expected)
            os.rmdir(name, dir_fd=parent)
        elif stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            os.unlink(name, dir_fd=parent)
            if stat.S_ISREG(info.st_mode):
                removed_bytes += info.st_size
        else:
            raise RuntimeError("Unsupported filesystem entry; refusing deletion.")
        removed.append(path)

    try:
        if (
            os.name != "posix"
            or not hasattr(os, "O_NOFOLLOW")
            or not hasattr(os, "O_DIRECTORY")
            or not os.O_NOFOLLOW
            or not os.O_DIRECTORY
            or any(
                operation not in os.supports_dir_fd
                for operation in (os.open, os.stat, os.unlink, os.rmdir)
            )
            or os.stat not in os.supports_follow_symlinks
        ):
            raise RuntimeError("Descriptor-relative deletion is unavailable on this platform.")
        verify(os.fstat(3), request["root"])
        for path in [candidate, *entries, *ancestors]:
            if not path or path.startswith("/") or any(
                part in ("", ".", "..") for part in path.split("/")
            ):
                raise RuntimeError("Invalid relative deletion path.")
            if path in entries and path != candidate and not path.startswith(candidate + "/"):
                raise RuntimeError("Entry is outside the checked candidate.")
        descriptor = os.dup(3)
        try:
            parts = candidate.split("/")
            for index, name in enumerate(parts[:-1]):
                expected = ancestors["/".join(parts[: index + 1])]
                child = open_directory(descriptor, name, expected)
                os.close(descriptor)
                descriptor = child
            remove(descriptor, parts[-1], candidate)
        finally:
            os.close(descriptor)
    except Exception as error:
        deleted = set(removed)
        print(json.dumps({
            "removed": removed, "bytes": removed_bytes,
            "remaining": [path for path in entries if path not in deleted],
            "error": str(error),
        }))
        return 1
    print(json.dumps({"removed": removed, "bytes": removed_bytes, "remaining": []}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
