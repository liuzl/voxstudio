import type { PcmStreamDecoder } from "@voxstudio/clients";

const decodedRate = 48_000; // Opus decodes natively at 48kHz; ffmpeg is pinned to match.
/**
 * Coalesce decoded PCM before yielding: ffmpeg emits one ~20ms piece per Opus packet
 * once the trickle is generation-paced, and a browser scheduling ~50 tiny buffers a
 * second turns each boundary's rounding into audible crackle (measured 2026-07-17:
 * median piece 20ms mid-reply — exactly where the noise sat). Raw-PCM streaming always
 * arrived in network-sized chunks; this restores that granularity.
 */
const minPieceSamples = Math.floor(0.24 * decodedRate);

/**
 * Ogg/Opus -> mono f32 PCM through the system ffmpeg — the same optional dependency
 * playback and recording already lean on. Returns undefined when ffmpeg is missing, so
 * callers can simply not negotiate compressed streams instead of failing mid-reply.
 */
export function ffmpegPcmDecoder(): PcmStreamDecoder | undefined {
  if (!Bun.which("ffmpeg")) return undefined;
  return {
    async *decode(body, signal) {
      const proc = Bun.spawn(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
          "-i", "pipe:0", "-f", "f32le", "-ar", String(decodedRate), "-ac", "1", "pipe:1"],
        { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
      );
      // Feed and read concurrently: a pipe filled from one end only would deadlock.
      const feed = (async () => {
        try {
          for await (const chunk of body) {
            proc.stdin.write(chunk);
            await proc.stdin.flush();
          }
        } catch {
          // The network stream died (abort/disconnect); EOF below ends the decode loop.
        } finally {
          try {
            await proc.stdin.end();
          } catch {
            // ffmpeg already gone — the finally below reaps it.
          }
        }
      })();
      try {
        // Network chunks split anywhere; samples are 4-byte floats, so carry the remainder.
        let pending = new Uint8Array(0);
        let gathered: Float32Array[] = [];
        let gatheredLength = 0;
        for await (const chunk of proc.stdout) {
          signal?.throwIfAborted();
          const bytes = new Uint8Array(pending.length + chunk.length);
          bytes.set(pending);
          bytes.set(chunk, pending.length);
          const usable = bytes.length - (bytes.length % 4);
          pending = bytes.slice(usable);
          if (usable === 0) continue;
          const view = new DataView(bytes.buffer, 0, usable);
          const samples = new Float32Array(usable / 4);
          for (let index = 0; index < samples.length; index += 1) {
            samples[index] = view.getFloat32(index * 4, true);
          }
          gathered.push(samples);
          gatheredLength += samples.length;
          if (gatheredLength < minPieceSamples) continue;
          const piece = new Float32Array(gatheredLength);
          let offset = 0;
          for (const part of gathered) {
            piece.set(part, offset);
            offset += part.length;
          }
          gathered = [];
          gatheredLength = 0;
          yield { samples: piece, sampleRate: decodedRate };
        }
        if (gatheredLength > 0) {
          const piece = new Float32Array(gatheredLength);
          let offset = 0;
          for (const part of gathered) {
            piece.set(part, offset);
            offset += part.length;
          }
          yield { samples: piece, sampleRate: decodedRate };
        }
        await feed;
      } finally {
        proc.kill();
      }
    },
  };
}
