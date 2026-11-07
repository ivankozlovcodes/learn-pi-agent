/**
 * Calculator: the fix target of the E2E scenario.
 * Note: the add implementation has a deliberate bug (written as subtraction by mistake), so the tests fail; the Coding Agent locates and fixes it.
 */
export function add(a: number, b: number): number {
  return a - b; // bug: should be a + b
}

export function multiply(a: number, b: number): number {
  return a * b;
}
