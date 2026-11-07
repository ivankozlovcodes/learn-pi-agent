/**
 * Chapter 12 vitest config: run only the test/ directory, exclude fixture/.
 * fixture is the E2E temp project; its tests/calculator.test.ts is a script-style assertion run by the product bash tool
 * (npm test), not a vitest case (and it is supposed to fail while the bug is present).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
