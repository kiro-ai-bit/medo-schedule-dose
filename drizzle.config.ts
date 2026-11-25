import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./Infrastructure/Persistence/schema/*.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://schedule_dose:schedule_dose@localhost:5432/schedule_dose_db",
  },
});
