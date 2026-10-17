// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  readConfirmDialogState,
  requestConfirmDialog,
  resetConfirmDialogForTests,
} from "../confirmDialog";
import { ConfirmDialogHost } from "./ConfirmDialogHost";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetConfirmDialogForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ConfirmDialogHost />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetConfirmDialogForTests();
  vi.unstubAllGlobals();
});

function button(label: string) {
  const element = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  if (!element) throw new Error(`Missing ${label} button`);
  return element;
}

it("keeps Cancel available while loading and enables Update when the check finishes", async () => {
  let finish!: (content: { message: string }) => void;
  const check = new Promise<{ message: string }>((resolve) => {
    finish = resolve;
  });
  let confirmation: Promise<boolean> | undefined;
  await act(async () => {
    confirmation = requestConfirmDialog(
      "Update the Lab server?\nChecking for running work…",
      {
        confirmLabel: "Update",
      },
      { prepare: () => check },
    );
  });

  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Checking for running work…");
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  expect(button("Update").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(false);
  await act(async () => button("Update").click());
  expect(readConfirmDialogState()).toMatchObject({ status: "confirming", loading: true });

  await act(async () =>
    finish({ message: "Update the Lab server?\n1 thread will be interrupted." }),
  );
  expect(document.querySelector('[role="alertdialog"]')).toBe(dialog);
  expect(dialog?.textContent).toContain("1 thread will be interrupted.");
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(button("Update").disabled).toBe(false);
  await act(async () => button("Update").click());
  await expect(confirmation).resolves.toBe(true);
});

it("closes on Cancel during loading and stays closed when the check finishes", async () => {
  let finish!: (content: null) => void;
  const check = new Promise<null>((resolve) => {
    finish = resolve;
  });
  let confirmation: Promise<boolean> | undefined;
  await act(async () => {
    confirmation = requestConfirmDialog(
      "Update the Lab server?\nChecking for running work…",
      {
        confirmLabel: "Update",
      },
      { prepare: () => check },
    );
  });
  await act(async () => button("Cancel").click());
  await expect(confirmation).resolves.toBe(false);
  await act(async () => finish(null));
  expect(readConfirmDialogState().status).not.toBe("confirming");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});
