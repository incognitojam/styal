import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import stat
import tempfile
import unittest
from unittest.mock import patch

HELPER = Path(__file__).with_name("teardown-worktree-delete.py")


class DeletionTests(unittest.TestCase):
    def setUp(self):
        (Path(__file__).resolve().parent.parent / ".scratch").mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            dir=Path(__file__).resolve().parent.parent / ".scratch",
            prefix="teardown-third-review-",
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.helper = runpy.run_path(str(HELPER))

    def request(self):
        entries = []
        pending = [self.root / "node_modules"]
        while pending:
            path = pending.pop()
            info = path.lstat()
            entries.append({"path": str(path.relative_to(self.root)),
                            "dev": str(info.st_dev), "ino": str(info.st_ino)})
            if stat.S_ISDIR(info.st_mode):
                pending.extend(path.iterdir())
        info = self.root.stat()
        return {"root": {"dev": str(info.st_dev), "ino": str(info.st_ino)},
                "rootPath": str(self.root), "candidate": "node_modules",
                "entries": entries, "ancestors": []}

    def invoke(self, request):
        root = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        saved = None
        if root != 3:
            try:
                saved = os.dup(3)
            except OSError:
                pass
            os.dup2(root, 3)
        output = io.StringIO()
        try:
            with patch("sys.stdin", io.StringIO(json.dumps(request))), patch("sys.stdout", output):
                result = self.helper["main"]()
            return result, json.loads(output.getvalue())
        finally:
            if root != 3:
                if saved is not None:
                    os.dup2(saved, 3)
                    os.close(saved)
                else:
                    os.close(3)
            os.close(root)

    def test_different_device_refuses_whole_candidate(self):
        directory = self.root / "node_modules/mount"
        directory.mkdir(parents=True)
        (directory / "source").write_text("synthetic")
        (directory.parent / "before").write_text("synthetic")
        request = self.request()
        device = int(request["root"]["dev"]) + 1
        for entry in request["entries"]:
            if entry["path"].startswith("node_modules/mount"):
                entry["dev"] = str(device)
        original_open, original_stat, original_fstat = os.open, os.stat, os.fstat
        mounted = set()

        def changed(info):
            values = list(info)
            values[2] = device
            return os.stat_result(values)

        def opened(name, flags, *args, **kwargs):
            descriptor = original_open(name, flags, *args, **kwargs)
            inside = name == "mount" or kwargs.get("dir_fd") in mounted
            mounted.discard(descriptor)
            if inside:
                mounted.add(descriptor)
            return descriptor

        def checked(name, *args, **kwargs):
            info = original_stat(name, *args, **kwargs)
            return changed(info) if name == "mount" or kwargs.get("dir_fd") in mounted else info

        def inspected(descriptor):
            info = original_fstat(descriptor)
            return changed(info) if descriptor in mounted else info

        with patch.object(os, "open", opened), patch.object(os, "stat", checked), patch.object(os, "fstat", inspected), patch.object(
            os, "supports_dir_fd", os.supports_dir_fd | {opened, checked}
        ), patch.object(os, "supports_follow_symlinks", os.supports_follow_symlinks | {checked}):
            result, report = self.invoke(request)
        self.assertEqual(result, 1)
        self.assertEqual(report["removed"], [])
        self.assertTrue((directory / "source").exists())
        self.assertTrue((directory.parent / "before").exists())

    def test_mountinfo_refuses_same_device_bind_before_removing_anything(self):
        directory = self.root / "node_modules/mount"
        directory.mkdir(parents=True)
        (directory / "source").write_text("synthetic")
        (directory.parent / "before").write_text("synthetic")
        request = self.request()
        data = ("42 1 0:1 / " + str(directory).replace(" ", r"\040") +
                " rw - none source rw\n").encode()
        original_open = open

        def opened(path, *args, **kwargs):
            return io.BytesIO(data) if path == "/proc/self/mountinfo" else original_open(path, *args, **kwargs)

        with patch("builtins.open", opened), patch("sys.platform", "linux"):
            result, report = self.invoke(request)
        self.assertEqual(result, 1)
        self.assertIn("mount point", report["error"])
        self.assertEqual(report["removed"], [])
        self.assertTrue((directory / "source").exists())
        self.assertTrue((directory.parent / "before").exists())

    def test_mountinfo_parser_escapes_boundaries_and_ancestor_mounts(self):
        parser = self.helper["mount_points"]
        data = (b"42 1 0:1 / /work/a\\040b/node_modules/m\\011n\\134x rw - none source rw\n"
                b"43 1 0:1 / /work/node_modules-other rw - none source rw\n")
        self.assertIn(b"/work/a b/node_modules/m\tn\\x", parser(data))
        refuse = self.helper["refuse_mounts"]
        refuse(data, b"/work", b"node_modules")
        for point in [b"/work/node_modules", b"/work/node_modules/mount", b"/work/parent"]:
            line = b"42 1 0:1 / " + point + b" rw - none source rw\n"
            candidate = b"parent/node_modules" if point.endswith(b"parent") else b"node_modules"
            with self.assertRaisesRegex(RuntimeError, "mount point"):
                refuse(line, b"/work", candidate)

    def test_replaced_opened_directory_is_not_emptied(self):
        for name in ("node_modules", "sub"):
            with self.subTest(name=name):
                directory = self.root / "node_modules/sub"
                directory.mkdir(parents=True)
                (directory / "source").write_text("synthetic")
                (directory.parent / "before").write_text("synthetic")
                request = self.request()
                target = self.root / "node_modules" if name == "node_modules" else directory
                saved = self.root / ("saved-" + name)
                original = os.open
                swapped = False

                def opened(path, flags, *args, **kwargs):
                    nonlocal swapped
                    descriptor = original(path, flags, *args, **kwargs)
                    if path == name and not swapped:
                        swapped = True
                        target.rename(saved)
                        target.mkdir()
                    return descriptor

                with patch.object(os, "open", opened), patch.object(
                    os, "supports_dir_fd", os.supports_dir_fd | {opened}
                ):
                    result, report = self.invoke(request)
                self.assertEqual(result, 1, report)
                self.assertEqual(report["removed"], [])
                source = saved / "sub/source" if name == "node_modules" else saved / "source"
                self.assertEqual(source.read_text(), "synthetic")
                import shutil
                shutil.rmtree(self.root / "node_modules")
                shutil.rmtree(saved)

    def test_old_python_has_clear_minimum_version(self):
        error = io.StringIO()
        with patch("sys.version_info", (3, 7, 0)), contextlib.redirect_stderr(error):
            with self.assertRaises(SystemExit):
                runpy.run_path(str(HELPER))
        self.assertIn("Python 3.8 or newer", error.getvalue())

    def test_iterative_walk_beyond_recursion_limit(self):
        path = self.root / "node_modules"
        path.mkdir()
        for _ in range(1010):
            path = path / "n"
            path.mkdir()
        (path / "file").write_text("synthetic")
        result, report = self.invoke(self.request())
        self.assertEqual(result, 0, report)
        self.assertFalse((self.root / "node_modules").exists())


if __name__ == "__main__":
    unittest.main()
