import type { RotationCheck } from "../../../../../src/common/server-settings";
import { useResource } from "../../api/use-resource";

export function SavedRotationCheck({ revision }: { revision: string }) {
  const { data, loading, refreshing, error, refresh } = useResource<RotationCheck>("settings/rotation-check");
  const checking = loading || refreshing;
  const current = !error && data?.revision === revision ? data : null;
  const groups = new Map<string, number[]>();
  for (const issue of current?.issues ?? [])
    groups.set(issue.message, [...(groups.get(issue.message) ?? []), issue.index + 1]);
  return (
    <div className={`notice ${current?.issues.length || error ? "warning" : "info"}`} aria-busy={checking}>
      <p role="status">
        {checking
          ? "Checking saved rotation against the server catalog…"
          : error
            ? "The saved rotation could not be checked."
            : !current
              ? "Settings changed. Refresh settings and check the rotation again."
              : current.issues.length
                ? `${current.issues.length} of ${current.total} saved entries need attention.`
                : `All ${current.total} saved entries match the current catalog.`}
      </p>
      {!!groups.size && (
        <details>
          <summary>Show entries to review</summary>
          <ul>
            {[...groups].map(([message, entries]) => (
              <li key={message}>
                Entries {entries.join(", ")}: {message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <small>Checks saved values only. A catalog match does not prove every combination works in a match.</small>
      <button className="button secondary small" type="button" disabled={checking} onClick={refresh}>
        Check saved rotation
      </button>
    </div>
  );
}
