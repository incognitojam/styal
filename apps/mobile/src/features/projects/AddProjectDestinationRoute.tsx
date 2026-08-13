import type { StaticScreenProps } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { AddProjectDestinationScreen } from "./AddProjectScreen";

type AddProjectDestinationRouteParams = {
  readonly environmentId?: string | string[];
  readonly source?: string | string[];
  readonly remoteUrl?: string | string[];
  readonly repository?: string | string[];
  readonly repositoryTitle?: string | string[];
  readonly parentRepository?: string | string[];
};

export function AddProjectDestinationRoute({
  route,
}: StaticScreenProps<AddProjectDestinationRouteParams | undefined>) {
  return (
    <>
      <NativeStackScreenOptions options={{ title: "Destination" }} />
      <AddProjectDestinationScreen {...(route.params ?? {})} />
    </>
  );
}
