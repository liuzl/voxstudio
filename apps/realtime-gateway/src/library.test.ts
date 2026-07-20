import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeWav } from "@voxstudio/audio";
import { CaptureLibrary, parseByteSize, type CaptureLibraryOptions } from "./library";

const dirs: string[] = [];

function tempLibrary(options?: CaptureLibraryOptions): CaptureLibrary {
  const dir = `${import.meta.dir}/../node_modules/.test-library-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  dirs.push(dir);
  return new CaptureLibrary(dir, options);
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

describe("parseByteSize", () => {
  test("accepts plain bytes and binary K/M/G suffixes, with or without a trailing B", () => {
    expect(parseByteSize("32044", "quota")).toBe(32_044);
    expect(parseByteSize("64k", "quota")).toBe(64 * 1024);
    expect(parseByteSize("512M", "quota")).toBe(512 * 1024 * 1024);
    expect(parseByteSize("2GB", "quota")).toBe(2 * 1024 ** 3);
    expect(parseByteSize(" 100 KB ", "quota")).toBe(100 * 1024);
  });

  test("a typo fails closed instead of running unbounded", () => {
    for (const bad of ["", "0", "-1", "1.5M", "512X", "lots", "M", "1e6"]) {
      expect(() => parseByteSize(bad, "quota")).toThrow("positive byte size");
    }
  });
});

describe("retention quota", () => {
  const wavBytes = wav().byteLength;

  test("over quota, the oldest unpinned capture is evicted; corrected and promoted are pinned", async () => {
    const evictions: string[] = [];
    // Room for two captures.
    const library = tempLibrary({ maxBytes: wavBytes * 2, log: line => evictions.push(line) });
    const oldest = await library.ingest(wav(), "最旧", "session-a");
    const middle = await library.ingest(wav(), "中间", "session-a");
    const newest = await library.ingest(wav(), "最新", "session-a");

    // Plain FIFO first: the oldest goes, its files with it.
    expect(library.get(oldest.id)).toBeUndefined();
    expect(await Bun.file(library.audioPath(oldest.id)).exists()).toBe(false);
    expect(evictions.join("\n")).toContain(oldest.id);

    // Pin the survivor by correcting it: the next ingest must step over it and
    // evict the younger unpinned capture instead.
    await library.correct(middle.id, "中间（校正）");
    const fourth = await library.ingest(wav(), "第四", "session-a");
    expect(library.get(middle.id)?.corrected).toBe("中间（校正）");
    expect(library.get(newest.id)).toBeUndefined();
    expect(library.get(fourth.id)).toBeDefined();

    const page = library.list();
    expect(page.total).toBe(2);
    expect(page.bytes).toBe(wavBytes * 2);
    expect(page.max_bytes).toBe(wavBytes * 2);
    await library.close();
  });

  test("once pinned captures alone fill the quota, ingest is refused — curated work is never deleted", async () => {
    const library = tempLibrary({ maxBytes: wavBytes + Math.floor(wavBytes / 2) });
    const pinned = await library.ingest(wav(), "钉住", "session-a");
    await library.correct(pinned.id, "钉住（校正）");

    await expect(library.ingest(wav(), "挤不下", "session-a")).rejects.toThrow("retention quota");
    // The refusal left no debris behind.
    expect(library.list().total).toBe(1);
    expect(library.get(pinned.id)?.corrected).toBe("钉住（校正）");
    await library.close();
  });

  test("a lowered quota is enforced on open, still sparing pinned captures", async () => {
    const unbounded = tempLibrary();
    const corrected = await unbounded.ingest(wav(), "留下", "session-a");
    await unbounded.correct(corrected.id, "留下（校正）");
    const raw1 = await unbounded.ingest(wav(), "生料一", "session-a");
    const raw2 = await unbounded.ingest(wav(), "生料二", "session-a");
    await unbounded.close();

    const lines: string[] = [];
    const reopened = new CaptureLibrary(unbounded.dir, { maxBytes: wavBytes * 2, log: line => lines.push(line) });
    expect(reopened.get(corrected.id)).toBeDefined();
    // Oldest unpinned goes; the younger raw capture fits.
    expect(reopened.get(raw1.id)).toBeUndefined();
    expect(reopened.get(raw2.id)).toBeDefined();
    await reopened.close();

    // Quota below what pinned work alone holds: nothing curated is deleted, the
    // operator is told out loud.
    const squeezed = new CaptureLibrary(unbounded.dir, { maxBytes: Math.floor(wavBytes / 2), log: line => lines.push(line) });
    expect(squeezed.get(corrected.id)).toBeDefined();
    expect(squeezed.get(raw2.id)).toBeUndefined();
    expect(lines.join("\n")).toContain("never auto-deleted");
    await squeezed.close();
  });

  test("a pre-quota database gains the bytes column and backfills it from the files", async () => {
    const library = tempLibrary();
    const record = await library.ingest(wav(), "老库", "session-a");
    await library.close();

    // Rewind the schema to the pre-quota shape.
    const db = new Database(`${library.dir}/library.db`);
    db.run("ALTER TABLE captures DROP COLUMN bytes");
    db.close();

    const reopened = new CaptureLibrary(library.dir);
    expect(reopened.get(record.id)?.bytes).toBe(wavBytes);
    expect(reopened.list().bytes).toBe(wavBytes);
    await reopened.close();
  });

  test("a candidate pinned mid-eviction is spared and the newcomer is rolled back — the bound holds", async () => {
    const library = tempLibrary({ maxBytes: wavBytes });
    const victim = await library.ingest(wav(), "候选", "session-a");

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // The promote shape: a long engine round-trip, then the row is marked.
    const promoting = library.runExclusive(victim.id, async () => {
      await gate;
      return library.markPromoted(victim.id, "laok-3");
    });
    // Pushes the total over quota; the only candidate is mid-promotion.
    const ingesting = library.ingest(wav(), "新料", "session-a");
    // Deterministic barrier: the row insert is the last step of the ingest's own
    // lock, and from there the eviction enqueues within microtasks — once the row
    // is visible, one drained tick means the eviction is queued behind the promote.
    while (library.list().total < 2) await Bun.sleep(1);
    await Bun.sleep(0);
    release();

    const promoted = await promoting;
    // The eviction waited its turn, re-checked, and stepped back: a promoted
    // capture is pinned even when the pin landed while the eviction was queued.
    // With the only candidate spared, the newcomer cannot fit — it is rolled
    // back and refused, exactly what admission would have chosen against the
    // new pinned set. The advertised bound survives the race.
    await expect(ingesting).rejects.toThrow("retention quota");
    expect(promoted?.promoted_voice_id).toBe("laok-3");
    expect(library.get(victim.id)?.promoted_voice_id).toBe("laok-3");
    expect(await Bun.file(library.audioPath(victim.id)).exists()).toBe(true);

    const page = library.list();
    expect(page.total).toBe(1);
    expect(page.bytes).toBeLessThanOrEqual(page.max_bytes as number);
    // The rollback left no orphan files for the next open to sweep.
    expect(new Set((await Array.fromAsync(new Bun.Glob("*.wav").scan({ cwd: `${library.dir}/captures` })))))
      .toEqual(new Set([`${victim.id}.wav`]));
    await library.close();
  });

  test("a nullable bytes column left by a foreign migration is backfilled and counted", async () => {
    const library = tempLibrary();
    const record = await library.ingest(wav(), "外来迁移", "session-a");
    await library.close();

    // A bytes column added nullable (not our DEFAULT-0 shape): rows sit at NULL,
    // which SUM() would silently ignore.
    const db = new Database(`${library.dir}/library.db`);
    db.run("ALTER TABLE captures DROP COLUMN bytes");
    db.run("ALTER TABLE captures ADD COLUMN bytes INTEGER");
    db.close();

    const reopened = new CaptureLibrary(library.dir);
    expect(reopened.get(record.id)?.bytes).toBe(wavBytes);
    expect(reopened.list().bytes).toBe(wavBytes);
    await reopened.close();
  });
});
