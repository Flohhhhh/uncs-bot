import { useRef, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  pointerWithin,
  closestCenter,
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
import { mapLabel, selectionDetails } from "../../../../../src/common/map-labels";
import { Badge } from "../../components/ui";

export type RotationRow = { id: string; entry: MapSelection };
/** Rows the game confirms as playing now and playing next, by position. */
export type RotationMarkers = { now: number | null; next: number | null };

function QueueRow({
  row,
  index,
  count,
  disabled,
  canEdit,
  now,
  next,
  editor,
  move,
  edit,
  remove,
}: {
  row: RotationRow;
  index: number;
  count: number;
  disabled: boolean;
  canEdit: boolean;
  now: boolean;
  next: boolean;
  editor?: ReactNode;
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
      className={[isDragging && "is-dragging", isOver && "is-over", now && "is-now", editor && "is-editing"]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="rotation-row">
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
        {(now || next) && (
          <span className="rotation-markers">
            {now && <Badge kind="good">Now</Badge>}
            {next && <Badge>Next</Badge>}
          </span>
        )}
        <div className="row-actions rotation-row-actions">
          <button
            type="button"
            className="button secondary"
            disabled={disabled || index === 0}
            aria-label={`Move ${name} up`}
            title="Move up"
            onClick={() => move(index - 1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={disabled || index === count - 1}
            aria-label={`Move ${name} down`}
            title="Move down"
            onClick={() => move(index + 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={disabled || !canEdit}
            aria-label={`Edit ${name}`}
            title="Edit"
            onClick={edit}
          >
            <span aria-hidden="true">✎</span>
          </button>
          <button
            type="button"
            className="button secondary rotation-remove"
            disabled={disabled}
            aria-label={`Remove ${name}`}
            title="Remove"
            onClick={remove}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </div>
      {editor && <div className="rotation-row-editor">{editor}</div>}
    </li>
  );
}

/**
 * The ordered rotation, with the entry editor opened under the row being edited. Rows reorder by
 * dragging the handle, by keyboard, or with the arrow buttons; `children` follow the list.
 */
export function RotationQueue({
  rows,
  change,
  edit,
  disabled,
  canEdit = !disabled,
  markers,
  editing = null,
  editor,
  children,
}: {
  rows: RotationRow[];
  change: (rows: RotationRow[]) => void;
  edit: (index: number) => void;
  disabled: boolean;
  /** False while another entry is open in the editor. */
  canEdit?: boolean;
  /** Shown only when the game confirms the rotation position. */
  markers?: RotationMarkers;
  /** The row whose editor is open. */
  editing?: number | null;
  editor?: ReactNode;
  children?: ReactNode;
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
  const name = (id: string | number) => mapLabel(rows.find((row) => row.id === id)?.entry.map ?? "Map");
  const destination = (id: string | number) => `position ${rows.findIndex((row) => row.id === id) + 1}`;
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
        move(
          rows.findIndex((row) => row.id === active.id),
          rows.findIndex((row) => row.id === over.id),
        );
      }}
    >
      <SortableContext items={rows.map((row) => row.id)} strategy={verticalListSortingStrategy}>
        <ol className="rotation-queue" aria-label="Rotation queue">
          {rows.map((row, index) => (
            <QueueRow
              key={row.id}
              row={row}
              index={index}
              count={rows.length}
              disabled={disabled}
              canEdit={canEdit}
              now={markers?.now === index}
              next={markers?.next === index}
              editor={editing === index ? editor : undefined}
              move={(to) => move(index, to)}
              edit={() => edit(index)}
              remove={() => change(rows.filter((item) => item.id !== row.id))}
            />
          ))}
        </ol>
      </SortableContext>
      {!rows.length && <p className="muted">The rotation is empty.</p>}
      {children}
    </DndContext>
  );
}
