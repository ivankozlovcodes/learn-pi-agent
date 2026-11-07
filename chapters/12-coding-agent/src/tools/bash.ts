/**
 * Chapter 12 product tool: bash (execute shell commands; a teaching subset of Pi blueprint harness/tools/bash.ts, 161 lines in full,
 * and coding-agent/src/core/tools/bash.ts, 545 lines in full).
 *
 * Mechanisms aligned with Pi:
 * - parameters schema (Pi bashSchema L11-14): command / timeout (seconds, optional)
 * - timeout validation (Pi L41-49: a finite positive number, capped at MAX_TIMEOUT_SECONDS=2147483.647 seconds, bash.ts L8)
 * - a non-zero exit code throws (Pi harness L152-154: Command exited with code X); the Chapter 01 pipeline turns it into an error toolResult
 * - a timeout throws (Pi L146-150: Command timed out after N seconds)
 * - stdout and stderr are returned merged (Pi createLocalShellOperations L126-127: both streams go into the output)
 * - output truncation keeps the tail (Pi keeps the last N lines, truncate.ts DEFAULT_MAX_LINES=2000 / DEFAULT_MAX_BYTES=50KB, L11-12)
 *
 * Trimmed for teaching:
 * - the tool has no guard (same as Pi: the permission policy lives in an Extension, permission-gate blocks before execute, and this tool runs any command)
 * - onUpdate streaming output (Pi BASH_UPDATE_THROTTLE_MS 100ms throttle, L74-105) is not taught
 * - persisting the full output to disk after truncation (Pi fullOutputPath temp file, L130-141) is not taught; only a truncation notice is given
 * - process tree management (Pi killProcessTree/trackDetachedChildPid), command prefixes and PI_* env var injection are not taught
 */
import { spawn } from "node:child_process";
import type { Tool } from "../../../00-minimal-llm-call/src/index.ts";

/** Output truncation limit (64KB chosen for teaching; Pi DEFAULT_MAX_BYTES=50KB, truncate.ts L12). */
export const BASH_MAX_BYTES = 64 * 1024;
/** Timeout cap (Pi MAX_TIMEOUT_SECONDS L8 = 2_147_483_647 / 1000 = 2147483.647, rounded for teaching). */
const MAX_TIMEOUT_SECONDS = 2_147_483;

/** Create the bash tool (Pi createBashTool, harness/tools/bash.ts). */
export function createBashTool(cwd: string): Tool<{ command: string; timeout?: number }> {
  return {
    name: "bash",
    description: "Execute a shell command in the project directory. Returns stdout and stderr merged. Optional timeout (seconds).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional, no limit by default)" },
      },
      required: ["command"],
    },
    async execute(args, _onUpdate, signal) {
      validateTimeout(args.timeout);
      return new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", args.command], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          signal,
        });
        let output = "";
        let timedOut = false;
        const timer =
          args.timeout !== undefined
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
              }, args.timeout * 1000)
            : undefined;

        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(new Error(`Failed to start shell: ${error.message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (timedOut) {
            reject(new Error(`${output}\n\nCommand timed out after ${args.timeout} seconds`));
            return;
          }
          if (signal?.aborted) {
            reject(new Error(`${output}\n\nCommand aborted`));
            return;
          }
          const truncated = output.length > BASH_MAX_BYTES;
          const body = truncated
            ? `(output truncated, keeping only the last ${BASH_MAX_BYTES} bytes)\n${output.slice(-BASH_MAX_BYTES)}`
            : output;
          if (code !== 0) {
            reject(new Error(`${body}\n\nCommand exited with code ${code}`));
            return;
          }
          resolve({
            content: body || "(no output)",
            details: truncated ? { truncation: { truncated: true } } : undefined,
          });
        });
      });
    },
  };
}

/** Validate timeout (Pi validateTimeout L41-49). */
function validateTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a positive number of seconds");
  }
  if (timeout > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
}
