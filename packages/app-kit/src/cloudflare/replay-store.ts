import { advance, type EventMeta, type ReplayStore, type StreamPosition } from "../cable/socket.js";

const SEEN_FOR_SECONDS = 24 * 60 * 60;

/**
 * A Durable Object's replay positions and taken events, in its SQLite storage. An event's key
 * and position are written in one transaction before its handlers run, so an object reset
 * mid-event never runs it again on replay.
 */
export class DurableReplayStore implements ReplayStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sabha_positions (stream TEXT PRIMARY KEY, epoch TEXT NOT NULL, "offset" INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sabha_seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sabha_state (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
  }

  async load(): Promise<{ positions: Record<string, StreamPosition>; connectedAt?: number }> {
    const positions: Record<string, StreamPosition> = {};
    for (const row of this.storage.sql.exec<{ stream: string; epoch: string; offset: number }>(`SELECT stream, epoch, "offset" FROM sabha_positions`)) {
      positions[row.stream] = { epoch: row.epoch, offset: row.offset };
    }
    const connected = this.storage.sql.exec<{ value: number }>(`SELECT value FROM sabha_state WHERE name = 'connected_at'`).toArray()[0];
    return { positions, ...(connected ? { connectedAt: connected.value } : {}) };
  }

  async begin(key: string | undefined, meta: EventMeta): Promise<boolean> {
    return this.storage.transactionSync(() => {
      const known = this.storage.sql.exec<{ epoch: string; offset: number }>(`SELECT epoch, "offset" FROM sabha_positions WHERE stream = ?`, meta.streamId ?? "").toArray()[0];
      const positions: Record<string, StreamPosition> = known && meta.streamId ? { [meta.streamId]: known } : {};
      if (advance(positions, meta) && meta.streamId) {
        const next = positions[meta.streamId]!;
        this.storage.sql.exec(`INSERT OR REPLACE INTO sabha_positions (stream, epoch, "offset") VALUES (?, ?, ?)`, meta.streamId, next.epoch, next.offset);
      }
      if (key === undefined) return true;
      if (this.storage.sql.exec(`SELECT 1 FROM sabha_seen WHERE key = ?`, key).toArray().length > 0) return false;
      const now = Math.floor(Date.now() / 1000);
      this.storage.sql.exec(`INSERT INTO sabha_seen (key, at) VALUES (?, ?)`, key, now);
      this.storage.sql.exec(`DELETE FROM sabha_seen WHERE at < ?`, now - SEEN_FOR_SECONDS);
      return true;
    });
  }

  async connected(at: number): Promise<void> {
    this.storage.sql.exec(`INSERT OR REPLACE INTO sabha_state (name, value) VALUES ('connected_at', ?)`, at);
  }

  async forget(): Promise<void> {
    this.storage.sql.exec(`DELETE FROM sabha_positions`);
  }
}
