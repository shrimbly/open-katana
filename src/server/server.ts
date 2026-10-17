import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { packageRoot } from "../util/paths.js";
import { State } from "./state.js";
import { registerAnalysisTools } from "./tools-analysis.js";
import { registerEditTools } from "./tools-edit.js";
import { registerGenerationTools } from "./tools-generate.js";
import { registerProjectTools } from "./tools-project.js";
import { registerWidgets } from "./widgets.js";

/** Read from package.json (found from dist/ and from src/ under tsx alike), so releases bump one place. */
export const VERSION: string = (JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string }).version;

const INSTRUCTIONS = `open-katana remixes a reference edit (aura edits especially) with the user's own character, product or outfit, generating shots on the user's ComfyUI and cutting the edit locally with ffmpeg.
A message starting with /katana (optionally /katana/<preset>) starts the workflow. If the katana skill is not loaded, call katana_guide first and follow it.
Order: katana_start → katana_backend (once) → katana_analyze → katana_view every review page → katana_review → katana_plan → show the estimate and get approval → katana_generate → katana_wait → katana_judge → katana_edit → katana_render (preview, then final) → katana_deliver. katana_studio gives the user a timeline editor link for the project at any point after the first edit.
A bare /katana with nothing attached opens katana_presets. Never generate before the review is logged and the user approved the estimate.`;

export function createServer(state = new State()): McpServer {
  const server = new McpServer({ name: "open-katana", version: VERSION }, { instructions: INSTRUCTIONS });
  registerProjectTools(server, state);
  registerAnalysisTools(server, state);
  registerGenerationTools(server, state);
  registerEditTools(server, state);
  registerWidgets(server, state);

  server.registerPrompt(
    "katana",
    {
      title: "open-katana: remix a reference edit",
      description: "Start an open-katana run: a preset and/or a reference video plus photos of your character.",
      argsSchema: z.object({
        preset: z.string().optional().describe("Preset slug, e.g. neon-rain"),
        reference: z.string().optional().describe("Reference video path or URL"),
        subjects: z.string().optional().describe("Comma-separated photo paths"),
        instructions: z.string().optional(),
      }),
    },
    ({ preset, reference, subjects, instructions }) => {
      const lines = [`/katana${preset ? `/${preset.replace(/^\/?katana\//, "")}` : ""}`];
      const media = [
        ...(reference ? [`- reference: ${reference}`] : []),
        ...(subjects ? subjects.split(",").map((s) => `- subject: ${s.trim()}`) : []),
      ];
      if (media.length) lines.push("", "MEDIA:", ...media);
      if (instructions) lines.push("", "INPUTS:", `- instructions: ${JSON.stringify(instructions)}`);
      lines.push("", "Run this with the open-katana tools (katana_guide has the workflow).");
      return { messages: [{ role: "user", content: { type: "text", text: lines.join("\n") } }] };
    },
  );
  return server;
}
