// @vitest-environment jsdom

import type { PullRequestDeployment } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { openLink, toast } = vi.hoisted(() => ({ openLink: vi.fn(), toast: vi.fn() }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => openLink }));
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));

import { PullRequestDeployments } from "./PullRequestDeployments";

const headSha = "a".repeat(40);
const deployment: PullRequestDeployment = {
  id: "deployment-1",
  environment: "web-preview",
  status: "failure",
  description: "The preview build failed. Inspect the deployment logs.",
  environmentUrl: null,
  logUrl: "https://example.com/deployment/logs",
  commitSha: "b".repeat(40),
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  openLink.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(
  value: PullRequestDeployment | PullRequestDeployment[] = deployment,
  props: { headSha?: string; truncated?: boolean } = {},
) {
  await act(async () =>
    root.render(
      <PullRequestDeployments
        deployments={Array.isArray(value) ? value : [value]}
        threadRef={null}
        {...props}
        truncated={props.truncated ?? false}
      />,
    ),
  );
}

function button(label: string) {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

it("explains failure without hover and updates when the current commit deploys", async () => {
  await render(deployment, { headSha, truncated: true });
  expect(container.querySelector("p")?.textContent).toBe(deployment.description);
  expect(container.textContent).toContain(deployment.commitSha.slice(0, 7));
  expect(container.textContent).toContain("Environments not deployed recently may be missing.");

  vi.spyOn(console, "error").mockImplementation(() => {});
  openLink.mockRejectedValueOnce(new Error("Browser unavailable"));
  await act(async () => button("View deployment logs for web-preview").click());
  expect(toast).toHaveBeenCalledWith({ type: "error", title: "Unable to open deployment" });

  await render(
    { ...deployment, status: "pending", description: null, commitSha: headSha },
    { headSha },
  );
  expect(container.textContent).toContain("Pending");
  expect(container.textContent).not.toContain(headSha.slice(0, 7));
  expect(container.textContent).not.toContain(deployment.description);
  expect(container.textContent).not.toContain("may be missing");
  expect(container.querySelector('button[aria-label="Open web-preview"]')).toBeNull();

  await render(
    {
      ...deployment,
      status: "success",
      description: null,
      commitSha: headSha,
      environmentUrl: "https://preview.example.com",
    },
    { headSha },
  );
  expect(container.textContent).toContain("Deployed");
  await act(async () => button("Open web-preview").click());
  expect(openLink).toHaveBeenLastCalledWith("https://preview.example.com");
});

it("keeps inactive previews closed while logs remain available, and does not guess an unknown head", async () => {
  await render({
    ...deployment,
    status: "inactive",
    environmentUrl: "https://preview.example.com",
  });
  expect(container.textContent).toContain("Inactive");
  expect(container.querySelector('button[aria-label="Open web-preview"]')).toBeNull();
  expect(container.textContent).toContain(deployment.commitSha.slice(0, 7));
  await act(async () => button("View deployment logs for web-preview").click());
  expect(openLink).toHaveBeenCalledWith(deployment.logUrl);
});

it("lists failures first and keeps the rest behind Show all", async () => {
  const environments = ["a", "b", "c", "d", "e", "f"].map((environment): PullRequestDeployment => ({
    ...deployment,
    id: environment,
    environment,
    status: "success",
    commitSha: headSha,
  }));
  environments[5] = { ...environments[5]!, status: "failure" };
  await render(environments, { headSha });
  const names = () =>
    [...container.querySelectorAll("li .font-medium")].map((node) => node.textContent);
  expect(names()).toEqual(["f", "a", "b", "c", "d"]);

  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Show all 6")!
      .click(),
  );
  expect(names()).toEqual(["f", "a", "b", "c", "d", "e"]);
});
