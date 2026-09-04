"use client";

import { useTransition } from "react";
import { markSentAction, recordOutcomeAction, redraftAction } from "@/lib/actions";

export function ReviewActions({
  rfqId,
  quoteId,
  sentAt,
  copyText,
}: {
  rfqId: string;
  quoteId: string;
  sentAt: Date | string | null;
  copyText: string;
}) {
  const [pending, startTransition] = useTransition();

  async function copyOut() {
    await navigator.clipboard.writeText(copyText);
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={copyOut}
        className="rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm font-medium hover:bg-[var(--bg-elevated)]"
      >
        Copy answer
      </button>
      {!sentAt && (
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => markSentAction(rfqId))}
          className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--brand-hot)]"
        >
          Mark sent
        </button>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => redraftAction(rfqId))}
        className="rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink-muted)]"
      >
        Re-draft
      </button>
      {sentAt && (
        <form
          action={(fd) => startTransition(() => recordOutcomeAction(fd))}
          className="flex flex-wrap items-center gap-2"
        >
          <input type="hidden" name="quoteId" value={quoteId} />
          <select
            name="result"
            className="rounded border border-[var(--line)] bg-white px-2 py-2 text-sm"
            defaultValue="no_decision"
          >
            <option value="won">Won</option>
            <option value="lost">Lost</option>
            <option value="no_decision">No decision</option>
          </select>
          <input
            name="competitorPrice"
            placeholder="Competitor $"
            className="w-28 rounded border border-[var(--line)] bg-white px-2 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-[var(--ink)] px-3 py-2 text-sm font-medium text-white"
          >
            Record outcome
          </button>
        </form>
      )}
    </div>
  );
}
