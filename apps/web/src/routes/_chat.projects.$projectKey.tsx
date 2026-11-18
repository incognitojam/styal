import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ProjectPage } from "../components/project/ProjectPage";
import { projectPageRouteDisabled } from "../components/project/projectPage.logic";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";

// With project coordinators on in Labs this is the project page; otherwise it opens the settings.
export const Route = createFileRoute("/_chat/projects/$projectKey")({
  beforeLoad: ({ params }) => {
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const environmentIds = [
      ...enabledEnvironmentIds(appAtomRegistry.get(environmentCatalog.catalogValueAtom)),
    ];
    if (projectPageRouteDisabled(environmentIds.map((id) => configs.get(id)?.settings ?? null))) {
      throw redirect({
        to: "/settings/projects",
        search: { project: params.projectKey, machine: undefined },
        replace: true,
      });
    }
  },
  component: function ProjectPageRoute() {
    const { projectKey } = Route.useParams();
    return <ProjectPage projectKey={projectKey} />;
  },
});
