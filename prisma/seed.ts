import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * The demo corpus is INVENTED DATA. It exists so the UI can be smoke-tested
 * without a customer's quote history, and for nothing else.
 *
 * It must never be loaded by accident, and a workspace holding it is flagged
 * `isDemo` so the UI banners it and scripts/backtest.ts refuses to measure
 * against it. Loading it is a deliberate act, hence the required flag.
 */
async function main() {
  if (!process.argv.includes("--demo")) {
    console.error(
      [
        "",
        "Refusing to seed: this corpus is SYNTHETIC.",
        "",
        "Its prices are invented. Anything measured against it — GREEN rate,",
        "pricing accuracy, K3 — is meaningless. It is for UI smoke-testing only.",
        "",
        "If that is what you want, ask for it explicitly:",
        "",
        "    npm run db:seed -- --demo",
        "",
        "The workspace it creates is flagged isDemo, banners itself in the UI,",
        "and is refused by scripts/backtest.ts.",
        "",
        "To onboard a real shop instead, see PRD §7 and scripts/BACKTEST.md.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  await prisma.outcome.deleteMany();
  await prisma.editEvent.deleteMany();
  await prisma.assumption.deleteMany();
  await prisma.quoteLine.deleteMany();
  await prisma.quote.deleteMany();
  await prisma.priceBasis.deleteMany();
  await prisma.resolvedItem.deleteMany();
  await prisma.rfqLine.deleteMany();
  await prisma.rfq.deleteMany();
  await prisma.historicalQuoteLine.deleteMany();
  await prisma.historicalQuote.deleteMany();
  await prisma.vendorPrice.deleteMany();
  await prisma.account.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();

  const workspace = await prisma.workspace.create({
    data: {
      name: "Summit Metal Fab (DEMO — synthetic prices)",
      vertical: "metal_fabrication",
      marginFloorPct: 25,
      isDemo: true,
      ingestEmail: "quotes@summitmetalfab.example",
      capabilityEnvelope: JSON.stringify({
        materials: ["A36", "A572", "SS304", "SS316", "AL6061", "Mild Steel", "Aluminum"],
        maxSizeIn: 120,
        toleranceClasses: ["±1/16", "±0.030", "ISO 2768-m"],
        certifications: ["ISO 9001"],
        maxLeadDays: 45,
        minOrderValue: 250,
      }),
      onboardedAt: new Date(),
    },
  });

  const estimator = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: "estimator@summitmetalfab.example",
      name: "Alex Rivera",
      role: "estimator",
    },
  });

  await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: "controller@summitmetalfab.example",
      name: "Jordan Chen",
      role: "controller",
    },
  });

  const acme = await prisma.account.create({
    data: {
      workspaceId: workspace.id,
      name: "Acme Industrial",
      domain: "acmeindustrial.example",
    },
  });

  const northstar = await prisma.account.create({
    data: {
      workspaceId: workspace.id,
      name: "Northstar Equipment",
      domain: "northstareq.example",
    },
  });

  const monthsAgo = (n: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    return d;
  };

  const corpus: Array<{
    accountId: string;
    quoteNumber: string;
    monthsAgo: number;
    lines: Array<{
      description: string;
      partNumber?: string;
      material?: string;
      finish?: string;
      qty: number;
      unitPrice: number;
      sku?: string;
    }>;
  }> = [
    {
      accountId: acme.id,
      quoteNumber: "Q-4412",
      monthsAgo: 2,
      lines: [
        {
          description: "Base plate 12x18x0.5",
          partNumber: "BP-1218",
          material: "A36",
          finish: "mill",
          qty: 50,
          unitPrice: 48.5,
          sku: "FAB-BP-1218",
        },
        {
          description: "Guard bracket laser cut",
          partNumber: "GB-88",
          material: "A36",
          finish: "powder black",
          qty: 100,
          unitPrice: 12.75,
          sku: "FAB-GB-88",
        },
      ],
    },
    {
      accountId: acme.id,
      quoteNumber: "Q-4388",
      monthsAgo: 5,
      lines: [
        {
          description: "Base plate 12x18x0.5",
          partNumber: "BP-1218",
          material: "A36",
          finish: "mill",
          qty: 25,
          unitPrice: 52.0,
          sku: "FAB-BP-1218",
        },
        {
          description: "Guard bracket laser cut",
          partNumber: "GB-88",
          material: "A36",
          finish: "powder black",
          qty: 200,
          unitPrice: 11.9,
          sku: "FAB-GB-88",
        },
      ],
    },
    {
      accountId: acme.id,
      quoteNumber: "Q-4301",
      monthsAgo: 9,
      lines: [
        {
          description: "Base plate 12x18x0.5",
          partNumber: "BP-1218",
          material: "A36",
          qty: 40,
          unitPrice: 49.25,
          sku: "FAB-BP-1218",
        },
      ],
    },
    {
      accountId: northstar.id,
      quoteNumber: "Q-4502",
      monthsAgo: 1,
      lines: [
        {
          description: "SS shaft collar 2in",
          partNumber: "SC-200",
          material: "SS304",
          finish: "passivate",
          qty: 80,
          unitPrice: 22.4,
          sku: "FAB-SC-200",
        },
        {
          description: "Weldment frame 24x36",
          partNumber: "WF-2436",
          material: "A572",
          finish: "primer",
          qty: 10,
          unitPrice: 385,
          sku: "FAB-WF-2436",
        },
      ],
    },
    {
      accountId: northstar.id,
      quoteNumber: "Q-4471",
      monthsAgo: 4,
      lines: [
        {
          description: "Weldment frame 24x36",
          partNumber: "WF-2436",
          material: "A572",
          finish: "primer",
          qty: 8,
          unitPrice: 400,
          sku: "FAB-WF-2436",
        },
        {
          description: "SS shaft collar 2in",
          partNumber: "SC-200",
          material: "SS304",
          finish: "passivate",
          qty: 40,
          unitPrice: 23.1,
          sku: "FAB-SC-200",
        },
      ],
    },
    {
      accountId: northstar.id,
      quoteNumber: "PO-4471",
      monthsAgo: 3,
      lines: [
        {
          description: "Weldment frame 24x36 — prior PO",
          partNumber: "WF-2436",
          material: "A572",
          finish: "primer",
          qty: 12,
          unitPrice: 390,
          sku: "FAB-WF-2436",
        },
      ],
    },
    {
      accountId: acme.id,
      quoteNumber: "Q-4200",
      monthsAgo: 11,
      lines: [
        {
          description: "Angle clip 3x3x0.25",
          partNumber: "AC-33",
          material: "A36",
          qty: 500,
          unitPrice: 3.2,
          sku: "FAB-AC-33",
        },
        {
          description: "Angle clip 3x3x0.25",
          partNumber: "AC-33",
          material: "A36",
          qty: 1000,
          unitPrice: 2.85,
          sku: "FAB-AC-33",
        },
        {
          description: "Angle clip 3x3x0.25",
          partNumber: "AC-33",
          material: "A36",
          qty: 250,
          unitPrice: 3.45,
          sku: "FAB-AC-33",
        },
      ],
    },
  ];

  for (const q of corpus) {
    const total = q.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
    await prisma.historicalQuote.create({
      data: {
        workspaceId: workspace.id,
        accountId: q.accountId,
        quoteNumber: q.quoteNumber,
        quotedAt: monthsAgo(q.monthsAgo),
        total,
        lines: {
          create: q.lines.map((l) => ({
            description: l.description,
            partNumber: l.partNumber,
            material: l.material,
            finish: l.finish,
            qty: l.qty,
            unitPrice: l.unitPrice,
            sku: l.sku,
            specHash: `${l.partNumber ?? ""}|${l.material ?? ""}|${l.finish ?? ""}`.toLowerCase(),
          })),
        },
      },
    });
  }

  await prisma.vendorPrice.createMany({
    data: [
      {
        workspaceId: workspace.id,
        sku: "FAB-BP-1218",
        description: "Base plate blank 12x18x0.5 A36",
        material: "A36",
        unitPrice: 18.5,
        asOfDate: monthsAgo(1),
        vendorName: "Midwest Plate",
      },
      {
        workspaceId: workspace.id,
        sku: "FAB-SC-200",
        description: "SS304 bar for collar",
        material: "SS304",
        unitPrice: 8.2,
        asOfDate: monthsAgo(0),
        vendorName: "Alloy Supply Co",
      },
    ],
  });

  console.log("");
  console.log("Seeded DEMO workspace:", workspace.name);
  console.log("Prices are synthetic. Not valid for evaluation.");
  console.log("Estimator login email:", estimator.email);
  console.log("Workspace id:", workspace.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
