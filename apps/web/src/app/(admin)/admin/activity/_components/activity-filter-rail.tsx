"use client";

import { Input } from "~/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { activityCategories, activityCategoryDetails, type ActivityCategory } from "./activity-data";

export function ActivityFilterRail({
  query,
  onQueryChange,
  selectedCategories,
  onSelectedCategoriesChange,
  counts,
  resultCount,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  selectedCategories: ActivityCategory[];
  onSelectedCategoriesChange: (categories: ActivityCategory[]) => void;
  counts: Record<ActivityCategory, number>;
  resultCount: number;
}) {
  return (
    <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-center">
      <div className="flex min-w-64 items-center gap-3">
        <Input
          aria-label="Search activity"
          placeholder="Search..."
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
        <span aria-live="polite" className="shrink-0 text-sm text-muted-foreground">
          {resultCount} {resultCount === 1 ? "event" : "events"}
        </span>
      </div>
      <ToggleGroup
        type="multiple"
        value={selectedCategories}
        onValueChange={(values) =>
          onSelectedCategoriesChange(
            values.filter((value): value is ActivityCategory => activityCategories.includes(value as ActivityCategory)),
          )
        }
        aria-label="Filter activity categories"
        className="flex flex-wrap gap-2 xl:justify-end"
      >
        {activityCategories.map((category) => {
          const { label, Icon } = activityCategoryDetails[category];
          return (
            <ToggleGroupItem
              className="gap-2 px-4"
              key={category}
              value={category}
              aria-label={`${label}, ${counts[category]} events`}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {label}
              <span className="text-xs text-muted-foreground">{counts[category]}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </div>
  );
}
