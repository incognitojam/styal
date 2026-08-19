import { GithubIcon } from "lucide-react";

import {
  GITHUB_STATUS_PAGE_URL,
  GITHUB_STATUS_SUMMARY_URL,
  hasGitHubProject,
  resolveGitHubStatusNotice,
} from "../../githubStatus";
import { useProjects } from "../../state/entities";
import { StatusPageNotice } from "./StatusPageNotice";

export function GitHubStatusNotice() {
  const projects = useProjects();
  const hasRelevantProject = hasGitHubProject(projects);
  return (
    <StatusPageNotice
      enabled={hasRelevantProject}
      icon={GithubIcon}
      pageName="GitHub"
      pageUrl={GITHUB_STATUS_PAGE_URL}
      resolveNotice={resolveGitHubStatusNotice}
      summaryUrl={GITHUB_STATUS_SUMMARY_URL}
    />
  );
}
