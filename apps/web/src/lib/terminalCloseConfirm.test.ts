import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { confirmMock, readLocalApiMock } = vi.hoisted(() => {
  const confirmMock = vi.fn<(message: string, options?: unknown) => Promise<boolean>>();
  const readLocalApiMock = vi.fn<
    () =>
      | {
          dialogs: { confirm: (message: string, options?: unknown) => Promise<boolean> };
        }
      | undefined
  >();
  return { confirmMock, readLocalApiMock };
});

vi.mock("~/localApi", () => ({
  readLocalApi: () => readLocalApiMock(),
}));

import {
  confirmTerminalClose,
  isTerminalCloseConfirmPending,
  resolveTerminalCloseConfirmationIds,
} from "./terminalCloseConfirm";

const activeTerminal = {
  terminalId: "term-1",
  label: "Terminal 1",
};

describe("terminal close confirmation", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    readLocalApiMock.mockReset();
    readLocalApiMock.mockReturnValue({ dialogs: { confirm: confirmMock } });
  });

  it("fails closed when the server preflight is unavailable", () => {
    expect(resolveTerminalCloseConfirmationIds([activeTerminal], null)).toEqual(
      new Set(["term-1"]),
    );
    expect(resolveTerminalCloseConfirmationIds([activeTerminal], [])).toEqual(new Set());
  });

  it("tracks pending state until the confirmation settles", async () => {
    let settle: (value: boolean) => void = () => undefined;
    confirmMock.mockImplementation(() => new Promise<boolean>((resolve) => (settle = resolve)));

    expect(isTerminalCloseConfirmPending()).toBe(false);

    const confirmation = confirmTerminalClose([activeTerminal], new Set(["term-1"]));
    expect(isTerminalCloseConfirmPending()).toBe(true);

    settle(true);
    await expect(confirmation).resolves.toBe(true);
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it("clears pending state and resolves false when the dialog rejects", async () => {
    let reject: (reason?: unknown) => void = () => undefined;
    confirmMock.mockImplementation(
      () =>
        new Promise<boolean>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );

    const confirmation = confirmTerminalClose([activeTerminal], new Set(["term-1"]));
    expect(isTerminalCloseConfirmPending()).toBe(true);

    reject(new Error("dialog failed"));
    await expect(confirmation).resolves.toBe(false);
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it("names every terminal in a multi-terminal close", async () => {
    confirmMock.mockResolvedValue(true);

    await expect(
      confirmTerminalClose(
        [
          activeTerminal,
          {
            terminalId: "term-2",
            label: "Development server",
          },
        ],
        new Set(["term-1", "term-2"]),
      ),
    ).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(
      [
        "Close 2 terminals?",
        'This stops running processes in "Terminal 1", "Development server" and clears all 2 terminal histories.',
      ].join("\n"),
      { variant: "destructive" },
    );
  });

  it("closes without prompting when the preflight reports no active work", async () => {
    await expect(
      confirmTerminalClose(
        [
          {
            terminalId: "term-1",
            label: "Terminal 1",
          },
        ],
        new Set(),
      ),
    ).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("names only active terminals when a surface mixes active and idle terminals", async () => {
    confirmMock.mockResolvedValue(true);

    await expect(
      confirmTerminalClose(
        [
          activeTerminal,
          {
            terminalId: "term-2",
            label: "Idle shell",
          },
        ],
        new Set(["term-1"]),
      ),
    ).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(
      [
        "Close 2 terminals?",
        'This stops running processes in "Terminal 1" and clears all 2 terminal histories.',
      ].join("\n"),
      { variant: "destructive" },
    );
  });

  it("closes without prompting when no local API is available", async () => {
    readLocalApiMock.mockReturnValue(undefined);

    await expect(confirmTerminalClose([activeTerminal], new Set(["term-1"]))).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
