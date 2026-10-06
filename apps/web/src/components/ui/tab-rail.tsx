"use client";

import { useId, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export type TabRailOption<Value extends string = string> = {
  value: Value;
  label: ReactNode;
};

export function TabRail<Value extends string>({
  value,
  onValueChange,
  tabs,
  ariaLabel,
  children,
  className,
  listClassName,
  panelClassName,
}: {
  value: Value;
  onValueChange: (value: Value) => void;
  tabs: readonly TabRailOption<Value>[];
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  listClassName?: string;
  panelClassName?: string;
}) {
  const id = useId();
  const panelId = `${id}-panel`;
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.value === value),
  );
  const selectedTabId = `${id}-tab-${selectedIndex}`;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") {
      return;
    }

    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    if (!buttons.length) return;

    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (Math.max(currentIndex, 0) + direction + buttons.length) % buttons.length;

    event.preventDefault();
    buttons[nextIndex]?.focus();
    const nextTab = tabs[nextIndex];
    if (nextTab) onValueChange(nextTab.value);
  }

  return (
    <div className={cn("grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden", className)}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={cn("flex gap-1 overflow-x-auto border-b border-border", listClassName)}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.value}
            id={`${id}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={tab.value === value}
            aria-controls={panelId}
            tabIndex={tab.value === value ? 0 : -1}
            className={cn(
              "h-10 shrink-0 border-b-2 px-3 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              tab.value === value
                ? "border-orange-500 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onValueChange(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={selectedTabId}
        className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden", panelClassName)}
      >
        {children}
      </div>
    </div>
  );
}
