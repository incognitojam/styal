import { createFileRoute } from "@tanstack/react-router";

// The view lives in the `_chat` layout (see ThreadRouteView) so a draft's
// promotion onto this route keeps the same ChatView mounted.
// No component: code splitting would load it as its own chunk, and until that
// loads the layout still shows the previous thread, whose composer takes input.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({});
