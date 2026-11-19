// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- This isolated CLI worker owns its process working directory.
import * as NodePath from "node:path";
import { getPhysicalFileSystem } from "@t3tools/shared/physicalFileSystemNode";

// Every filesystem operation after entry uses a single component relative to the held directory.
export function removeAnchored(args: readonly string[]): number {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- A standalone worker has no Effect runtime.
  if (process.platform === "win32") throw new Error("Anchored deletion is unavailable on Windows");
  const [root, relative, dev, ino, cap, duration, ...mounts] = args;
  if (!root || !NodePath.isAbsolute(root) || NodePath.resolve(root) !== root || !relative)
    throw new Error("Invalid deletion path");
  const parts = relative.split("/");
  if (parts.some((name) => !name || name === "." || name === ".." || name === ".git"))
    throw new Error("Invalid deletion component");
  const entriesLimit = Number(cap);
  const deadline = Date.now() + Number(duration);
  if (!Number.isFinite(entriesLimit) || !Number.isFinite(deadline))
    throw new Error("Invalid deletion budget");
  const fs = getPhysicalFileSystem();
  const same = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) =>
    a.dev === b.dev && a.ino === b.ino;
  const here = () => fs.lstatSync(".", { bigint: true });
  const enter = (name: string, expected = fs.lstatSync(name, { bigint: true })) => {
    if (!expected.isDirectory() || expected.isSymbolicLink()) throw new Error("Not a directory");
    process.chdir(name);
    if (!same(here(), expected)) throw new Error("Directory changed");
    return expected;
  };
  process.chdir(NodePath.parse(root).root);
  for (const component of root.split(NodePath.sep).filter(Boolean)) enter(component);
  const rootStat = here();
  if (
    String(rootStat.dev) !== dev ||
    String(rootStat.ino) !== ino ||
    !fs.lstatSync(".git").isFile()
  )
    throw new Error("Root changed");
  let entries = 0;
  let bytes = 0;
  const check = (name: string, current: string) => {
    if (Date.now() >= deadline || ++entries > entriesLimit)
      throw new Error("Deletion budget exceeded");
    const stat = fs.lstatSync(name, { bigint: true });
    if (stat.dev !== rootStat.dev || mounts.includes(current)) throw new Error("Device changed");
    return stat;
  };
  let parent = rootStat;
  let current = root;
  for (const name of parts.slice(0, -1)) {
    current += `/${name}`;
    parent = enter(name, check(name, current));
  }
  const remove = (name: string, current: string, parent: typeof rootStat): void => {
    const stat = check(name, current);
    if (stat.isSymbolicLink()) fs.unlinkSync(name);
    else if (stat.isDirectory()) {
      enter(name, stat);
      const names = fs.readdirSync(".");
      if (
        names.includes(".git") ||
        ["HEAD", "objects", "refs"].every((entry) => names.includes(entry))
      )
        throw new Error("Nested repository");
      if (names.length + entries > entriesLimit) throw new Error("Deletion budget exceeded");
      for (const child of names) remove(child, `${current}/${child}`, stat);
      process.chdir("..");
      if (!same(here(), parent) || !same(fs.lstatSync(name, { bigint: true }), stat))
        throw new Error("Parent changed");
      fs.rmdirSync(name);
    } else if (stat.isFile()) {
      fs.unlinkSync(name);
      if (stat.nlink === 1n) bytes += Number(stat.blocks) * 512;
    } else throw new Error("Special file");
  };
  const name = parts.at(-1)!;
  if (fs.lstatSync(name, { bigint: true }).isSymbolicLink())
    throw new Error("Selected path changed");
  remove(name, `${current}/${name}`, parent);
  return bytes;
}
