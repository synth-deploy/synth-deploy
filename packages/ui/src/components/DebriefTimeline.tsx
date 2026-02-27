import { useState } from "react";
import type { DebriefEntry } from "../types.js";
import DebriefEntryCard from "./DebriefEntry.js";

interface Props {
  entries: DebriefEntry[];
}

export default function DebriefTimeline({ entries }: Props) {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  if (sorted.length === 0) {
    return (
      <div className="empty-state">
        <p>No debrief entries recorded</p>
      </div>
    );
  }

  return (
    <div className="debrief-timeline">
      {sorted.map((entry) => (
        <DebriefEntryCard key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
