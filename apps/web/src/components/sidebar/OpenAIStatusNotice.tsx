import {
  OPENAI_STATUS_COMPONENTS_URL,
  OPENAI_STATUS_PAGE_URL,
  OPENAI_STATUS_SUMMARY_URL,
  resolveOpenAIStatusNotice,
} from "../../openaiStatus";
import { useClientSettings } from "../../hooks/useSettings";
import { OpenAI } from "../Icons";
import { StatusPageNotice } from "./StatusPageNotice";

export function OpenAIStatusNotice() {
  const enabled = useClientSettings((settings) => settings.openaiStatusAlertsEnabled);

  return (
    <StatusPageNotice
      componentsUrl={OPENAI_STATUS_COMPONENTS_URL}
      enabled={enabled}
      icon={OpenAI}
      pageName="OpenAI/Codex"
      pageUrl={OPENAI_STATUS_PAGE_URL}
      resolveNotice={resolveOpenAIStatusNotice}
      summaryUrl={OPENAI_STATUS_SUMMARY_URL}
    />
  );
}
