import { GithubIcon } from "lucide-react";

import {
  GITHUB_STATUS_PAGE_URL,
  GITHUB_STATUS_SUMMARY_URL,
  resolveGitHubStatusNotice,
} from "../../githubStatus";
import { useClientSettings } from "../../hooks/useSettings";
import { StatusPageNotice } from "./StatusPageNotice";

export function GitHubStatusNotice() {
  const enabled = useClientSettings((settings) => settings.githubStatusAlertsEnabled);
  return (
    <StatusPageNotice
      enabled={enabled}
      icon={GithubIcon}
      pageName="GitHub"
      pageUrl={GITHUB_STATUS_PAGE_URL}
      resolveNotice={resolveGitHubStatusNotice}
      summaryUrl={GITHUB_STATUS_SUMMARY_URL}
    />
  );
}
