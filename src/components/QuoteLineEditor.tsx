"use client";

import { useState, useTransition } from "react";
import { updateQuoteLineAction, confirmAssumptionAction } from "@/lib/actions";
import { EDIT_REASONS } from "@/lib/types";
import { ConfidenceBadge } from "./ConfidenceBadge";

type Line = {
  id: string;
  lineNumber: number;
  description: string;
  qty: number;
  unitPrice: number | null;
  confidenceState: string;
  clarification: string | null;
  leadDays: number | null;
  assumption: {
    id: string;
    text: string;
    confirmedAt: Date | string | null;
  } | null;
  priceBasis: {
    citationLabel: string | null;
    comparableCount: number;
    variance: number | null;
    unitPrice: number | null;
    asOfDate: Date | string | null;
    sourceType: string;
  } | null;
};

export function QuoteLineEditor({ line }: { line: Line }) {
  const [price, setPrice] = useState(line.unitPrice?.toString() ?? "");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  function savePrice() {
    const fd = new FormData();
    fd.set("quoteLineId", line.id);
    fd.set("field", "unitPrice");
    fd.set("newValue", price);
    if (reason) fd.set("reasonCode", reason);
    startTransition(() => updateQuoteLineAction(fd));
  }

  function confirmAssumption() {
    if (!line.assumption) return;
    const fd = new FormData();
    fd.set("assumptionId", line.assumption.id);
    startTransition(() => confirmAssumptionAction(fd));
  }

  return (
    <article className="border-b border-[var(--line)] py-4 last:border-0">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--ink-muted)]">
              Line {line.lineNumber}
            </span>
            <ConfidenceBadge state={line.confidenceState} />
          </div>
          <h3 className="mt-1 font-medium text-[var(--ink)]">{line.description}</h3>
          <p className="text-sm text-[var(--ink-muted)]">Qty {line.qty}</p>
        </div>
        <div className="text-right">
          {line.confidenceState === "RED" ? (
            <p className="text-sm font-medium text-[var(--red)]">Not priced</p>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--ink-muted)]">$</span>
              <input
                className="w-24 rounded border border-[var(--line)] bg-white px-2 py-1 text-right"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                onBlur={savePrice}
              />
            </div>
          )}
          {line.leadDays != null && (
            <p className="mt-1 text-xs text-[var(--ink-muted)]">{line.leadDays}d lead</p>
          )}
        </div>
      </div>

      {line.priceBasis && (
        <p className="mb-2 text-xs text-[var(--ink-muted)]">
          Price basis:{" "}
          <span className="font-medium text-[var(--brand)]">
            {line.priceBasis.citationLabel ?? line.priceBasis.sourceType}
          </span>
          {" · "}
          {line.priceBasis.comparableCount} comparable
          {line.priceBasis.comparableCount === 1 ? "" : "s"}
          {line.priceBasis.variance != null &&
            ` · CV ${(line.priceBasis.variance * 100).toFixed(0)}%`}
        </p>
      )}

      {line.assumption && (
        <div className="mb-2 rounded border border-[var(--amber)]/30 bg-[var(--amber-bg)]/60 px-3 py-2 text-sm">
          <p className="font-medium text-[var(--amber)]">Assumption</p>
          <p className="mt-1 text-[var(--ink)]">{line.assumption.text}</p>
          {line.assumption.confirmedAt ? (
            <p className="mt-1 text-xs text-[var(--green)]">Confirmed</p>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={confirmAssumption}
              className="mt-2 rounded bg-[var(--amber)] px-2 py-1 text-xs font-medium text-white"
            >
              Confirm assumption
            </button>
          )}
        </div>
      )}

      {line.clarification && (
        <div className="mb-2 rounded border border-[var(--red)]/30 bg-[var(--red-bg)]/50 px-3 py-2 text-sm">
          <p className="font-medium text-[var(--red)]">Clarification draft</p>
          <p className="mt-1">{line.clarification}</p>
        </div>
      )}

      {line.unitPrice != null && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="text-[var(--ink-muted)]">Edit reason</label>
          <select
            className="rounded border border-[var(--line)] bg-white px-2 py-1"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="">Optional</option>
            {EDIT_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending}
            onClick={savePrice}
            className="rounded border border-[var(--line)] bg-white px-2 py-1 hover:bg-[var(--bg-elevated)]"
          >
            Save edit
          </button>
        </div>
      )}
    </article>
  );
}
