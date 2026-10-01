import { useState } from "react";
import type { IdentityValue, ServerIdentity } from "../../../../../src/common/server-identity";
import { useResource } from "../../api/use-resource";
import { CopyValue } from "../../components/data-table";

function missing(field: IdentityValue | undefined) {
  return field?.error || (!field ? "Unavailable" : !field.available ? "Not provided by this build" : "Not set");
}

export function ServerIdentityReadout() {
  const [open, setOpen] = useState(false);
  return (
    <details className="server-identity" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Server ID &amp; current banner</summary>
      {open && <IdentityDetails />}
    </details>
  );
}

function IdentityDetails() {
  const { data, error, loading, refresh } = useResource<ServerIdentity>("server-identity");
  return (
    <div aria-busy={loading}>
      {error ? (
        <p role="alert">Server identity could not be loaded.</p>
      ) : !data ? (
        <p>Loading server identity…</p>
      ) : (
        <dl>
          <div>
            <dt>Server ID</dt>
            <dd>
              {data.serverId?.value ? (
                <CopyValue value={data.serverId.value} label="server ID" />
              ) : (
                missing(data.serverId)
              )}
            </dd>
          </div>
          <div>
            <dt>Current banner</dt>
            <dd>
              {data.banner?.value ? (
                <a href={data.banner.value} target="_blank" rel="noopener noreferrer">
                  Open reported image ↗
                </a>
              ) : (
                missing(data.banner)
              )}
            </dd>
          </div>
        </dl>
      )}
      <p className="muted">Reported by the running game. The saved image URL is shown below.</p>
      <button className="button secondary small" type="button" disabled={loading} onClick={() => void refresh()}>
        Refresh identity
      </button>
    </div>
  );
}
