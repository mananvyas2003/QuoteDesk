import type { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

/**
 * The Prisma client is constructed on first use, not at import.
 *
 * Anything that transitively imports this module — including `src/lib/resolve.ts`,
 * whose pricing half performs no I/O — used to require a generated client just
 * to be imported. On a fresh checkout, before `prisma generate` has run, a pure
 * unit test would fail with `Cannot find module '.prisma/client/default'`,
 * which says nothing about the code under test.
 *
 * Note that the *import statement* was the failure point, not the constructor:
 * `@prisma/client`'s entry resolves `.prisma/client/default` at require time.
 * So the import is deferred too, via a type-only import plus a runtime require
 * inside the getter.
 */
function getClient(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");
  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  // Unchanged behaviour: one client per process outside production, so dev
  // hot-reload does not open a new connection pool on every edit.
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = client;
  return client;
}

/**
 * Behaves exactly like a PrismaClient at every call site; the underlying client
 * is created the first time a property is read.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop) as unknown;
    // Bind methods to the real client so `this` is never the proxy.
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, prop) {
    return prop in getClient();
  },
});
