import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectNotice } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { relativeLabel } from "./ScheduledTasksSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Notices agents posted for the threads in this project, with a way to remove
 * one that no longer applies. Each checkout's environment holds its own notices.
 */
export function ProjectNoticesSettings(props: {
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  // Name the environment only when the checkouts span more than one.
  const showEnvironment = new Set(props.members.map((member) => member.environmentId)).size > 1;
  return (
    <SettingsSection title="Notices">
      <SettingsRow
        title="Agent notices"
        forkFeature="project-notices"
        description="Agents post short notices here so other threads in this project know about work in progress, a broken branch, or a hold on merges. New threads read them when they start. Notices expire on their own."
      />
      {props.members.map((member) => (
        <MemberNotices
          key={`${member.environmentId}:${member.id}`}
          member={member}
          showEnvironment={showEnvironment}
        />
      ))}
    </SettingsSection>
  );
}

function MemberNotices(props: {
  readonly member: SidebarProjectGroupMember;
  readonly showEnvironment: boolean;
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
      showEnvironment={props.showEnvironment}
    />
  ));
}

function NoticeRow(props: {
  readonly notice: ProjectNotice;
  readonly member: SidebarProjectGroupMember;
  readonly showEnvironment: boolean;
}) {
  const { notice, member } = props;
  const navigate = useNavigate();
  const resolveNotice = useAtomCommand(serverEnvironment.resolveProjectNotice, {
    label: "project notice resolve",
  });
  const [resolving, setResolving] = useState(false);
  const authorRef =
    notice.authorThreadId === null
      ? null
      : scopeThreadRef(member.environmentId, notice.authorThreadId);
  const author = useThreadShell(authorRef);

  const resolve = async () => {
    setResolving(true);
    const result = await resolveNotice({
      environmentId: member.environmentId,
      input: { noticeId: notice.id },
    });
    setResolving(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not resolve notice",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  const meta = [
    props.showEnvironment ? (member.environmentLabel ?? "Environment") : null,
    `Expires ${relativeLabel(notice.expiresAt)}`,
    authorRef !== null ? `From ${author?.title ?? "a thread"}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <SettingsRow
      title={notice.title}
      description={
        <>
          {notice.body.length > 0 ? (
            <span className="block whitespace-pre-wrap">{notice.body}</span>
          ) : null}
          <span className="block">{meta}</span>
        </>
      }
      control={
        <div className="flex items-center gap-2">
          {authorRef !== null ? (
            <Button
              size="sm"
              variant="link"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(authorRef),
                })
              }
            >
              Open thread
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={resolving} onClick={() => void resolve()}>
            Resolve
          </Button>
        </div>
      }
    />
  );
}
