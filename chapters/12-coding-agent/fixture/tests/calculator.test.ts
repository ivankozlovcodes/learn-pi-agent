/**
 * Calculator tests (script-style assertions: a non-zero exit code means failure, and the bash npm test output is readable).
 * add(2, 3) should equal 5; the current implementation is mistakenly subtraction, so the assertion fails, and it passes after the fix.
 */
import { strict as assert } from "node:assert";
import { add, multiply } from "../src/calculator.ts";

const cases: Array<[number, number, number]> = [
  [2, 3, 5],
  [0, 0, 0],
  [-1, 1, 0],
  [10, 20, 30],
];

for (const [a, b, expected] of cases) {
  const actual = add(a, b);
  console.log(`add(${a}, ${b}) = ${actual}${actual === expected ? "" : `, expected ${expected}`}`);
  assert.equal(actual, expected, `add(${a}, ${b}) should equal ${expected}`);
}

assert.equal(multiply(3, 4), 12, "multiply(3, 4) should equal 12");
console.log("All tests passed");
