// @effect-diagnostics nodeBuiltinImport:off -- A separate process holds a Windows FileShare.None handle.
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";

export const withWindowsLock = (file: string) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeChildProcess.ChildProcess>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            "pwsh",
            [
              "-NoProfile",
              "-Command",
              "$f = [IO.File]::Open($env:LOCK_FILE, 'Open', 'ReadWrite', 'None'); [Console]::WriteLine('ready'); [Console]::In.ReadLine(); $f.Dispose()",
            ],
            { env: { ...process.env, LOCK_FILE: file }, stdio: ["pipe", "pipe", "pipe"] },
          );
          let output = "";
          child.once("error", reject);
          child.stdout!.on("data", (chunk) => {
            output += String(chunk);
            if (output.includes("ready\n") || output.includes("ready\r\n")) resolve(child);
          });
          child.once("exit", (code) => reject(new Error(`Lock holder exited ${code}`)));
        }),
    ),
    (child) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.stdin!.end("done\n");
          }),
      ),
  );
