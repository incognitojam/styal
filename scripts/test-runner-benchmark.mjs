import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const suite = process.argv[2];
const root = process.cwd();
const outDir = path.join(root, 'benchmark-results');
fs.mkdirSync(outDir, { recursive: true });
const args = {
  server: ['run', '--filter', './apps/server', 'test', '--shard=2/3'],
  web: ['run', '--filter', './apps/web', 'test', '--exclude', '**/imageCompression.test.ts'],
  workspace: ['run', '--parallel', '--concurrency-limit=2', '--filter', './apps/*', '--filter', './infra/*', '--filter', './packages/*', '--filter', './oxlint-plugin-t3code', '--filter', './scripts', '--filter', '!./apps/server', '--filter', '!./apps/web', 'test'],
}[suite];
if (!args) throw new Error('Unknown benchmark suite');
const cases = [
  ['forks', ['--pool=forks']],
  ['threads', ['--pool=threads']],
  ['vmForks', ['--pool=vmForks', '--vmMemoryLimit=512MB']],
  ['cache-cold', ['--pool=forks', '--experimental.fsModuleCache']],
  ['cache-warm', ['--pool=forks', '--experimental.fsModuleCache']],
  ...(suite === 'server' ? [
    ['parallel-2', ['--pool=forks', '--fileParallelism']],
    ['parallel-2-repeat', ['--pool=forks', '--fileParallelism']],
  ] : []),
];
const rows = [];
for (const [name, options] of cases) {
  const logPath = path.join(outDir, `${suite}-${name}.log`);
  const fd = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  if (name.startsWith('cache-')) env.NODE_COMPILE_CACHE = path.join(root, 'node_modules/.cache/test-node-compile');
  const command = [...args, '--maxWorkers=2', '--bail=1', '--reporter=default', `--reporter=${root}/scripts/vitest-ci-exit-reporter.ts`, ...options];
  const start = performance.now();
  const result = spawnSync('timeout', ['--kill-after=10s', '300s', 'vp', ...command], { env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const seconds = Math.round((performance.now() - start) / 10) / 100;
  const row = { suite, name, seconds, status: result.status, signal: result.signal, cpus: os.availableParallelism(), node: process.version };
  rows.push(row);
  console.log(JSON.stringify(row));
  const log = fs.readFileSync(logPath, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  console.log(log.split('\n').filter(line => /Test Files|Tests |Duration|^ FAIL|^Error:/.test(line)).join('\n'));
  fs.writeFileSync(path.join(outDir, `${suite}.json`), JSON.stringify(rows, null, 2));
}
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| Suite | Mode | Seconds | Exit |\n|---|---|---:|---:|\n${rows.map(r => `| ${r.suite} | ${r.name} | ${r.seconds} | ${r.status} |`).join('\n')}\n`);
}
