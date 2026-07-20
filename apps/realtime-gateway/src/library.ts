import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
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
 */
export class CaptureLibrary {
  readonly dir: string;
  private readonly capturesDir: string;
  private readonly db: Database;

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
  }

  /** Persist one utterance. The empty-transcript failures are kept too — they are the set's most valuable samples. */
  async ingest(wav: Uint8Array, transcript: string, sessionId: string): Promise<CaptureRecord> {
    const id = crypto.randomUUID();
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
    await Bun.write(this.audioPath(id), wav);
    await Bun.write(join(this.capturesDir, `${id}.txt`), `${transcript}\n`);
    this.db.run(
      "INSERT INTO captures (id, created_at, session_id, transcript, corrected, duration_ms, sample_rate, promoted_voice_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [record.id, record.created_at, record.session_id, record.transcript, null, record.duration_ms, record.sample_rate, null],
    );
    return record;
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
    if (!this.get(id)) return undefined;
    const value = corrected === null || corrected.trim() === "" ? null : corrected.trim();
    this.db.run("UPDATE captures SET corrected = ? WHERE id = ?", [value, id]);
    // The .ref.txt sidecar mirrors the correction so compare_asr.py scores it directly.
    const refPath = join(this.capturesDir, `${id}.ref.txt`);
    if (value === null) await Bun.file(refPath).delete().catch(() => {});
    else await Bun.write(refPath, `${value}\n`);
    return this.get(id);
  }

  markPromoted(id: string, voiceId: string): CaptureRecord | undefined {
    this.db.run("UPDATE captures SET promoted_voice_id = ? WHERE id = ?", [voiceId, id]);
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const existing = this.get(id);
    if (!existing) return false;
    this.db.run("DELETE FROM captures WHERE id = ?", [id]);
    for (const suffix of [".wav", ".txt", ".ref.txt"]) {
      await Bun.file(join(this.capturesDir, `${id}${suffix}`)).delete().catch(() => {});
    }
    return true;
  }

  close(): void {
    this.db.close();
  }
}
