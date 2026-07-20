import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readWav } from "@voxstudio/audio";

/**
 * One capture: a finalized user utterance and what ASR heard (docs/web-studio.md, the
 * 素材库 panel). `transcript` is the RAW ASR text and is never rewritten — the utterance
 * set exists to measure ASR; `corrected` carries the human reference next to it.
 */
export interface CaptureRecord {
  id: string;
  created_at: number;
  session_id: string;
  transcript: string;
  corrected: string | null;
  duration_ms: number;
  sample_rate: number;
  promoted_voice_id: string | null;
}

/**
 * The gateway-side capture store: metadata in SQLite (`library.db`), audio as plain WAV
 * files next to it (`captures/<id>.wav`) with the sidecars the ASR reference workflow
 * already consumes — `<id>.txt` holds what the engine heard (the --save-utterances
 * convention) and an inline correction writes `<id>.ref.txt`, which is exactly what
 * `tools/compare_asr.py` scores CER against. No export step. Existence of this object
 * IS the retention opt-in: nothing is captured unless the deployment passed a library
 * directory.
 *
 * Mutations on one capture are serialized (`runExclusive`) — a delete can no longer
 * interleave a promote's engine round-trip or a correction's sidecar write — and
 * `close()` drains in-flight work before closing the database (adversarial review
 * 2026-07-20).
 */
export class CaptureLibrary {
  readonly dir: string;
  private readonly capturesDir: string;
  private readonly db: Database;
  private closed = false;
  /** Per-capture mutation queues: the stored promise is the current tail. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Every queued operation, so close() can drain before the database goes away. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(dir: string) {
    this.dir = dir;
    this.capturesDir = join(dir, "captures");
    mkdirSync(this.capturesDir, { recursive: true });
    this.db = new Database(join(dir, "library.db"), { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS captures (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      transcript TEXT NOT NULL,
      corrected TEXT,
      duration_ms INTEGER NOT NULL,
      sample_rate INTEGER NOT NULL,
      promoted_voice_id TEXT
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS captures_created ON captures (created_at DESC)");
    this.reconcile();
  }

  /**
   * Ingest and delete are not atomic across SQLite and the filesystem, so a crash can
   * strand either half. On open: a row whose audio is gone cannot be played, corrected,
   * or promoted — drop it; then sweep files (including interrupted `.tmp` writes) that
   * no surviving row owns, so stray sidecars never contaminate the reference set.
   */
  private reconcile(): void {
    for (const row of this.db.query<{ id: string }, []>("SELECT id FROM captures").all()) {
      if (!existsSync(this.audioPath(row.id))) this.db.run("DELETE FROM captures WHERE id = ?", [row.id]);
    }
    const known = new Set(this.db.query<{ id: string }, []>("SELECT id FROM captures").all().map(row => row.id));
    for (const name of readdirSync(this.capturesDir)) {
      const owner = /^(.+?)\.(wav|txt|ref\.txt)$/.exec(name)?.[1];
      if (name.endsWith(".tmp") || (owner !== undefined && !known.has(owner))) {
        rmSync(join(this.capturesDir, name), { force: true });
      }
    }
  }

  /**
   * Queue `work` behind every earlier mutation of the same capture. Callers composing
   * multi-step flows (the promote route: validate → engine round-trip → mark) run the
   * whole flow inside one call; the plain accessors below must not re-enter it for the
   * same id. Rejects once the library is closed.
   */
  async runExclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    // Admission is the cutoff: work accepted before close() drains to completion; work
    // arriving after is refused — checking at execution time instead would throw away
    // exactly the queued operations the drain exists to finish.
    if (this.closed) throw new Error("the capture library is closed");
    const previous = this.tails.get(id) ?? Promise.resolve();
    const run = previous.then(() => work());
    const tail = run.then(() => undefined, () => undefined);
    this.tails.set(id, tail);
    this.inflight.add(tail);
    void tail.then(() => {
      this.inflight.delete(tail);
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return run;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Persist one utterance. The empty-transcript failures are kept too — they are the set's most valuable samples. */
  async ingest(wav: Uint8Array, transcript: string, sessionId: string): Promise<CaptureRecord> {
    const id = crypto.randomUUID();
    return this.runExclusive(id, async () => {
      const audio = readWav(wav);
      const record: CaptureRecord = {
        id,
        created_at: Date.now(),
        session_id: sessionId,
        transcript,
        corrected: null,
        duration_ms: Math.round(audio.samples.length * 1_000 / audio.sampleRate),
        sample_rate: audio.sampleRate,
        promoted_voice_id: null,
      };
      const wavPath = this.audioPath(id);
      const txtPath = join(this.capturesDir, `${id}.txt`);
      try {
        // Files first through tmp names, the row last: the insert is the commit point,
        // and a crash on either side leaves only debris reconcile() sweeps on open.
        await Bun.write(`${wavPath}.tmp`, wav);
        await Bun.write(`${txtPath}.tmp`, `${transcript}\n`);
        renameSync(`${wavPath}.tmp`, wavPath);
        renameSync(`${txtPath}.tmp`, txtPath);
        this.db.run(
          "INSERT INTO captures (id, created_at, session_id, transcript, corrected, duration_ms, sample_rate, promoted_voice_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [record.id, record.created_at, record.session_id, record.transcript, null, record.duration_ms, record.sample_rate, null],
        );
      } catch (error) {
        for (const path of [`${wavPath}.tmp`, `${txtPath}.tmp`, wavPath, txtPath]) rmSync(path, { force: true });
        throw error;
      }
      return record;
    });
  }

  list(limit = 50, offset = 0): { captures: CaptureRecord[]; total: number } {
    const captures = this.db
      // rowid breaks same-millisecond ties by insertion order; a UUID tiebreaker shuffles.
      .query<CaptureRecord, [number, number]>("SELECT * FROM captures ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(limit, offset);
    const row = this.db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM captures").get();
    return { captures, total: row?.total ?? 0 };
  }

  get(id: string): CaptureRecord | undefined {
    return this.db.query<CaptureRecord, [string]>("SELECT * FROM captures WHERE id = ?").get(id) ?? undefined;
  }

  /** Only meaningful for an id that `get` confirmed; ids are gateway-minted UUIDs. */
  audioPath(id: string): string {
    return join(this.capturesDir, `${id}.wav`);
  }

  /** Set (or with null/blank, clear) the human reference transcript. */
  async correct(id: string, corrected: string | null): Promise<CaptureRecord | undefined> {
    return this.runExclusive(id, async () => {
      // Re-checked under the lock: a delete that won the queue must not be resurrected
      // as a stray .ref.txt.
      if (!this.get(id)) return undefined;
      const value = corrected === null || corrected.trim() === "" ? null : corrected.trim();
      this.db.run("UPDATE captures SET corrected = ? WHERE id = ?", [value, id]);
      // The .ref.txt sidecar mirrors the correction so compare_asr.py scores it directly.
      const refPath = join(this.capturesDir, `${id}.ref.txt`);
      if (value === null) await Bun.file(refPath).delete().catch(() => {});
      else await Bun.write(refPath, `${value}\n`);
      return this.get(id);
    });
  }

  /** Plain write for callers already inside `runExclusive` (the promote flow). */
  markPromoted(id: string, voiceId: string): CaptureRecord | undefined {
    this.db.run("UPDATE captures SET promoted_voice_id = ? WHERE id = ?", [voiceId, id]);
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    return this.runExclusive(id, async () => {
      if (!this.get(id)) return false;
      this.db.run("DELETE FROM captures WHERE id = ?", [id]);
      for (const suffix of [".wav", ".txt", ".ref.txt"]) {
        await Bun.file(join(this.capturesDir, `${id}${suffix}`)).delete().catch(() => {});
      }
      return true;
    });
  }

  /** Refuse new work, drain what is already queued, then close the database. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.inflight]);
    this.db.close();
  }
}
