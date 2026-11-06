#!/usr/bin/env python3
"""Explicit, serialized refresh of the offline dev seed. Never writes to the source."""
import argparse
import fcntl
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time


def snapshot(source, destination):
    live = (Path.home() / '.styal/userdata').resolve()
    if destination.resolve().is_relative_to(live) or destination.exists():
        raise ValueError('Snapshot destination must be new and outside live userdata')
    # Each backup step releases its source read lock; no enclosing read transaction.
    with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True, timeout=0) as src:
        with sqlite3.connect(destination) as dst:
            src.backup(dst, pages=256, sleep=0.01)


def run_snapshot(source, destination, timeout=30):
    subprocess.run([sys.executable, __file__, '--snapshot', str(source), str(destination)],
                   check=True, timeout=timeout)


def build(source, seed_dir, *, coordination_dir=None):
    live_dir = (Path.home() / '.styal/userdata').resolve()
    output = (seed_dir / 'statev2.sqlite').resolve()
    live_file = (live_dir / 'statev2.sqlite').resolve()
    if seed_dir.resolve().is_relative_to(live_dir) or output in (source.resolve(), live_file):
        raise ValueError('Seed output must be outside live userdata and distinct from source')
    coordination_dir = coordination_dir or Path.home() / '.styal/dev-seed-coordination'
    if coordination_dir.resolve().is_relative_to(live_dir):
        raise ValueError('Coordination must be outside live userdata')
    coordination_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    seed_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (coordination_dir / 'build.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another seed build is running; use the existing seed or start empty.')
            return
        attempt = coordination_dir / 'last-attempt'
        if attempt.exists() and time.time() - attempt.stat().st_mtime < 86400:
            print('Seed refresh already attempted in the last day; use the existing seed or start empty.')
            return
        attempt.touch(mode=0o600)
        # Staging stays beside the seed for atomic publication and private permissions.
        with tempfile.TemporaryDirectory(prefix='build-', dir=seed_dir) as staging:
            staging = Path(staging)
            raw = staging / 'snapshot.sqlite'
            try:
                run_snapshot(source, raw)
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
                print('Seed snapshot failed or exceeded 30s; existing seed retained. Dev can start empty.')
                return
            subprocess.run(['node', 'apps/server/scripts/migrate-dev-db.ts', '--source', str(raw),
                            '--base-dir', str(staging / 'pruned')], check=True,
                           cwd=Path(__file__).resolve().parent.parent)
            result = staging / 'pruned/userdata/statev2.sqlite'
            # The migration closes all connections; publish a standalone database, never a WAL.
            with sqlite3.connect(result) as db:
                db.execute('PRAGMA journal_mode=DELETE')
            result.chmod(0o600)
            os.replace(result, seed_dir / 'statev2.sqlite')
            print('Shared dev seed ready. Refresh worktrees with dev stopped: vp run migrate-dev-db')


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) == 4 and sys.argv[1] == '--snapshot':
        snapshot(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--source', type=Path, default=Path.home() / '.styal/userdata/statev2.sqlite')
        parser.add_argument('--seed-dir', type=Path, default=Path.home() / '.styal/dev-seed')
        args = parser.parse_args()
        live = (Path.home() / '.styal/userdata').resolve()
        if args.seed_dir.resolve().is_relative_to(live):
            parser.error('Seed destination must be outside live userdata')
        build(args.source, args.seed_dir)
