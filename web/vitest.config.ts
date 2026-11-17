import { defineConfig } from "vitest/config";
// Tests never talk to Supabase; these placeholders only let lib.ts construct its client.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], env: { VITE_SUPABASE_URL: "http://localhost:54321", VITE_SUPABASE_ANON_KEY: "test-placeholder" } },
});
