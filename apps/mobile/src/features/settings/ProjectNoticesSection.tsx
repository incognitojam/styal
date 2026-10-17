import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectNotice } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { relativeTime } from "../../lib/time";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import type { SettingsTarget } from "./settings-environment-filter";

/** Notices agents posted for this project's threads, with a way to resolve each one. */
export function ProjectNoticesSection(props: {
  readonly members: readonly EnvironmentProject[];
  readonly environments: readonly SettingsTarget[];
}) {
  // Name the environment only when the checkouts span more than one.
  const spansEnvironments = new Set(props.members.map((member) => member.environmentId)).size > 1;
  return (
    <SettingsSection title="Notices">
      <Text className="p-4 text-sm leading-normal text-foreground-muted">
        Agents post short notices here so other threads in this project know about work in progress,
        a broken branch, or a hold on merges. New threads read them when they start. Notices expire
        on their own.
      </Text>
      {props.members.map((member) => (
        <MemberNotices
          key={`${member.environmentId}:${member.id}`}
          member={member}
          environmentLabel={
            spansEnvironments
              ? (props.environments.find((entry) => entry.environmentId === member.environmentId)
                  ?.label ?? "Environment")
              : null
          }
        />
      ))}
    </SettingsSection>
  );
}

function MemberNotices(props: {
  readonly member: EnvironmentProject;
  readonly environmentLabel: string | null;
}) {
  const { environmentId, id: projectId } = props.member;
  const query = useEnvironmentQuery(
    serverEnvironment.projectNoticesLive({ environmentId, input: { projectId } }),
  );
  return (query.data?.notices ?? []).map((notice) => (
    <NoticeRow
      key={notice.id}
      notice={notice}
      member={props.member}
      environmentLabel={props.environmentLabel}
    />
  ));
}

function hoursUntil(iso: string): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 3_600_000));
}

function NoticeRow(props: {
  readonly notice: ProjectNotice;
  readonly member: EnvironmentProject;
  readonly environmentLabel: string | null;
}) {
  const { notice, member } = props;
  const resolveNotice = useAtomCommand(serverEnvironment.resolveProjectNotice, {
    label: "project notice resolve",
    reportFailure: true,
  });
  const [resolving, setResolving] = useState(false);
  const author = useThreadShell(
    notice.authorThreadId === null
      ? null
      : scopeThreadRef(member.environmentId, notice.authorThreadId),
  );
  const meta = [
    props.environmentLabel,
    `Posted ${relativeTime(notice.createdAt)} ago`,
    author ? `by ${author.title}` : null,
    `expires in ${hoursUntil(notice.expiresAt)}h`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  const resolve = () => {
    if (resolving) return;
    setResolving(true);
    void resolveNotice({
      environmentId: member.environmentId,
      input: { noticeId: notice.id },
    }).finally(() => setResolving(false));
  };

  return (
    <View className="flex-row items-start gap-3 border-t border-border-subtle p-4">
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base text-foreground">{notice.title}</Text>
        {notice.body.length > 0 ? (
          <Text className="text-sm leading-normal text-foreground-muted" selectable>
            {notice.body}
          </Text>
        ) : null}
        <Text className="text-sm text-foreground-muted">{meta}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Resolve notice ${notice.title}`}
        disabled={resolving}
        onPress={resolve}
        className="rounded-full bg-subtle-strong px-4 py-2 active:opacity-70"
      >
        <Text className="text-sm font-t3-medium text-foreground">Resolve</Text>
      </Pressable>
    </View>
  );
}
