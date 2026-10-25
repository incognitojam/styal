import { createFileRoute } from "@tanstack/react-router";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
// No component: code splitting would load it as its own chunk, and until that
// loads the layout still shows the previous thread, whose composer takes input.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({});
