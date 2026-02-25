import { useState } from "react";
import type { DiaryEntry } from "../types.js";
import DiaryEntryCard from "./DiaryEntry.js";

interface Props {
  entries: DiaryEntry[];
}

export default function DiaryTimeline({ entries }: Props) {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  if (sorted.length === 0) {
    return (
      <div className="empty-state">
        <p>No diary entries recorded</p>
      </div>
    );
  }

  return (
    <div className="diary-timeline">
      {sorted.map((entry) => (
        <DiaryEntryCard key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
