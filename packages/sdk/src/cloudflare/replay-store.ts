import { advance, type EventMeta, type ReplayStore, type StreamPosition } from "../cable/socket.js";

/** Long past Sabha's 5-minute history, so a replay can't bring back a key already forgotten. */
const SEEN_FOR_SECONDS = 60 * 60;
const PRUNE_EVERY_MS = 60_000;

/**
 * A Durable Object's replay positions and taken events, in its SQLite storage. An event's key
 * and position are written in one transaction before its handlers run, so an object reset
 * mid-event never runs it again on replay.
 */
export class DurableReplayStore implements ReplayStore {
  private prunedAt = 0;

  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sabha_positions (stream TEXT PRIMARY KEY, epoch TEXT NOT NULL, "offset" INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sabha_seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sabha_seen_at ON sabha_seen (at);
      CREATE TABLE IF NOT EXISTS sabha_state (name TEXT PRIMARY KEY, value);
    `);
  }

  async load(): Promise<{ positions: Record<string, StreamPosition>; aliveAt?: number }> {
    const positions: Record<string, StreamPosition> = {};
    for (const row of this.storage.sql.exec<{ stream: string; epoch: string; offset: number }>(`SELECT stream, epoch, "offset" FROM sabha_positions`)) {
      positions[row.stream] = { epoch: row.epoch, offset: row.offset };
    }
    const alive = this.state("alive_at");
    return { positions, ...(typeof alive === "number" ? { aliveAt: alive } : {}) };
  }

  async begin(key: string | undefined, meta: EventMeta): Promise<boolean> {
    const now = Date.now();
    if (now - this.prunedAt >= PRUNE_EVERY_MS) {
      this.prunedAt = now;
      this.storage.sql.exec(`DELETE FROM sabha_seen WHERE at < ?`, Math.floor(now / 1000) - SEEN_FOR_SECONDS);
    }
    return this.storage.transactionSync(() => {
      const known = this.storage.sql.exec<{ epoch: string; offset: number }>(`SELECT epoch, "offset" FROM sabha_positions WHERE stream = ?`, meta.streamId ?? "").toArray()[0];
      const positions: Record<string, StreamPosition> = known && meta.streamId ? { [meta.streamId]: known } : {};
      if (advance(positions, meta) && meta.streamId) {
        const next = positions[meta.streamId]!;
        this.storage.sql.exec(`INSERT OR REPLACE INTO sabha_positions (stream, epoch, "offset") VALUES (?, ?, ?)`, meta.streamId, next.epoch, next.offset);
      }
      if (key === undefined) return true;
      if (this.storage.sql.exec(`SELECT 1 FROM sabha_seen WHERE key = ?`, key).toArray().length > 0) return false;
      this.storage.sql.exec(`INSERT INTO sabha_seen (key, at) VALUES (?, ?)`, key, Math.floor(now / 1000));
      return true;
    });
  }

  async alive(at: number): Promise<void> {
    this.setState("alive_at", at);
  }

  async forget(): Promise<void> {
    this.storage.sql.exec(`DELETE FROM sabha_positions`);
  }

  /** A fingerprint of the key Sabha last refused, if any. */
  refusedKey(): string | undefined {
    const value = this.state("refused_key");
    return typeof value === "string" ? value : undefined;
  }

  setRefusedKey(fingerprint: string | undefined): void {
    if (fingerprint === undefined) this.storage.sql.exec(`DELETE FROM sabha_state WHERE name = 'refused_key'`);
    else this.setState("refused_key", fingerprint);
  }

  private state(name: string): string | number | null | undefined {
    return this.storage.sql.exec<{ value: string | number | null }>(`SELECT value FROM sabha_state WHERE name = ?`, name).toArray()[0]?.value;
  }

  private setState(name: string, value: string | number): void {
    this.storage.sql.exec(`INSERT OR REPLACE INTO sabha_state (name, value) VALUES (?, ?)`, name, value);
  }
}
