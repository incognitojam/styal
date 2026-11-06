import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('seed', Path(__file__).with_name('build-dev-seed.py'))
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class SeedTest(unittest.TestCase):
    def test_snapshot_and_failed_refresh_preserve_old_seed(self):
        with tempfile.TemporaryDirectory(dir='.scratch', prefix='dev-seed-test-') as directory:
            root = Path(directory)
            source = root / 'source.sqlite'
            with sqlite3.connect(source) as db:
                db.execute('CREATE TABLE data(value)')
                db.execute("INSERT INTO data VALUES ('synthetic')")
            seed.snapshot(source, root / 'copy.sqlite')
            with sqlite3.connect(root / 'copy.sqlite') as db:
                self.assertEqual(db.execute('SELECT value FROM data').fetchone(), ('synthetic',))
            shared = root / 'seed'
            shared.mkdir()
            old = shared / 'statev2.sqlite'
            old.write_bytes(b'old seed')
            with patch.object(seed.subprocess, 'run', side_effect=seed.subprocess.TimeoutExpired('snapshot', 30)) as run:
                seed.build(source, shared, coordination_dir=shared)
                seed.build(source, shared, coordination_dir=shared)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.kwargs['timeout'], 30)
            self.assertEqual(old.read_bytes(), b'old seed')
            with (shared / 'build.lock').open('a') as lock:
                seed.fcntl.flock(lock, seed.fcntl.LOCK_EX | seed.fcntl.LOCK_NB)
                (shared / 'last-attempt').unlink()
                with patch.object(seed.subprocess, 'run') as run:
                    seed.build(source, shared, coordination_dir=shared)
                    run.assert_not_called()
            with self.assertRaises(ValueError):
                seed.snapshot(source, source)

    def test_publish_failure_aliases_and_real_deadline(self):
        with tempfile.TemporaryDirectory(dir='.scratch', prefix='dev-seed-publish-') as directory:
            root = Path(directory).resolve()
            source = root / 'statev2.sqlite'
            with sqlite3.connect(source) as db:
                db.execute('CREATE TABLE synthetic(value)')
            shared = root / 'seed'
            coordination = root / 'coordination'
            def prune(command, **kwargs):
                target = Path(command[-1]) / 'userdata/statev2.sqlite'
                target.parent.mkdir(parents=True)
                with sqlite3.connect(target) as db:
                    db.execute('CREATE TABLE pruned(value)')
            with patch.object(seed, 'run_snapshot', side_effect=lambda src, dst: seed.snapshot(src, dst)), patch.object(seed.subprocess, 'run', side_effect=prune):
                seed.build(source, shared, coordination_dir=coordination)
            with sqlite3.connect(shared / 'statev2.sqlite') as db:
                self.assertEqual(db.execute('SELECT name FROM sqlite_master').fetchone(), ('pruned',))
            before = (shared / 'statev2.sqlite').read_bytes()
            (coordination / 'last-attempt').unlink()
            with patch.object(seed, 'run_snapshot', side_effect=lambda src, dst: seed.snapshot(src, dst)), patch.object(seed.subprocess, 'run', side_effect=seed.subprocess.CalledProcessError(1, 'prune')):
                with self.assertRaises(seed.subprocess.CalledProcessError):
                    seed.build(source, shared, coordination_dir=coordination)
            self.assertEqual((shared / 'statev2.sqlite').read_bytes(), before)
            with self.assertRaises(ValueError):
                seed.build(shared / 'statev2.sqlite', shared, coordination_dir=coordination)
            home = root / 'home'
            live = home / '.styal/userdata'
            live.mkdir(parents=True)
            (live / 'statev2.sqlite').symlink_to(source)
            with patch.object(seed.Path, 'home', return_value=home):
                with self.assertRaises(ValueError):
                    seed.build(root / 'other.sqlite', root, coordination_dir=coordination)
                alias = root / 'alias'
                alias.symlink_to(live, target_is_directory=True)
                with self.assertRaises(ValueError):
                    seed.build(source, alias, coordination_dir=coordination)
            # A locked synthetic source forces the actual snapshot child past its deadline.
            children = []
            popen = seed.subprocess.Popen
            def capture(*args, **kwargs):
                child = popen(*args, **kwargs)
                children.append(child)
                return child
            with sqlite3.connect(source) as db:
                db.execute('BEGIN EXCLUSIVE')
                with patch.object(seed.subprocess, 'Popen', side_effect=capture):
                    with self.assertRaises(seed.subprocess.TimeoutExpired):
                        seed.run_snapshot(source, root / 'timed-out.sqlite', timeout=0.2)
            self.assertEqual(len(children), 1)
            self.assertIsNotNone(children[0].poll())


if __name__ == '__main__':
    unittest.main()
