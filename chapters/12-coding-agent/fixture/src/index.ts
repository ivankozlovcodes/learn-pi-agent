/**
 * Calculator CLI entry: node --import tsx src/index.ts 2 3 prints the result of add(2, 3).
 * You can check the behavior by hand before running npm test.
 */
import { add } from "./calculator.ts";

const [aRaw, bRaw] = process.argv.slice(2);
const a = Number(aRaw);
const b = Number(bRaw);
if (Number.isNaN(a) || Number.isNaN(b)) {
  console.error("Usage: tsx src/index.ts <a> <b>");
  process.exit(1);
}
console.log(`${a} + ${b} = ${add(a, b)}`);
