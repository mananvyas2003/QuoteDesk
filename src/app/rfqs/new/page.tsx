import { createRfqAction } from "@/lib/actions";

const SAMPLE = `From: buyer@acmeindustrial.example
Subject: RFQ — base plates and brackets

Hi team — need pricing by 09/20/2026.

Item | Description | Qty | Material
BP-1218 | Base plate 12x18x0.5 | 60 | A36
GB-88 | Guard bracket laser cut | 150 | A36

Also: same as PO 4471 but 400 units.

Thanks,
Pat`;

export default function NewRfqPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-plex-serif)] text-3xl text-[var(--brand)]">
          Ingest RFQ
        </h1>
        <p className="mt-2 text-[var(--ink-muted)]">
          Forward or paste an inbound quote request. We extract lines with source
          pointers, resolve against history, and draft a gated answer.
        </p>
      </div>

      <form action={createRfqAction} className="space-y-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">From email</span>
            <input
              name="fromEmail"
              defaultValue="buyer@acmeindustrial.example"
              className="w-full rounded border border-[var(--line)] bg-white px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">From name</span>
            <input
              name="fromName"
              defaultValue="Pat Buyer"
              className="w-full rounded border border-[var(--line)] bg-white px-3 py-2"
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Subject</span>
          <input
            name="subject"
            defaultValue="RFQ — base plates and brackets"
            className="w-full rounded border border-[var(--line)] bg-white px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Email / RFQ body</span>
          <textarea
            name="body"
            required
            rows={14}
            defaultValue={SAMPLE}
            className="w-full rounded border border-[var(--line)] bg-white px-3 py-2 font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--brand-hot)]"
        >
          Extract & draft answer
        </button>
      </form>
    </div>
  );
}
