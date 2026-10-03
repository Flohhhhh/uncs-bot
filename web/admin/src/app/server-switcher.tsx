import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { SelectedServer } from "./context";

/**
 * Chooses the game server. Arrow keys, Home, End and typing only move the highlight; the
 * dashboard switches when staff press Enter or Space on a server or click it. Escape and Tab
 * close the list without switching.
 */
export function ServerSwitcher({
  servers,
  current,
  disabled,
  choose,
}: {
  servers: SelectedServer[];
  current: SelectedServer;
  disabled: boolean;
  choose: (id: string) => void;
}) {
  const base = useId();
  const container = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const currentIndex = Math.max(
    0,
    servers.findIndex((server) => server.id === current.id),
  );
  const expanded = open && !disabled;
  const optionId = (index: number) => `${base}-option-${index}`;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!expanded) return;
    document.getElementById(`${base}-option-${active}`)?.scrollIntoView?.({ block: "nearest" });
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded, active, base]);

  function show(index = currentIndex) {
    setActive(index);
    setOpen(true);
  }
  function commit(index: number) {
    setOpen(false);
    const server = servers[index];
    if (server && server.id !== current.id) choose(server.id);
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const last = servers.length - 1;
    const move = (index: number) => {
      event.preventDefault();
      if (expanded) setActive(Math.min(last, Math.max(0, index)));
      else show();
    };
    switch (event.key) {
      case "ArrowDown":
        return move(active + 1);
      case "ArrowUp":
        return move(active - 1);
      case "Home":
        return expanded ? move(0) : undefined;
      case "End":
        return expanded ? move(last) : undefined;
      case "Enter":
      case " ":
        event.preventDefault();
        return expanded ? commit(active) : show();
      case "Escape":
        if (!expanded) return;
        event.preventDefault();
        event.stopPropagation();
        return setOpen(false);
      case "Tab":
        return setOpen(false);
    }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      // Type-ahead highlights the next server whose name starts with the letter.
      const letter = event.key.toLowerCase();
      const from = expanded ? active : currentIndex;
      const order = servers.map((_, offset) => (from + 1 + offset) % servers.length);
      const match = order.find((index) => servers[index].name.toLowerCase().startsWith(letter));
      if (match === undefined) return;
      event.preventDefault();
      setActive(match);
      setOpen(true);
    }
  }

  return (
    <div ref={container} className="server-switcher">
      <span id={`${base}-label`} className="server-switcher-label">
        Game server
      </span>
      <button
        type="button"
        role="combobox"
        className="server-switcher-button"
        aria-labelledby={`${base}-label`}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={`${base}-list`}
        aria-activedescendant={expanded ? optionId(active) : undefined}
        disabled={disabled}
        onClick={() => (expanded ? setOpen(false) : show())}
        onKeyDown={keyDown}
        // Space is handled on keydown; this stops the browser's own click from toggling again.
        onKeyUp={(event) => {
          if (event.key === " ") event.preventDefault();
        }}
        onBlur={(event) => {
          if (!container.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <span className="server-switcher-name">{current.name}</span>
        <span className="server-role">{current.role}</span>
        <span className="server-switcher-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <ul
        id={`${base}-list`}
        role="listbox"
        className="server-switcher-list"
        aria-labelledby={`${base}-label`}
        hidden={!expanded}
        // Keep focus on the button so the keyboard keeps working after a pointer hover.
        onMouseDown={(event) => event.preventDefault()}
      >
        {servers.map((server, index) => (
          <li
            key={server.id}
            id={optionId(index)}
            role="option"
            aria-selected={server.id === current.id}
            className={index === active ? "active" : undefined}
            onPointerMove={() => setActive(index)}
            onClick={() => commit(index)}
          >
            <span>{server.name}</span> <span className="server-role">{server.role}</span>
            <span className="server-option-check" aria-hidden="true">
              {server.id === current.id ? "✓" : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The first screen after sign-in when no server is selected: one button per server, no default. */
export function ServerChoices({ servers, choose }: { servers: SelectedServer[]; choose: (id: string) => void }) {
  return (
    <ul className="server-choices" aria-label="Game servers">
      {servers.map((server) => (
        <li key={server.id}>
          <button type="button" className="server-choice" onClick={() => choose(server.id)}>
            <span>{server.name}</span> <span className="server-role">{server.role}</span>
            <span aria-hidden="true">→</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
