import { StackActions, useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { useCallback } from "react";
import { BackHandler, Keyboard, Platform } from "react-native";
import { returnToAndroidWorkspaceList } from "../../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { workspaceTabOf } from "./workspace-tabs-state";

export function useWorkspaceBackNavigation() {
  const navigation = useNavigation();
  return () => {
    if (Platform.OS === "android") returnToAndroidWorkspaceList(navigation);
    else if (navigation.canGoBack()) navigation.goBack();
    else navigation.dispatch(StackActions.replace("Home"));
  };
}

/** App links, the multi-PR sheet and shared drafts bypass list selection; the page shown picks its list. */
export function useAndroidWorkspaceTab() {
  const dispatch = useWorkspaceTabs()?.dispatch;
  const tab = workspaceTabOf(useRoute().name);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === "android") dispatch?.({ type: "select", tab });
    }, [dispatch, tab]),
  );
}

export function useAndroidWorkspaceBack() {
  const goBack = useWorkspaceBackNavigation();
  useAndroidWorkspaceTab();
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (Keyboard.isVisible()) Keyboard.dismiss();
        else goBack();
        return true;
      });
      return () => subscription.remove();
    }, [goBack]),
  );
  return goBack;
}
