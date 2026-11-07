/**
 * Teaching extension: the hello tool (a simplified Pi examples/extensions/hello.ts, without defineTool/TypeBox).
 * Demonstrates the Extend capability (registerTool): after the wrapper injects ctx, the extension tool enters the loop's context.tools.
 */
import type { ExtensionAPI } from "../src/extension-api.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "hello",
    description: "Say hello to the given name",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Name to greet" } },
      required: ["name"],
    },
    async execute(args) {
      return { content: `Hello, ${String(args.name)}!`, details: { greeted: args.name } };
    },
  });
}
