"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { ingestRfq } from "./ingest";
import { draftQuoteForRfq } from "./draft";
import { getWorkspaceContext } from "./workspace";

export async function createRfqAction(formData: FormData) {
  const { workspace } = await getWorkspaceContext();
  const subject = String(formData.get("subject") ?? "");
  const fromEmail = String(formData.get("fromEmail") ?? "");
  const fromName = String(formData.get("fromName") ?? "");
  const body = String(formData.get("body") ?? "");
  if (!body.trim()) {
    throw new Error("RFQ body is required");
  }

  const { rfq } = await ingestRfq({
    workspaceId: workspace.id,
    subject: subject || undefined,
    fromEmail: fromEmail || undefined,
    fromName: fromName || undefined,
    body,
    channel: "upload",
    fileName: "paste.txt",
  });

  redirect(`/rfqs/${rfq.id}`);
}

export async function redraftAction(rfqId: string) {
  await draftQuoteForRfq(rfqId);
  revalidatePath(`/rfqs/${rfqId}`);
}

export async function updateQuoteLineAction(formData: FormData) {
  const { user } = await getWorkspaceContext();
  const quoteLineId = String(formData.get("quoteLineId"));
  const field = String(formData.get("field"));
  const newValue = String(formData.get("newValue"));
  const reasonCode = String(formData.get("reasonCode") || "") || null;

  const line = await prisma.quoteLine.findUniqueOrThrow({
    where: { id: quoteLineId },
    include: { quote: true },
  });

  let oldValue: string | null = null;
  const data: Record<string, unknown> = {};

  if (field === "unitPrice") {
    oldValue = line.unitPrice?.toString() ?? null;
    data.unitPrice = newValue === "" ? null : parseFloat(newValue);
  } else if (field === "description") {
    oldValue = line.description;
    data.description = newValue;
  } else if (field === "qty") {
    oldValue = line.qty.toString();
    data.qty = parseFloat(newValue);
  } else if (field === "confidenceState") {
    oldValue = line.confidenceState;
    data.confidenceState = newValue;
  }

  await prisma.quoteLine.update({
    where: { id: quoteLineId },
    data,
  });

  await prisma.editEvent.create({
    data: {
      quoteLineId,
      field,
      oldValue,
      newValue,
      reasonCode,
      userId: user.id,
    },
  });

  // Recalc total
  const lines = await prisma.quoteLine.findMany({ where: { quoteId: line.quoteId } });
  const total = lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.qty, 0);
  await prisma.quote.update({
    where: { id: line.quoteId },
    data: { total },
  });

  revalidatePath(`/rfqs/${line.quote.rfqId}`);
}

export async function confirmAssumptionAction(formData: FormData) {
  const { user } = await getWorkspaceContext();
  const assumptionId = String(formData.get("assumptionId"));
  await prisma.assumption.update({
    where: { id: assumptionId },
    data: { confirmedBy: user.id, confirmedAt: new Date() },
  });
  const a = await prisma.assumption.findUniqueOrThrow({
    where: { id: assumptionId },
    include: { quoteLine: { include: { quote: true } } },
  });
  revalidatePath(`/rfqs/${a.quoteLine.quote.rfqId}`);
}

export async function markSentAction(rfqId: string) {
  const quote = await prisma.quote.findUnique({ where: { rfqId } });
  if (!quote) throw new Error("No quote");
  await prisma.quote.update({
    where: { id: quote.id },
    data: { sentAt: new Date() },
  });
  await prisma.rfq.update({
    where: { id: rfqId },
    data: { status: "sent" },
  });
  revalidatePath(`/rfqs/${rfqId}`);
  revalidatePath("/");
}

export async function recordOutcomeAction(formData: FormData) {
  const quoteId = String(formData.get("quoteId"));
  const result = String(formData.get("result"));
  const competitorPriceRaw = String(formData.get("competitorPrice") ?? "");
  const competitorPrice =
    competitorPriceRaw.trim() === "" ? null : parseFloat(competitorPriceRaw);

  await prisma.outcome.upsert({
    where: { quoteId },
    create: { quoteId, result, competitorPrice },
    update: { result, competitorPrice, at: new Date() },
  });

  const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  await prisma.rfq.update({
    where: { id: quote.rfqId },
    data: { status: "closed" },
  });
  revalidatePath(`/rfqs/${quote.rfqId}`);
  revalidatePath("/");
}

export async function updateSettingsAction(formData: FormData) {
  const { workspace } = await getWorkspaceContext();
  const marginFloorPct = parseFloat(String(formData.get("marginFloorPct")));
  const materials = String(formData.get("materials") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxLeadDays = parseInt(String(formData.get("maxLeadDays") ?? "45"), 10);
  const minOrderValue = parseFloat(String(formData.get("minOrderValue") ?? "250"));

  const envelope = {
    ...JSON.parse(workspace.capabilityEnvelope || "{}"),
    materials,
    maxLeadDays,
    minOrderValue,
  };

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: {
      marginFloorPct,
      requireCostForGreen: formData.get("requireCostForGreen") != null,
      capabilityEnvelope: JSON.stringify(envelope),
    },
  });

  revalidatePath("/settings");
}

export async function completeOnboardingAction(formData: FormData) {
  const { workspace } = await getWorkspaceContext();
  const marginFloorPct = parseFloat(String(formData.get("marginFloorPct") ?? "25"));
  const materials = String(formData.get("materials") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: {
      marginFloorPct,
      requireCostForGreen: formData.get("requireCostForGreen") != null,
      capabilityEnvelope: JSON.stringify({
        materials:
          materials.length > 0
            ? materials
            : ["A36", "A572", "SS304", "SS316", "AL6061", "Mild Steel", "Aluminum"],
        maxSizeIn: 120,
        toleranceClasses: ["±1/16", "±0.030", "ISO 2768-m"],
        certifications: ["ISO 9001"],
        maxLeadDays: 45,
        minOrderValue: 250,
      }),
      onboardedAt: new Date(),
    },
  });

  // Optional: paste historical lines as CSV-ish "part|desc|qty|price|material"
  const historyPaste = String(formData.get("historyPaste") ?? "").trim();
  if (historyPaste) {
    const rows = historyPaste.split(/\r?\n/).filter(Boolean);
    const quote = await prisma.historicalQuote.create({
      data: {
        workspaceId: workspace.id,
        quoteNumber: `IMPORT-${Date.now()}`,
        quotedAt: new Date(),
        lines: {
          create: rows.map((row) => {
            const [partNumber, description, qty, unitPrice, material] = row
              .split("|")
              .map((c) => c.trim());
            return {
              partNumber: partNumber || null,
              description: description || partNumber || "Imported line",
              qty: parseFloat(qty || "1") || 1,
              unitPrice: parseFloat(unitPrice || "0") || 0,
              material: material || null,
              sku: partNumber || null,
              specHash: `${partNumber || ""}|${material || ""}`.toLowerCase(),
            };
          }),
        },
      },
      include: { lines: true },
    });
    const total = quote.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
    await prisma.historicalQuote.update({
      where: { id: quote.id },
      data: { total },
    });
  }

  redirect("/");
}
