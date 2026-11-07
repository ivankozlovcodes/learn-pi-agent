/**
 * Chapter 12 tests: standalone cases for the five product tools (offline, temp directory + controlled commands).
 *
 * Error semantics: a tool failure always throws, and the Chapter 01 pipeline turns it into an error toolResult (this file asserts rejects directly).
 * Each tool maps to a Pi blueprint; the anchors are noted in each file's header comment.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { createGrepTool } from "../src/tools/grep.ts";
import { createReadFileTool } from "../src/tools/read.ts";
import { createWriteFileTool } from "../src/tools/write.ts";

/** A separate temp directory per case (the project root, i.e. the tool cwd). */
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "lpia-ch12-tools-"));
  projectDirs.push(dir);
  return dir;
}

const projectDirs: string[] = [];
afterAll(() => {
  for (const dir of projectDirs) rmSync(dir, { recursive: true, force: true });
});

describe("read_file（Pi harness/tools/read.ts）", () => {
  it("reads file content, offset/limit slice by line", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.txt"), "line1\nline2\nline3\n", "utf8");
    const tool = createReadFileTool(cwd);

    // Trailing newline matches Pi (split/join keeps the file as-is; same semantics as Pi read.ts L97-98)
    const full = await tool.execute({ path: "a.txt" });
    expect(full.content).toBe("line1\nline2\nline3\n");

    const sliced = await tool.execute({ path: "a.txt", offset: 2, limit: 1 });
    expect(sliced.content).toContain("line2");
    expect(sliced.content).toContain("offset=3");

    // When limit doesn't reach the end, hint to continue
    const partial = await tool.execute({ path: "a.txt", limit: 2 });
    expect(partial.content).toContain("offset=3");
  });

  it("reading a missing file → error", async () => {
    const tool = createReadFileTool(tempProject());
    await expect(tool.execute({ path: "missing.ts" })).rejects.toThrow("Cannot read file");
  });

  it("offset beyond end of file → error", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.txt"), "one line", "utf8");
    const tool = createReadFileTool(cwd);
    await expect(tool.execute({ path: "a.txt", offset: 10 })).rejects.toThrow("beyond end of file");
  });

  it("truncates an overly long file and hints the offset to continue from", async () => {
    const cwd = tempProject();
    const manyLines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(cwd, "big.txt"), manyLines + "\n", "utf8");
    const tool = createReadFileTool(cwd);

    const result = await tool.execute({ path: "big.txt" });
    expect(result.content).toContain("Use offset=501 to continue");
    // 600 lines + trailing newline = 601 lines (split semantics match Pi)
    expect(result.details).toMatchObject({ truncation: { truncated: true, totalLines: 601 } });
  });

  it("path resolution contract: cwd is the resolution base, not a sandbox (../ can resolve outside cwd, same as Pi resolveToolPath)", async () => {
    const parent = tempProject();
    const cwd = join(parent, "project");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(parent, "outside.txt"), "outside\n", "utf8");
    const tool = createReadFileTool(cwd);

    const result = await tool.execute({ path: "../outside.txt" });
    expect(result.content).toBe("outside\n");
  });
});

describe("write_file（Pi harness/tools/write.ts）", () => {
  it("write a file → reads back the same (creates parent directories automatically)", async () => {
    const cwd = tempProject();
    const tool = createWriteFileTool(cwd);
    const content = "export const answer = 42;\n";

    const result = await tool.execute({ path: "src/deep/answer.ts", content });
    expect(result.content).toContain("Successfully wrote");

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(cwd, "src/deep/answer.ts"), "utf8")).toBe(content);
  });

  it("overwrites an existing file", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.txt"), "old", "utf8");
    const tool = createWriteFileTool(cwd);

    await tool.execute({ path: "a.txt", content: "new" });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("new");
  });
});

describe("edit（Pi harness/tools/edit.ts）", () => {
  it("targeted string replacement → correct content, details carry a line-level diff", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "calc.ts"), "export function add(a: number, b: number): number {\n  return a - b; // bug\n}\n", "utf8");
    const tool = createEditTool(cwd);

    const result = await tool.execute({
      path: "calc.ts",
      edits: [{ oldText: "a - b", newText: "a + b" }],
    });
    expect(result.content).toContain("Successfully replaced 1 block(s)");
    const details = result.details as { firstChangedLine: number; diff: string } | undefined;
    expect(details).toMatchObject({ firstChangedLine: 2 });
    expect(details?.diff).toContain("- a - b");
    expect(details?.diff).toContain("+ a + b");

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(cwd, "calc.ts"), "utf8")).toContain("return a + b;");
  });

  it("applies multiple non-overlapping edits at once (all matched against the original file)", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "m.ts"), "a\nb\nc\nd\n", "utf8");
    const tool = createEditTool(cwd);

    await tool.execute({ path: "m.ts", edits: [{ oldText: "a", newText: "A" }, { oldText: "c", newText: "C" }] });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(cwd, "m.ts"), "utf8")).toBe("A\nb\nC\nd\n");
  });

  it("oldText not present → error", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "m.ts"), "hello\n", "utf8");
    const tool = createEditTool(cwd);
    await expect(tool.execute({ path: "m.ts", edits: [{ oldText: "nope", newText: "x" }] })).rejects.toThrow("oldText not found");
  });

  it("oldText not unique → error", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "m.ts"), "dup\ndup\n", "utf8");
    const tool = createEditTool(cwd);
    await expect(tool.execute({ path: "m.ts", edits: [{ oldText: "dup", newText: "x" }] })).rejects.toThrow("not unique");
  });

  it("overlapping edits → error (must be merged)", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "m.ts"), "abc\n", "utf8");
    const tool = createEditTool(cwd);
    await expect(
      tool.execute({ path: "m.ts", edits: [{ oldText: "ab", newText: "X" }, { oldText: "bc", newText: "Y" }] }),
    ).rejects.toThrow("overlap");
  });

  it("compatibility layer: a single edit object argument is normalized to an array (Chapter 03 prepareArguments)", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "m.ts"), "a\n", "utf8");
    const tool = createEditTool(cwd);
    const input = { path: "m.ts", oldText: "a", newText: "b" };
    await expect(tool.execute(tool.prepareArguments!(input) as never)).resolves.toMatchObject({
      content: "Successfully replaced 1 block(s) in m.ts",
    });
  });
});

describe("grep (Pi coding-agent/src/core/tools/grep.ts, exists only in the product layer)", () => {
  it("matches line numbers and content (recursive directory, skips node_modules)", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "src", "node_modules"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "const x = 1;\nexport function add(a: number, b: number) {\n  return a + b;\n}\n", "utf8");
    writeFileSync(join(cwd, "src", "node_modules", "dep.ts"), "export function add(a: number, b: number) {\n  return a - b;\n}\n", "utf8");
    const tool = createGrepTool(cwd);

    const result = await tool.execute({ pattern: "function add", path: "src" });
    expect(result.content).toContain("a.ts:2: export function add");
    expect(result.content).not.toContain("node_modules");

    // Line numbers and content are given per matching line (the function body line is hit with another pattern)
    const body = await tool.execute({ pattern: "return a \\+ b", path: "src" });
    expect(body.content).toContain("a.ts:3:   return a + b;");
  });

  it("glob filter and limit notice", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.ts"), "x\ny\n", "utf8");
    writeFileSync(join(cwd, "b.md"), "x\n", "utf8");
    const tool = createGrepTool(cwd);

    const globbed = await tool.execute({ pattern: "^x$", path: ".", glob: "*.ts" });
    expect(globbed.content).toContain("a.ts:1:");
    expect(globbed.content).not.toContain("b.md");

    const limited = await tool.execute({ pattern: "^x$", path: ".", limit: 1 });
    expect(limited.content).toContain("matches limit");
    expect(limited.details).toMatchObject({ matchLimitReached: 1 });
  });

  it("literal mode matches literally", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.ts"), "a.b\n", "utf8");
    const tool = createGrepTool(cwd);
    const result = await tool.execute({ pattern: "a.b", literal: true });
    expect(result.content).toContain("a.ts:1: a.b");
  });

  it("no matches returns a notice; missing path → error", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.ts"), "hello\n", "utf8");
    const tool = createGrepTool(cwd);

    const none = await tool.execute({ pattern: "zzz" });
    expect(none.content).toBe("No matches found");

    await expect(tool.execute({ pattern: "x", path: "missing" })).rejects.toThrow("Path not found");
  });

  it("invalid regex → error", async () => {
    const tool = createGrepTool(tempProject());
    await expect(tool.execute({ pattern: "(" })).rejects.toThrow("Invalid regex");
  });
});

describe("bash（Pi harness/tools/bash.ts + coding-agent core/tools/bash.ts）", () => {
  it("executes a command and returns output (stdout and stderr merged)", async () => {
    const cwd = tempProject();
    const tool = createBashTool(cwd);

    const ok = await tool.execute({ command: "echo hello" });
    expect(ok.content).toContain("hello");

    const merged = await tool.execute({ command: "echo out && echo err >&2" });
    expect(merged.content).toContain("out");
    expect(merged.content).toContain("err");
  });

  it("non-zero exit code → error result", async () => {
    const tool = createBashTool(tempProject());
    await expect(tool.execute({ command: "exit 3" })).rejects.toThrow("Command exited with code 3");
  });

  it("timeout → error result (Pi L146-150)", async () => {
    const tool = createBashTool(tempProject());
    await expect(tool.execute({ command: "sleep 3", timeout: 1 })).rejects.toThrow("timed out");
  }, 10000);

  it("AbortSignal aborts a long command → error result (Pi bash signal pass-through)", async () => {
    const tool = createBashTool(tempProject());
    const controller = new AbortController();
    const run = tool.execute({ command: "sleep 30" }, undefined, controller.signal);
    // Abort only after the shell has really started (sleep 30 gives an order of magnitude of margin, no reliance on exact timing);
    // abort while running → close path "Command aborted"; abort in the spawn window → the error path rejects too
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await expect(run).rejects.toThrow(/aborted/);
  }, 10000);

  it("output over 64KB is truncated, keeping the tail", async () => {
    const tool = createBashTool(tempProject());
    const result = await tool.execute({ command: "node -e \"process.stdout.write('a'.repeat(100 * 1024))\"" });
    expect(result.content).toContain("output truncated");
    expect(result.content.length).toBeLessThan(70 * 1024);
    expect(result.details).toMatchObject({ truncation: { truncated: true } });
  });

  it("the tool itself has no guard: the dangerous command allowlist check is not in the tool (boundary integrity E)", async () => {
    // Teaching point: the permission policy lives in an Extension (permission-gate), not in the tool or the loop.
    // The tool treats every command the same (execution separate from policy); blocking is done by the beforeToolCall hook (see e2e.test.ts).
    const tool = createBashTool(tempProject());
    const result = await tool.execute({ command: "echo the tool only executes" });
    expect(result.content).toContain("the tool only executes");
  });
});
