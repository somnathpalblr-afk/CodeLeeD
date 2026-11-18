import dotenv from "dotenv";
import path from "path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";

dotenv.config({
  path: path.resolve(import.meta.dirname, "../../../.env"),
});

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const adapter = new PrismaPg({
  connectionString: databaseUrl,
  max: 5,                        // small pool is plenty for a dev server
  idleTimeoutMillis: 10_000,     // close idle connections before the host drops them
  connectionTimeoutMillis: 30_000, // fail fast (and allow cold starts) instead of hanging
  keepAlive: true,               // send TCP keepalives so the connection isn't cut silently
});

export const db = new PrismaClient({ adapter });