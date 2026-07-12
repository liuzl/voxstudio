import { existsSync } from "node:fs";
import { join } from "node:path";

const helper = join(import.meta.dir, "dist", "vox-audio-host");
const clearPlaybackSignal = 30;
const framesPerPacket = 960;
const packetDurationMs = 20;
const playbackPackets = 250;

if (process.platform !== "darwin") {
  throw new Error("macOS audio smoke test requires macOS");
}
if (!existsSync(helper)) {
  throw new Error("macOS audio host not built; run ./platforms/macos-audio/build.sh first");
}

const child = Bun.spawn([helper], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
if (!child.stdin || typeof child.stdin === "number" || !child.stdout || typeof child.stdout === "number") {
  throw new Error("macOS audio host did not expose PCM streams");
}

const stderr = new Response(child.stderr).text();
let capturedBytes = 0;
const drainCapture = (async () => {
  for await (const chunk of child.stdout) capturedBytes += chunk.byteLength;
})();

const tone = new Float32Array(framesPerPacket);
for (let index = 0; index < tone.length; index += 1) {
  tone[index] = Math.sin((2 * Math.PI * 440 * index) / 48_000) * 0.08;
}

for (let packet = 0; packet < playbackPackets; packet += 1) {
  await child.stdin.write(new Uint8Array(tone.buffer));
  if (packet === Math.floor(playbackPackets / 2)) child.kill(clearPlaybackSignal);
  await Bun.sleep(packetDurationMs);
  if (child.exitCode !== null) throw new Error(`macOS audio host exited during playback: ${child.exitCode}`);
}

await Bun.sleep(500);
await child.stdin.end();
const exitCode = await child.exited;
await drainCapture;
const logs = await stderr;

if (exitCode !== 0) throw new Error(`macOS audio host exited with status ${exitCode}: ${logs}`);
if (!logs.includes("ready voice-processing=true")) throw new Error(`voice processing was not enabled: ${logs}`);
if (capturedBytes < 16_000 * Float32Array.BYTES_PER_ELEMENT) {
  throw new Error(`insufficient microphone capture: ${capturedBytes} bytes`);
}

console.log(`macOS audio smoke test passed: captured ${capturedBytes} bytes`);
