import { open, type FileHandle } from "node:fs/promises";
import { encodePcm16, type PcmAudio, wavHeader } from "@voxstudio/audio";

type BunFileSink = ReturnType<ReturnType<typeof Bun.file>["writer"]>;

async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (result.bytesWritten === 0) throw new TypeError("WAV file write made no progress");
    offset += result.bytesWritten;
  }
}

export interface PcmSink {
  write(audio: PcmAudio): Promise<void>;
  close(): Promise<void>;
}

export class WavFileSink implements PcmSink {
  private readonly path: string;
  private handle: FileHandle | null = null;
  private sampleRate: number | null = null;
  private sampleCount = 0;
  private offset = 44;
  private closed = false;

  constructor(path: string) {
    this.path = path;
  }

  async write(audio: PcmAudio): Promise<void> {
    if (this.closed) throw new TypeError("WAV sink is closed");
    if (this.sampleRate !== null && audio.sampleRate !== this.sampleRate) {
      throw new TypeError(`chunks disagree on sample rate: ${this.sampleRate}, ${audio.sampleRate}`);
    }
    if (this.handle === null) {
      this.handle = await open(this.path, "w");
      this.sampleRate = audio.sampleRate;
      await writeAll(this.handle, wavHeader(audio.sampleRate, 0), 0);
    }
    // Validate the final RIFF length before appending bytes to the file.
    wavHeader(audio.sampleRate, this.sampleCount + audio.samples.length);
    const pcm = encodePcm16(audio.samples);
    await writeAll(this.handle, pcm, this.offset);
    this.offset += pcm.length;
    this.sampleCount += audio.samples.length;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.handle === null || this.sampleRate === null) return;
    try {
      await writeAll(this.handle, wavHeader(this.sampleRate, this.sampleCount), 0);
    } finally {
      await this.handle.close();
      this.handle = null;
    }
  }
}

export class FfplaySink implements PcmSink {
  private readonly player: string;
  private process: { exited: Promise<number> } | null = null;
  private stdin: BunFileSink | null = null;
  private sampleRate: number | null = null;

  constructor(player = "ffplay") {
    const resolved = Bun.which(player);
    if (!resolved) throw new TypeError(`${player} not found on PATH; drop --play or install ffmpeg`);
    this.player = resolved;
  }

  async write(audio: PcmAudio): Promise<void> {
    if (this.sampleRate !== null && audio.sampleRate !== this.sampleRate) {
      throw new TypeError(`chunks disagree on sample rate: ${this.sampleRate}, ${audio.sampleRate}`);
    }
    if (this.process === null) {
      this.sampleRate = audio.sampleRate;
      const process = Bun.spawn([
        this.player, "-f", "f32le", "-ar", String(audio.sampleRate), "-ch_layout", "mono",
        "-nodisp", "-autoexit", "-loglevel", "error", "-",
      ], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
      this.process = process;
      this.stdin = process.stdin;
    }
    this.stdin?.write(new Uint8Array(
      audio.samples.buffer,
      audio.samples.byteOffset,
      audio.samples.byteLength,
    ));
  }

  async close(): Promise<void> {
    if (this.process === null) return;
    await this.stdin?.end();
    const exitCode = await this.process.exited;
    this.process = null;
    this.stdin = null;
    if (exitCode !== 0) throw new TypeError(`${this.player} exited with status ${exitCode}`);
  }
}

export class TeeSink implements PcmSink {
  private readonly sinks: PcmSink[];

  constructor(...sinks: Array<PcmSink | null | undefined>) {
    this.sinks = sinks.filter((sink): sink is PcmSink => sink !== null && sink !== undefined);
  }

  async write(audio: PcmAudio): Promise<void> {
    for (const sink of this.sinks) await sink.write(audio);
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map((sink) => sink.close()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}
