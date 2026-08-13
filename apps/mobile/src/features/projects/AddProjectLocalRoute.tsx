import type { StaticScreenProps } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { AddProjectLocalFolderScreen } from "./AddProjectScreen";

type AddProjectLocalRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddProjectLocalRoute({
  route,
}: StaticScreenProps<AddProjectLocalRouteParams | undefined>) {
  return (
    <>
      <NativeStackScreenOptions options={{ title: "Local Folder" }} />
      <AddProjectLocalFolderScreen {...(route.params ?? {})} />
    </>
  );
}
