import { prisma } from "./db";

/**
 * Tell the estimator a draft is waiting. Nothing here reaches the buyer.
 *
 * PRD §5.3: "The tool never sends without approval." This module is the only
 * outbound-mail path in the codebase, and it exists solely to notify the shop's
 * own estimator. `assertNotBuyerAddress` enforces that structurally rather than
 * by convention — see the guard below and the test that covers it.
 */

export type NotifyResult = {
  notificationId: string;
  emailStatus: string;
};

/** Thrown when a notification would be addressed to the requester. */
export class BuyerAddressError extends Error {
  constructor(address: string) {
    super(
      `Refusing to send notification to ${address}: it is the address the RFQ came from. ` +
        "Notifications go to the shop's estimator. Quotes reach a buyer only through an " +
        "explicit estimator action on the review screen.",
    );
    this.name = "BuyerAddressError";
  }
}

/**
 * A notification must never be addressed to whoever sent the RFQ. Without this,
 * one misconfigured NOTIFY_EMAIL would mail a machine-drafted quote summary
 * straight to the customer.
 */
export function assertNotBuyerAddress(to: string, buyerEmail?: string | null): void {
  if (!buyerEmail) return;
  if (to.trim().toLowerCase() === buyerEmail.trim().toLowerCase()) {
    throw new BuyerAddressError(to);
  }
}

export async function notifyDraftReady(args: {
  workspaceId: string;
  rfqId: string;
  subject: string | null;
  fromEmail: string | null;
  /** Line-state counts, so the estimator knows what is waiting. */
  states: string[];
}): Promise<NotifyResult> {
  const green = args.states.filter((s) => s === "GREEN").length;
  const amber = args.states.filter((s) => s === "AMBER").length;
  const red = args.states.filter((s) => s === "RED").length;

  const title = `Draft ready: ${args.subject ?? "Inbound RFQ"}`;
  const body =
    `${args.states.length} line${args.states.length === 1 ? "" : "s"} drafted — ` +
    `${green} GREEN, ${amber} AMBER, ${red} RED. ` +
    `From ${args.fromEmail ?? "unknown sender"}. Nothing has been sent to the customer.`;
  const linkPath = `/rfqs/${args.rfqId}`;

  const estimator = await prisma.user.findFirst({
    where: { workspaceId: args.workspaceId, role: "estimator" },
    orderBy: { createdAt: "asc" },
  });

  const emailStatus = await sendNotificationEmail({
    to: process.env.NOTIFY_EMAIL ?? estimator?.email ?? null,
    buyerEmail: args.fromEmail,
    subject: title,
    body: `${body}\n\nReview: ${appUrl()}${linkPath}`,
  });

  const notification = await prisma.notification.create({
    data: {
      workspaceId: args.workspaceId,
      userId: estimator?.id ?? null,
      kind: "draft_ready",
      title,
      body,
      linkPath,
      emailStatus,
    },
  });

  return { notificationId: notification.id, emailStatus };
}

export async function notifyIngestError(args: {
  workspaceId: string;
  subject: string | null;
  fromEmail: string | null;
  message: string;
}): Promise<NotifyResult> {
  const estimator = await prisma.user.findFirst({
    where: { workspaceId: args.workspaceId, role: "estimator" },
    orderBy: { createdAt: "asc" },
  });

  const notification = await prisma.notification.create({
    data: {
      workspaceId: args.workspaceId,
      userId: estimator?.id ?? null,
      kind: "ingest_error",
      title: `Inbound email could not be drafted: ${args.subject ?? "(no subject)"}`,
      body: `${args.message} From ${args.fromEmail ?? "unknown sender"}.`,
      linkPath: "/inbound",
      emailStatus: "not_sent:error_notification",
    },
  });

  return { notificationId: notification.id, emailStatus: "not_sent:error_notification" };
}

/**
 * Outbound notification mail, via Resend when configured.
 *
 * When no provider is configured this returns a `not_sent:*` status rather than
 * throwing or pretending. The in-app notification is the reliable channel; email
 * is the convenience one, and the record says plainly which happened.
 */
async function sendNotificationEmail(args: {
  to: string | null;
  buyerEmail: string | null;
  subject: string;
  body: string;
}): Promise<string> {
  if (!args.to) return "not_sent:no_recipient";

  // Structural guard, before any network call.
  assertNotBuyerAddress(args.to, args.buyerEmail);

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_FROM_EMAIL;
  if (!apiKey || !from) return "not_sent:no_provider_configured";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [args.to],
        subject: args.subject,
        text: args.body,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return `not_sent:provider_${res.status}`;
    return "sent";
  } catch (err) {
    return `not_sent:${(err as Error).name}`;
  }
}

function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
