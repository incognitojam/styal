import { enableCliCompileCache } from "./cliCompileCache.ts";

// Packaged builds load this graph with require(esm): top-level await anywhere in it breaks them.
// ACP bridges, managed Codex token renewal, Claude history and pairing dispatch before the full
// CLI module graph (seconds of evaluation) loads to keep their startup latency low.
export async function runCliCommand() {
  const command = process.argv[2];
  // Install the socket guard before importing code that can open outbound connections.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "__worktree-cleanup") {
    const { removeAnchored } = await import("./worktreeCleanup/deletionWorker.ts");
    process.stdout.write(String(removeAnchored(process.argv.slice(3))));
  } else if (command === "__document-text") {
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
    } catch (error) {
      if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
        throw error;
      }
      // Exit 2 identifies document rejections; OS and process failures remain retryable.
      process.exitCode = 2;
    }
  } else if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("./cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (command === "__claude-history") {
    const { runClaudeHistoryWorker } = await import("./claudeHistoryWorker.ts");
    const [method, sessionId, rawOptions] = process.argv.slice(3);
    await runClaudeHistoryWorker(method, sessionId, rawOptions);
  } else if (command === "pair") {
    const { runPairCli } = await import("./binPair.ts");
    await runPairCli();
  } else if (command === "__speech-worker") {
    const mode = process.argv[3];
    if (mode !== "discover" && mode !== "model") throw new Error("Unknown speech worker mode.");
    const { runNativeSpeechWorker } = await import("./speech/native.ts");
    await runNativeSpeechWorker(mode, process.argv[4]);
  } else {
    enableCliCompileCache();
    // Windows desktop launches without stdin; attach before reading, except on fast paths using pipes.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    const importStart = performance.now();
    const { runCli } = await import("./binCli.ts");
    if (process.env.T3CODE_STARTUP_PROFILE_DIR) {
      performance.measure("server.import.binCli", { start: importStart });
    }
    runCli();
  }
}
