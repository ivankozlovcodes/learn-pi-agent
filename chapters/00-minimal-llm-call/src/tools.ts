/**
 * Chapter 00 shared base: demo tool set (echo + calculator), reused by every chapter.
 * Pi anchor: tools are the `context.tools` array (types.ts L418); lookup is in `prepareToolCall` L607.
 */
import type { Tool } from "./types.ts";

export function createEchoTool(): Tool<{ text: string }> {
  return {
    name: "echo",
    description: "Returns the text field you pass in, unchanged",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo back" } },
      required: ["text"],
    },
    async execute({ text }) {
      return { content: text };
    },
  };
}

export function createCalculatorTool(): Tool<{ a: number; b: number }> {
  return {
    name: "calculator",
    description: "Computes the sum of two numbers, a + b",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First addend" },
        b: { type: "number", description: "Second addend" },
      },
      required: ["a", "b"],
    },
    async execute({ a, b }) {
      return { content: String(a + b) };
    },
  };
}

export function createDemoTools(): Tool[] {
  return [createEchoTool(), createCalculatorTool()];
}
