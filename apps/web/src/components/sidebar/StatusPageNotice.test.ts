import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  OPENAI_STATUS_COMPONENTS_URL,
  OPENAI_STATUS_SUMMARY_URL,
  resolveOpenAIStatusNotice,
} from "../../openaiStatus";
import { fetchStatusPageNotice } from "./StatusPageNotice";

const fetchMock = vi.fn();

function openAIStatusSummary() {
  return {
    status: { indicator: "major", description: "Partial System Outage" },
    components: [{ name: "Codex Web", status: "major_outage" }],
    incidents: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("fetchStatusPageNotice", () => {
  it("falls back to the summary when the complete component listing is unavailable", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(openAIStatusSummary()))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchStatusPageNotice({
        componentsUrl: OPENAI_STATUS_COMPONENTS_URL,
        resolveNotice: resolveOpenAIStatusNotice,
        signal: new AbortController().signal,
        summaryUrl: OPENAI_STATUS_SUMMARY_URL,
      }),
    ).resolves.toMatchObject({
      notice: {
        affectedComponents: [{ name: "Codex Web", status: "major_outage" }],
        label: "OpenAI Outage: Codex Web",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the summary when the complete component listing is malformed", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(openAIStatusSummary()))
      .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await fetchStatusPageNotice({
      componentsUrl: OPENAI_STATUS_COMPONENTS_URL,
      resolveNotice: resolveOpenAIStatusNotice,
      signal: new AbortController().signal,
      summaryUrl: OPENAI_STATUS_SUMMARY_URL,
    });
    expect(loaded?.notice).toMatchObject({
      affectedComponents: [{ name: "Codex Web", status: "major_outage" }],
      label: "OpenAI Outage: Codex Web",
    });
    await expect(loaded?.enrichment).resolves.toMatchObject({
      affectedComponents: [{ name: "Codex Web", status: "major_outage" }],
      label: "OpenAI Outage: Codex Web",
    });
  });

  it("preserves the last notice when the summary payload is malformed", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchStatusPageNotice({
        componentsUrl: OPENAI_STATUS_COMPONENTS_URL,
        resolveNotice: resolveOpenAIStatusNotice,
        signal: new AbortController().signal,
        summaryUrl: OPENAI_STATUS_SUMMARY_URL,
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start optional enrichment when the summary is unusable", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchStatusPageNotice({
        componentsUrl: OPENAI_STATUS_COMPONENTS_URL,
        resolveNotice: resolveOpenAIStatusNotice,
        signal: new AbortController().signal,
        summaryUrl: OPENAI_STATUS_SUMMARY_URL,
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the summary without waiting for a stalled component request", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json(openAIStatusSummary())).mockImplementationOnce(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await fetchStatusPageNotice({
      componentsUrl: OPENAI_STATUS_COMPONENTS_URL,
      resolveNotice: resolveOpenAIStatusNotice,
      signal: new AbortController().signal,
      summaryUrl: OPENAI_STATUS_SUMMARY_URL,
    });

    expect(loaded?.notice).toMatchObject({ label: "OpenAI Outage: Codex Web" });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(loaded?.enrichment).resolves.toBeUndefined();
  });
});
