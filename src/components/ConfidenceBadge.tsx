import type { ConfidenceState } from "@/lib/types";

const styles: Record<ConfidenceState, string> = {
  GREEN: "bg-[var(--green-bg)] text-[var(--green)]",
  AMBER: "bg-[var(--amber-bg)] text-[var(--amber)]",
  RED: "bg-[var(--red-bg)] text-[var(--red)]",
};

export function ConfidenceBadge({ state }: { state: string }) {
  const s = (["GREEN", "AMBER", "RED"].includes(state)
    ? state
    : "RED") as ConfidenceState;
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold tracking-wide ${styles[s]}`}
    >
      {s}
    </span>
  );
}
