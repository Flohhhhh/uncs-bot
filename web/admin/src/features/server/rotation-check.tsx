import { useEffect, useRef } from "react";
import type { RotationCheck } from "../../../../../src/common/server-settings";
import { useResource } from "../../api/use-resource";

/** Checks the saved rotation against the server catalog. Shows nothing unless an entry needs attention or the check failed. */
export function SavedRotationCheck({ revision }: { revision: string }) {
  const { data, loading, error, refresh } = useResource<RotationCheck>("settings/rotation-check");
  const outdated = !error && !!data && data.revision !== revision;
  // A newer saved rotation is checked again once; a check that still answers for another revision is reported.
  const checked = useRef(revision);
  const recheck = outdated && checked.current !== revision;
  useEffect(() => {
    if (recheck) {
      checked.current = revision;
      refresh();
    }
  }, [recheck, revision, refresh]);
  const current = !error && data?.revision === revision ? data : null;
  if (!error && (outdated ? loading || recheck : !current?.issues.length)) return null;
  const groups = new Map<string, number[]>();
  for (const issue of current?.issues ?? [])
    groups.set(issue.message, [...(groups.get(issue.message) ?? []), issue.index + 1]);
  return (
    <div className="notice warning rotation-check" aria-busy={loading}>
      <p role="status">
        {error
          ? "The saved rotation could not be checked."
          : !current
            ? "The saved rotation changed after it was checked."
            : `${current.issues.length} of ${current.total} saved entries need attention.`}
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
      <button className="button secondary small" type="button" disabled={loading} onClick={refresh}>
        Check saved rotation
      </button>
    </div>
  );
}
