import {
  EnvironmentId,
  FORK_CLIENT_USAGE_VERSION,
  type PullRequestDeployment,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

const { openLink, toast, readConfig, run } = vi.hoisted(() => ({
  openLink: vi.fn(),
  toast: vi.fn(),
  readConfig: vi.fn(),
  run: vi.fn(),
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => openLink }));
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: readConfig } }));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: (id: unknown) => id, reportForkClientUsage: { run } },
}));

import { PullRequestDeployments } from "./PullRequestDeployments";

const headSha = "a".repeat(40);
const environmentId = EnvironmentId.make("synthetic-deployment-environment");
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

function setup() {
  openLink.mockReset().mockResolvedValue(undefined);
  toast.mockReset();
  readConfig.mockReset().mockReturnValue({
    environment: { capabilities: { forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION } },
  });
  run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
}

function deployments(
  value: PullRequestDeployment | PullRequestDeployment[] = deployment,
  props: { headSha?: string; truncated?: boolean } = {},
) {
  return (
    <PullRequestDeployments
      environmentId={environmentId}
      deployments={Array.isArray(value) ? value : [value]}
      threadRef={null}
      {...props}
      truncated={props.truncated ?? false}
    />
  );
}

function button(container: HTMLElement, label: string) {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

it("explains failure without hover and updates when the current commit deploys", async () => {
  setup();
  await using screen = await render(deployments(deployment, { headSha, truncated: true }));
  const { container } = screen;
  expect(run).not.toHaveBeenCalled();
  expect(container.querySelector("p")?.textContent).toBe(deployment.description);
  expect(container.textContent).toContain(deployment.commitSha.slice(0, 7));
  expect(container.textContent).toContain("Environments not deployed recently may be missing.");

  using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  openLink.mockRejectedValueOnce(new Error("Browser unavailable"));
  await act(async () => button(container, "View deployment logs for web-preview").click());
  expect(toast).toHaveBeenCalledWith({ type: "error", title: "Unable to open deployment" });
  expect(run).toHaveBeenLastCalledWith(expect.anything(), {
    environmentId,
    input: { feature: "pull-request-deployments", action: "open_logs", outcome: "failure" },
  });

  await screen.rerender(
    deployments(
      { ...deployment, status: "pending", description: null, commitSha: headSha },
      { headSha },
    ),
  );
  expect(container.textContent).toContain("Pending");
  expect(container.textContent).not.toContain(headSha.slice(0, 7));
  expect(container.textContent).not.toContain(deployment.description);
  expect(container.textContent).not.toContain("may be missing");
  expect(container.querySelector('button[aria-label="Open web-preview"]')).toBeNull();

  await screen.rerender(
    deployments(
      {
        ...deployment,
        status: "success",
        description: null,
        commitSha: headSha,
        environmentUrl: "https://preview.example.com",
      },
      { headSha },
    ),
  );
  expect(container.textContent).toContain("Deployed");
  await act(async () => button(container, "Open web-preview").click());
  expect(openLink).toHaveBeenLastCalledWith("https://preview.example.com");
  expect(run).toHaveBeenLastCalledWith(expect.anything(), {
    environmentId,
    input: { feature: "pull-request-deployments", action: "open_environment", outcome: "success" },
  });
  expect(run).toHaveBeenCalledTimes(2);
});

it("keeps inactive previews closed while logs remain available, and does not guess an unknown head", async () => {
  setup();
  await using screen = await render(
    deployments({
      ...deployment,
      status: "inactive",
      environmentUrl: "https://preview.example.com",
    }),
  );
  const { container } = screen;
  expect(container.textContent).toContain("Inactive");
  expect(container.querySelector('button[aria-label="Open web-preview"]')).toBeNull();
  expect(container.textContent).toContain(deployment.commitSha.slice(0, 7));
  await act(async () => button(container, "View deployment logs for web-preview").click());
  expect(openLink).toHaveBeenCalledWith(deployment.logUrl);
});

it("lists failures first and keeps the rest behind Show all", async () => {
  setup();
  const environments = ["a", "b", "c", "d", "e", "f"].map((environment): PullRequestDeployment => ({
    ...deployment,
    id: environment,
    environment,
    status: "success",
    commitSha: headSha,
  }));
  environments[5] = { ...environments[5]!, status: "failure" };
  await using screen = await render(deployments(environments, { headSha }));
  const { container } = screen;
  const names = () =>
    [...container.querySelectorAll('button[aria-label^="View deployment logs for "]')].map((node) =>
      node.getAttribute("aria-label")!.slice("View deployment logs for ".length),
    );
  expect(names()).toEqual(["f", "a", "b", "c", "d"]);

  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Show all 6")!
      .click(),
  );
  expect(names()).toEqual(["f", "a", "b", "c", "d", "e"]);
  expect(run).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId,
    input: { feature: "pull-request-deployments", action: "show_all", outcome: "success" },
  });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Show less")!
      .click(),
  );
  expect(names()).toEqual(["f", "a", "b", "c", "d"]);
  expect(run).toHaveBeenCalledOnce();
});

it("keeps links working on older servers and when analytics delivery fails", async () => {
  setup();
  await using screen = await render(deployments());
  const { container } = screen;
  for (const capabilities of [{}, { forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION - 1 }]) {
    readConfig.mockReturnValue({ environment: { capabilities } });
    await act(async () => button(container, "View deployment logs for web-preview").click());
    expect(run).not.toHaveBeenCalled();
  }
  readConfig.mockReturnValue({
    environment: { capabilities: { forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION } },
  });
  run.mockRejectedValueOnce(new Error("Synthetic analytics transport failure"));
  await act(async () => button(container, "View deployment logs for web-preview").click());
  expect(run).toHaveBeenCalledOnce();
  expect(openLink).toHaveBeenCalledTimes(3);
  expect(toast).not.toHaveBeenCalled();
});

it("keeps a deployment's age counting without new deployment data", async () => {
  setup();
  using _timers = fakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-07-02T00:03:00Z"));
  await using screen = await render(deployments());
  expect(screen.container.textContent).toContain("3m ago");

  await act(async () => vi.advanceTimersByTime(60_000));
  expect(screen.container.textContent).toContain("4m ago");
});
