import { loadConfig, buildApp } from "./bootstrap.js";
import { openDatabase, openBroker } from "@infrastructure/Persistence/db.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";

const config = loadConfig();
const database = openDatabase(config.databaseUrl);
const broker = openBroker(config.brokerDatabaseUrl);

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);
await migrate(database.db, { migrationsFolder });

const built = await buildApp({
  config,
  db: database.db,
  scheduleDoseQueryable: database.queryable,
  brokerQueryable: broker.queryable,
  brokerDsn: config.brokerDatabaseUrl,
  startWorkers: true,
});

const shutdown = async () => {
  await built.close();
  await database.close();
  await broker.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await built.app.listen({ port: config.port, host: "0.0.0.0" });
