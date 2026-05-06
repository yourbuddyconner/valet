import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/sqlite.ts",
  out: "./migrations/sqlite",
});
