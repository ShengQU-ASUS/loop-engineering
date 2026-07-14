import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["web/**/*.test.{ts,tsx}"],
    setupFiles: ["./web/test/setup.ts"],
    css: true,
  },
});
