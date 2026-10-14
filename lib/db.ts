import { PrismaClient } from "@prisma/client";

// Singleton Prisma client — prevents exhausting the connection pool
// when hot-reloading in development (Next.js route handlers).
//
// Strategy: store the client on globalThis so that Next.js module
// re-evaluation does not create a new instance.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
