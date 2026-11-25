import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";
import {
  asQueryable,
  connectPostgres,
  type Queryable,
} from "@kiro-ai-bit/eventing";

export type Db = NodePgDatabase<typeof schema>;
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Database {
  db: Db;
  queryable: Queryable;
  close: () => Promise<void>;
}

export function openDatabase(dsn: string): Database {
  const pool = new pg.Pool({ connectionString: dsn });
  const db = drizzleNodePg(pool, { schema });
  return {
    db,
    queryable: asQueryable(pool),
    close: () => pool.end(),
  };
}

export function openBroker(dsn: string): {
  queryable: Queryable;
  close: () => Promise<void>;
} {
  const pool = connectPostgres(dsn);
  return { queryable: asQueryable(pool), close: () => pool.end() };
}
