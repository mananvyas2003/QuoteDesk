# QuoteDesk

AI estimator that answers inbound RFQs for metal fabrication shops.

V1 implements the three PRD features: **ingest → draft (GREEN/AMBER/RED) → approve / send / learn**.

## Stack

- Next.js 16 (App Router) + TypeScript + Tailwind
- Prisma 5 + SQLite (local). Swap `DATABASE_URL` to Postgres for production.
- Deterministic extraction + historical price-basis resolution (multimodal OCR can replace the extractor later)

## Setup

```bash
npm install
npx prisma db push
npm run db:seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Seeded shop: **Summit Metal Fab** (metal fabrication) with historical quote corpus.

## Demo path

1. **Inbox** — RFQ list + answer coverage
2. **Ingest** — paste an email (sample pre-filled) → extract lines with source pointers → auto-draft
3. **Review** — source left / draft right; edit prices (captured as training signals); confirm AMBER assumptions; copy-out or mark sent
4. **Outcome** — after send, record won / lost / no decision
5. **Settings** — margin floor + capability envelope (controller controls)
6. **History** — priced-line corpus used for price basis

## PRD alignment

| Feature | Status |
|---|---|
| §5.1 Ingest + source pointers | Done (paste/forward text; OCR stub-ready) |
| §5.2 Priced / assumptions / decline / clarify | Done |
| §5.3 Approve, edit capture, outcome | Done |
| §5.4 Confidence gating | Done (N=3, M=12mo, CV=15%) |
| §6 Data model | Done |
| §7 Cold start / onboarding | Done |
| Email IMAP auto-forward | Stub (ingest email shown in settings) |
| Scanned raster title-block OCR | Not yet — text/table extraction only |

## Scripts

- `npm run dev` — local app
- `npm run db:seed` — reset demo corpus
- `npm run db:studio` — Prisma Studio
- `npm run build` — production build
