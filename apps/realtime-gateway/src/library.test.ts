import { afterEach, describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { CaptureLibrary } from "./library";

const dirs: string[] = [];

function tempLibrary(): CaptureLibrary {
  const dir = `${import.meta.dir}/../node_modules/.test-library-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  dirs.push(dir);
  return new CaptureLibrary(dir);
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  }
});

/** One second of quiet 16kHz audio — the shape a gateway utterance arrives in. */
const wav = (): Uint8Array => new Uint8Array(writeWav(new Float32Array(16_000).fill(0.05), 16_000));

describe("capture library", () => {
  test("ingest persists audio, sidecar, and metadata; list returns newest first", async () => {
    const library = tempLibrary();
    const first = await library.ingest(wav(), "你好", "session-a");
    const second = await library.ingest(wav(), "", "session-a");

    expect(first.duration_ms).toBe(1_000);
    expect(first.sample_rate).toBe(16_000);
    expect(first.corrected).toBeNull();
    // The empty-transcript failure is kept — it is the most valuable sample.
    expect(second.transcript).toBe("");

    const { captures, total } = library.list();
    expect(total).toBe(2);
    expect(captures.map(capture => capture.id)).toEqual([second.id, first.id]);
    expect(await Bun.file(library.audioPath(first.id)).exists()).toBe(true);
    expect((await Bun.file(library.audioPath(first.id).replace(/\.wav$/, ".txt")).text()).trim()).toBe("你好");
    await library.close();
  });

  test("survives a reopen: rows and audio outlive the process object", async () => {
    const library = tempLibrary();
    const record = await library.ingest(wav(), "重启前", "session-a");
    await library.close();

    const reopened = new CaptureLibrary(library.dir);
    expect(reopened.get(record.id)?.transcript).toBe("重启前");
    await reopened.close();
  });

  test("correct sets and clears the reference, mirroring the .ref.txt sidecar", async () => {
    const library = tempLibrary();
    const record = await library.ingest(wav(), "作力测试", "session-a");
    const refPath = library.audioPath(record.id).replace(/\.wav$/, ".ref.txt");

    const corrected = await library.correct(record.id, " 压力测试 ");
    expect(corrected?.corrected).toBe("压力测试");
    // The raw ASR transcript is never rewritten by a correction.
    expect(corrected?.transcript).toBe("作力测试");
    expect((await Bun.file(refPath).text()).trim()).toBe("压力测试");

    const cleared = await library.correct(record.id, "");
    expect(cleared?.corrected).toBeNull();
    expect(await Bun.file(refPath).exists()).toBe(false);

    expect(await library.correct("no-such-id", "x")).toBeUndefined();
    await library.close();
  });

  test("markPromoted records the voice id; remove deletes row and files", async () => {
    const library = tempLibrary();
    const record = await library.ingest(wav(), "升级我", "session-a");
    await library.correct(record.id, "升级我");

    expect(library.markPromoted(record.id, "laok-2")?.promoted_voice_id).toBe("laok-2");

    expect(await library.remove(record.id)).toBe(true);
    expect(library.get(record.id)).toBeUndefined();
    expect(await Bun.file(library.audioPath(record.id)).exists()).toBe(false);
    expect(await Bun.file(library.audioPath(record.id).replace(/\.wav$/, ".ref.txt")).exists()).toBe(false);
    expect(await library.remove(record.id)).toBe(false);
    await library.close();
  });

  test("concurrent correct and remove settle without resurrecting a sidecar", async () => {
    const library = tempLibrary();
    const record = await library.ingest(wav(), "竞态", "session-a");
    const refPath = library.audioPath(record.id).replace(/\.wav$/, ".ref.txt");

    // Fired together: serialization means whichever wins, the loser sees a consistent
    // row — and a delete is never followed by a stray .ref.txt write.
    const [, removed] = await Promise.all([
      library.correct(record.id, "校正稿"),
      library.remove(record.id),
    ]);
    expect(removed).toBe(true);
    expect(library.get(record.id)).toBeUndefined();
    expect(await Bun.file(refPath).exists()).toBe(false);
    expect(await Bun.file(library.audioPath(record.id)).exists()).toBe(false);
    await library.close();
  });

  test("close drains in-flight work against an open database and refuses new work", async () => {
    const library = tempLibrary();
    const record = await library.ingest(wav(), "关店前", "session-a");

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // The promote shape: a long engine round-trip followed by a database write.
    const slow = library.runExclusive(record.id, async () => {
      await gate;
      return library.markPromoted(record.id, "drained");
    });
    const closing = library.close();
    await Bun.sleep(20);
    release();
    await closing;

    expect((await slow)?.promoted_voice_id).toBe("drained");
    await expect(library.runExclusive(record.id, async () => {})).rejects.toThrow("closed");
  });

  test("a fresh open reconciles orphans: audio-less rows, unowned files, interrupted tmp writes", async () => {
    const library = tempLibrary();
    const kept = await library.ingest(wav(), "留下", "session-a");
    const doomed = await library.ingest(wav(), "audio 丢了", "session-a");
    await library.correct(doomed.id, "有 sidecar");
    await library.close();

    const capturesDir = library.audioPath("x").replace(/\/x\.wav$/, "");
    await Bun.file(library.audioPath(doomed.id)).delete();
    await Bun.write(`${capturesDir}/orphan.wav`, wav());
    await Bun.write(`${capturesDir}/${kept.id}.wav.tmp`, "interrupted");

    const reopened = new CaptureLibrary(library.dir);
    expect(reopened.get(kept.id)?.transcript).toBe("留下");
    // The row lost its audio: unplayable, unpromotable — dropped, sidecars swept.
    expect(reopened.get(doomed.id)).toBeUndefined();
    expect(await Bun.file(`${capturesDir}/${doomed.id}.ref.txt`).exists()).toBe(false);
    expect(await Bun.file(`${capturesDir}/${doomed.id}.txt`).exists()).toBe(false);
    expect(await Bun.file(`${capturesDir}/orphan.wav`).exists()).toBe(false);
    expect(await Bun.file(`${capturesDir}/${kept.id}.wav.tmp`).exists()).toBe(false);
    expect(await Bun.file(library.audioPath(kept.id)).exists()).toBe(true);
    await reopened.close();
  });
});
