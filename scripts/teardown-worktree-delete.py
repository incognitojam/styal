"""Delete a checked candidate using verified directory-relative operations."""

import sys

if sys.version_info < (3, 8):
    sys.stderr.write("Worktree stripping requires Python 3.8 or newer.\n")
    sys.exit(1)

import contextlib
import json
import os
import posixpath
import re
import stat


def verify(info, expected):
    if (str(info.st_dev), str(info.st_ino)) != (expected["dev"], expected["ino"]):
        raise RuntimeError("Checked filesystem identity changed; refusing deletion.")


def mount_points(data):
    if not data.strip():
        raise RuntimeError("Cannot read Linux mountinfo; refusing deletion.")
    points = set()
    for line in data.splitlines():
        fields = line.split()
        if len(fields) < 10 or b"-" not in fields[6:]:
            raise RuntimeError("Cannot parse Linux mountinfo; refusing deletion.")
        points.add(re.sub(rb"\\([0-7]{3})", lambda match: bytes([int(match[1], 8)]), fields[4]))
    return points


def refuse_mounts(data, root, candidate):
    target = posixpath.join(root, candidate)
    for point in mount_points(data):
        inside_root = point.startswith(root.rstrip(b"/") + b"/")
        if point == target or point.startswith(target + b"/") or (
            inside_root and target.startswith(point.rstrip(b"/") + b"/")
        ):
            raise RuntimeError("Candidate crosses a mount point; refusing deletion.")


def main():
    request = json.load(sys.stdin)
    removed = []
    observed_bytes = 0
    entries = {entry["path"]: entry for entry in request["entries"]}
    identities = {entry["path"]: entry for entry in request["ancestors"]}
    identities.update(entries)
    identities[""] = request["root"]
    candidate = request["candidate"]
    root_device = int(request["root"]["dev"])
    children = {}
    for path in entries:
        if path != candidate:
            children.setdefault(posixpath.dirname(path), []).append(posixpath.basename(path))

    def directory_info(info, expected):
        if info.st_dev != root_device:
            raise RuntimeError("Candidate crosses a filesystem device; refusing deletion.")
        verify(info, expected)

    @contextlib.contextmanager
    def opened_path(path):
        descriptor = os.dup(3)
        try:
            prefix = ""
            for name in path.split("/") if path else []:
                prefix = posixpath.join(prefix, name)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                try:
                    directory_info(os.fstat(child), identities[prefix])
                except BaseException:
                    os.close(child)
                    raise
                os.close(descriptor)
                descriptor = child
            directory_info(os.fstat(descriptor), identities[path])
            yield descriptor
        finally:
            os.close(descriptor)

    def reachable(path, descriptor):
        directory_info(os.fstat(descriptor), identities[path])
        with opened_path(path) as current:
            verify(os.fstat(current), identities[path])
            if os.fstat(current).st_ino != os.fstat(descriptor).st_ino:
                raise RuntimeError("Directory is no longer reachable at its checked path.")

    def checked_entry(path):
        with opened_path(posixpath.dirname(path)) as parent:
            info = os.stat(posixpath.basename(path), dir_fd=parent, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                directory_info(info, entries[path])
            else:
                verify(info, entries[path])
            return info

    try:
        if (
            os.name != "posix"
            or not getattr(os, "O_NOFOLLOW", 0)
            or not getattr(os, "O_DIRECTORY", 0)
            or any(operation not in os.supports_dir_fd for operation in (os.open, os.stat, os.unlink, os.rmdir))
            or os.stat not in os.supports_follow_symlinks
        ):
            raise RuntimeError("Descriptor-relative deletion is unavailable on this platform.")
        directory_info(os.fstat(3), request["root"])
        for path in [candidate, *entries, *identities]:
            if path == "":
                continue
            try:
                path.encode("utf-8", "strict")
            except UnicodeError:
                raise RuntimeError("Non-UTF-8 filename; refusing the whole candidate.")
            if path.startswith("/") or any(part in ("", ".", "..") for part in path.split("/")):
                raise RuntimeError("Invalid relative deletion path.")
            if path in entries and path != candidate and not path.startswith(candidate + "/"):
                raise RuntimeError("Entry is outside the checked candidate.")
        if sys.platform.startswith("linux"):
            with open("/proc/self/mountinfo", "rb") as source:
                refuse_mounts(source.read(), os.fsencode(request["rootPath"]), os.fsencode(candidate))

        # Preflight the complete candidate before its first unlink or rmdir.
        directories = set()
        pending = [candidate]
        while pending:
            path = pending.pop()
            info = checked_entry(path)
            if path == candidate and stat.S_ISLNK(info.st_mode):
                raise RuntimeError("Candidate became a symlink; refusing deletion.")
            if stat.S_ISDIR(info.st_mode):
                directories.add(path)
                with opened_path(path) as descriptor:
                    reachable(path, descriptor)
                    names = os.listdir(descriptor)
                    try:
                        for name in names:
                            name.encode("utf-8", "strict")
                    except UnicodeError:
                        raise RuntimeError("Non-UTF-8 filename; refusing the whole candidate.")
                    if set(names) != set(children.get(path, [])):
                        raise RuntimeError("Candidate contents changed; refusing deletion.")
                pending.extend(path + "/" + name for name in names)
            elif not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                raise RuntimeError("Unsupported filesystem entry; refusing deletion.")

        pending = [(candidate, False)]
        while pending:
            path, visited = pending.pop()
            if path in directories and not visited:
                with opened_path(path) as descriptor:
                    reachable(path, descriptor)
                pending.append((path, True))
                pending.extend((path + "/" + name, False) for name in reversed(children.get(path, [])))
                continue
            parent_path = posixpath.dirname(path)
            name = posixpath.basename(path)
            with opened_path(parent_path) as parent:
                reachable(parent_path, parent)
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                verify(info, entries[path])
                if path in directories:
                    os.rmdir(name, dir_fd=parent)
                else:
                    os.unlink(name, dir_fd=parent)
                    if stat.S_ISREG(info.st_mode):
                        observed_bytes += info.st_size
            removed.append(path)
    except Exception as error:
        deleted = set(removed)
        print(json.dumps({"removed": removed, "bytes": observed_bytes,
                          "remaining": [path for path in entries if path not in deleted],
                          "error": str(error)}))
        return 1
    print(json.dumps({"removed": removed, "bytes": observed_bytes, "remaining": []}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
