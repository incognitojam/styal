import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

/** What a config file's reader had to ignore, one line per entry. */
export function ConfigFileIssuesAlert({
  title,
  messages,
}: {
  title: string;
  messages: ReadonlyArray<string>;
}) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {[...new Set(messages)].map((message) => (
            <li key={message} className="whitespace-pre-wrap break-words">
              {message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
