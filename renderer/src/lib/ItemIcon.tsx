// A recognizable item chip (colour + monogram) replacing the old hatch square.
// Keeps the s20/s28/s40 size vocabulary of the placeholder it supersedes.
import type { CSSProperties } from "react";
import { itemAccent, itemMonogram } from "./itemChip";

export default function ItemIcon({
  item,
  displayName,
  size = 20,
}: {
  item: string;
  displayName?: string;
  size?: 20 | 28 | 40;
}) {
  // Save-only / unknown items carry item:"" — degrade to a neutral tile.
  if (!item) return <span className={`item-chip s${size}`} aria-hidden />;
  return (
    <span
      className={`item-chip s${size}`}
      style={{ "--chip-accent": itemAccent(item) } as CSSProperties}
      title={displayName ?? item}
      aria-hidden
    >
      {itemMonogram(item, displayName)}
    </span>
  );
}
