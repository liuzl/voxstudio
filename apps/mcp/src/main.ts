#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FfplaySink, loadConfig } from "@voxstudio/platform-bun";
import { createAgentVoiceServer } from "./server";

const usage = `usage: vox-mcp [--config CONFIG]

Agent voice: voxstudio's voice I/O as an MCP server over stdio (docs/agent-voice-mcp.md).
Tools: speak (host speakers), transcribe (local file), list_voices. Point any MCP client
at this binary — e.g. in Claude Code:

  claude mcp add voxstudio -- bun ${import.meta.path}

Playback needs ffplay (ffmpeg) on PATH. Engines come from the standard config lookup.`;

async function main(args: string[]): Promise<number> {
  let explicit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      return 0;
    } else if (arg === "--config") {
      const next = args[++index];
      if (!next) throw new TypeError("vox-mcp: --config requires a value");
      explicit = next;
    } else {
      throw new TypeError(`vox-mcp: unknown option ${arg}`);
    }
  }
  const config = explicit === undefined ? await loadConfig() : await loadConfig({ explicit });
  const server = createAgentVoiceServer(config, {
    createSink: () => new FfplaySink(),
    // stdout carries the protocol; logs go to stderr like every stdio MCP server.
    log: line => console.error(`vox-mcp: ${line}`),
  });
  await server.connect(new StdioServerTransport());
  // The transport owns the lifetime: stdin closing ends the session and the process.
  return await new Promise<number>(resolve => {
    server.server.onclose = () => resolve(0);
  });
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
