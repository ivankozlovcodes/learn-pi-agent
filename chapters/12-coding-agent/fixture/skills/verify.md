# Verification skill (verify)

Fix workflow: after changing src/calculator.ts you must run `npm test` to validate; the task is done only when all tests pass.

Steps:
1. First use read_file to read src/calculator.ts and tests/calculator.test.ts and understand the expected behavior;
2. Fix the bug with edit or write_file;
3. Run `npm test` with bash;
4. If the tests still fail, read back the test output and the source, and keep fixing until the output says "All tests passed";
5. In the final reply, describe the fix and the test results.
