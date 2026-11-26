import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { useSettingsSearchTarget } from "./settingsLayout";

export function SettingsSubRows({ children }: { children: ReactNode }) {
  return <div className="mt-2 mb-2 border-l border-border/60 pl-3 sm:pl-4">{children}</div>;
}

/**
 * A compact option nested under a parent SettingsRow. `disabled` dims the
 * label; the caller disables its own controls.
 */
export function SettingsSubRow({
  title,
  description,
  resetAction,
  control,
  disabled = false,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: string;
  description?: string | undefined;
  resetAction?: ReactNode;
  control: ReactNode;
  disabled?: boolean;
}) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(rowProps.id);
  return (
    <div
      {...rowProps}
      ref={targetRef}
      tabIndex={rowProps.id ? -1 : rowProps.tabIndex}
      aria-disabled={disabled || undefined}
      // With a description, align the control to the title line so controls in
      // neighbouring sub-rows stay evenly spaced.
      className={cn(
        "flex flex-wrap justify-between gap-x-8 gap-y-2 rounded-md py-1.5",
        description ? "items-start" : "items-center",
      )}
    >
      <div className="min-w-0">
        <div className="flex min-h-5 items-center gap-1.5">
          <h4 className={cn("text-sm", disabled ? "text-muted-foreground" : "text-foreground/90")}>
            {title}
          </h4>
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
            {resetAction}
          </span>
        </div>
        {description ? (
          <p className="text-xs leading-normal text-muted-foreground/80">{description}</p>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}
