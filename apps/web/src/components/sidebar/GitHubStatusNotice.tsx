import {
  GITHUB_STATUS_PAGE_URL,
  GITHUB_STATUS_SUMMARY_URL,
  hasGitHubProject,
  resolveGitHubStatusNotice,
} from "../../githubStatus";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { GitHubIcon, type Icon } from "../Icons";
import { StatusPageNotice } from "./StatusPageNotice";

const GitHubBrandIcon: Icon = ({ className, ...props }) => (
  <GitHubIcon {...props} className={cn("text-black dark:text-white", className)} />
);

export function GitHubStatusNotice() {
  const projects = useProjects();
  const hasRelevantProject = hasGitHubProject(projects);
  return (
    <StatusPageNotice
      enabled={hasRelevantProject}
      icon={GitHubBrandIcon}
      pageName="GitHub"
      pageUrl={GITHUB_STATUS_PAGE_URL}
      resolveNotice={resolveGitHubStatusNotice}
      summaryUrl={GITHUB_STATUS_SUMMARY_URL}
    />
  );
}
