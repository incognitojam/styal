import {
  CLAUDE_STATUS_PAGE_URL,
  CLAUDE_STATUS_SUMMARY_URL,
  resolveClaudeStatusNotice,
} from "../../claudeStatus";
import { useClientSettings } from "../../hooks/useSettings";
import { ClaudeAI } from "../Icons";
import { StatusPageNotice } from "./StatusPageNotice";

export function ClaudeStatusNotice() {
  const enabled = useClientSettings((settings) => settings.claudeStatusAlertsEnabled);

  return (
    <StatusPageNotice
      enabled={enabled}
      icon={ClaudeAI}
      pageName="Claude"
      pageUrl={CLAUDE_STATUS_PAGE_URL}
      resolveNotice={resolveClaudeStatusNotice}
      summaryUrl={CLAUDE_STATUS_SUMMARY_URL}
    />
  );
}
