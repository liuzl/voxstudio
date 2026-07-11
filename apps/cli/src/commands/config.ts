import type { VoxConfig } from "@voxstudio/contracts";
import type { CliIo } from "../io";

export const configUsage = "usage: vox config validate";

export function runConfig(args: string[], config: VoxConfig, io: CliIo): number {
  if (args.length !== 1 || args[0] !== "validate") throw new TypeError("config: expected validate");
  for (const [name, value] of Object.entries(config.engines).sort(([a], [b]) => a.localeCompare(b))) {
    io.out(`${name}\t${value.baseUrl}\t${value.model}`);
  }
  io.out(`chunking\tmax=${config.chunking.maxSeconds}s first=${config.chunking.firstMaxSeconds}s growth=${config.chunking.growth}`);
  return 0;
}
