import { useRef, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  pointerWithin,
  closestCenter,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MapSelection } from "../../../../../src/common/server-settings";
import { mapLabel, selectionDetails, selectionLabel } from "../../../../../src/common/map-labels";

export type RotationRow = { id: string; entry: MapSelection };
const newEntry = "new-entry";
const queueEnd = "queue-end";
function DraftCard({ entry, disabled }: { entry: MapSelection; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: newEntry, disabled });
  return (
    <button
      type="button"
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      disabled={disabled}
      className="button secondary rotation-draft-card"
      style={{ transform: CSS.Translate.toString(transform), zIndex: isDragging ? 2 : undefined }}
      aria-label={`Drag ${entry.map ? selectionLabel(entry) : "a map"} into rotation`}
    >
      <span aria-hidden="true">⠿</span> {entry.map ? selectionLabel(entry) : "Choose a map above"}
      <small>Drag into the queue</small>
    </button>
  );
}
function EndTarget({ disabled }: { disabled: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: queueEnd, disabled });
  return (
    <div ref={setNodeRef} className={`rotation-drop-end ${isOver ? "is-over" : ""}`}>
      Drop here to add at the end
    </div>
  );
}
function QueueRow({
  row,
  index,
  count,
  disabled,
  move,
  edit,
  remove,
}: {
  row: RotationRow;
  index: number;
  count: number;
  disabled: boolean;
  move: (to: number) => void;
  edit: () => void;
  remove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: row.id, disabled });
  const name = mapLabel(row.entry.map);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 1 : undefined }}
      className={`${isDragging ? "is-dragging" : ""} ${isOver ? "is-over" : ""}`}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        disabled={disabled}
        className="button secondary rotation-handle"
        aria-label={`Reorder entry ${index + 1}: ${name}`}
        title="Drag to reorder; Space to pick up, arrows to move, Escape to cancel"
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <span className="rotation-position" aria-hidden="true">
        {index + 1}
      </span>
      <div className="rotation-entry-label">
        <strong>{name}</strong>
        <small>{selectionDetails(row.entry)}</small>
      </div>
      <div className="row-actions">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || index === 0}
          aria-label={`Move ${name} up`}
          onClick={() => move(index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || index === count - 1}
          aria-label={`Move ${name} down`}
          onClick={() => move(index + 1)}
        >
          ↓
        </button>
        <button type="button" className="button secondary" disabled={disabled} onClick={edit}>
          Edit
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={disabled}
          aria-label={`Remove ${name}`}
          onClick={remove}
        >
          Remove
        </button>
      </div>
    </li>
  );
}
export function RotationQueue({
  rows,
  change,
  edit,
  selection,
  canAdd,
  add,
  disabled,
  children,
  showQueue = true,
}: {
  rows: RotationRow[];
  change: (rows: RotationRow[]) => void;
  edit: (index: number) => void;
  selection: MapSelection;
  canAdd: boolean;
  add: (index: number) => void;
  disabled: boolean;
  children: ReactNode;
  showQueue?: boolean;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const started = useRef<string | null>(null);
  function move(from: number, to: number) {
    if (!disabled && from !== to && from >= 0 && to >= 0 && from < rows.length && to < rows.length)
      change(arrayMove(rows, from, to));
  }
  const name = (id: string | number) =>
    id === newEntry ? selectionLabel(selection) : mapLabel(rows.find((row) => row.id === id)?.entry.map ?? "Map");
  const destination = (id: string | number) =>
    id === queueEnd ? "the end" : `position ${rows.findIndex((row) => row.id === id) + 1}`;
  if (!showQueue) return <>{children}</>;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => (args.pointerCoordinates ? pointerWithin(args) : closestCenter(args))}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
          onDragOver: ({ active, over }) =>
            over ? `${name(active.id)} at ${destination(over.id)}.` : "Outside the queue. Drop to cancel.",
          onDragEnd: ({ over }) =>
            over ? "Drag finished. Review the queue before saving." : "No change to the queue.",
          onDragCancel: () => "Cancelled. No change to the queue.",
        },
        screenReaderInstructions: {
          draggable:
            "Press Space to pick up. Use arrow keys to move. Press Space to drop or Escape to cancel. Changes stay in a draft until saved.",
        },
      }}
      onDragStart={() => {
        started.current = JSON.stringify(rows);
      }}
      onDragCancel={() => {
        started.current = null;
      }}
      onDragEnd={({ active, over }) => {
        const unchanged = started.current === JSON.stringify(rows);
        started.current = null;
        if (disabled || !unchanged || !over) return;
        const to = over.id === queueEnd ? rows.length : rows.findIndex((row) => row.id === over.id);
        if (to < 0) return;
        if (active.id === newEntry) {
          if (canAdd) add(to);
        } else
          move(
            rows.findIndex((row) => row.id === active.id),
            Math.min(to, rows.length - 1),
          );
      }}
    >
      {children}
      <DraftCard entry={selection} disabled={disabled || !canAdd} />
      <p className="muted">
        Drag a prepared map into the queue or use Add to rotation. Drag ⠿ to reorder. Review and save to apply.
      </p>
      <SortableContext items={rows.map((row) => row.id)} strategy={verticalListSortingStrategy}>
        <ol className="rotation-editor rotation-queue" aria-label="Rotation queue">
          {rows.map((row, index) => (
            <QueueRow
              key={row.id}
              row={row}
              index={index}
              count={rows.length}
              disabled={disabled}
              move={(to) => move(index, to)}
              edit={() => edit(index)}
              remove={() => change(rows.filter((item) => item.id !== row.id))}
            />
          ))}
        </ol>
      </SortableContext>
      <EndTarget disabled={disabled} />
    </DndContext>
  );
}
