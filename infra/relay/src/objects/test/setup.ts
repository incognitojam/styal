import { vi } from "vitest";

// The queue service imports provisioning definitions; local object tests use explicit fake senders.
vi.mock("alchemy", () => import("alchemy/RuntimeContext"));
vi.mock("@alchemy.run/cloudflare", () => ({ Queues: { Queue: (id: string) => ({ id }) } }));
