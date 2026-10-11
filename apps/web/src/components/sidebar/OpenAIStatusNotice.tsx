import {
  OPENAI_STATUS_COMPONENTS_URL,
  OPENAI_STATUS_PAGE_URL,
  OPENAI_STATUS_SUMMARY_URL,
  resolveOpenAIStatusNotice,
} from "../../openaiStatus";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { OpenAI, type Icon } from "../Icons";
import { StatusPageNotice } from "./StatusPageNotice";

const OpenAIBrandIcon: Icon = ({ className, ...props }) => (
  <OpenAI {...props} className={cn("text-black dark:text-white", className)} />
);

export function OpenAIStatusNotice() {
  const enabled = useClientSettings((settings) => settings.openaiStatusAlertsEnabled);

  return (
    <StatusPageNotice
      componentsUrl={OPENAI_STATUS_COMPONENTS_URL}
      enabled={enabled}
      icon={OpenAIBrandIcon}
      pageName="OpenAI"
      pageUrl={OPENAI_STATUS_PAGE_URL}
      resolveNotice={resolveOpenAIStatusNotice}
      summaryUrl={OPENAI_STATUS_SUMMARY_URL}
    />
  );
}
