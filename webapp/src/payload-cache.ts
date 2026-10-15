// Decoded payloads (meshes, animations, rigs) kept by recent use within a byte budget. A payload asked for again
// while it is still being read is the same read: the all-rooms view asks for the same tree or wall in hundreds of
// rooms at once, and a cache of a few dozen entries read and decoded each of them about eleven times over.

/** About how many bytes a decoded payload holds: its strings (base64 planes) and binary arrays. */
export function payloadBytes(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (!value || typeof value !== 'object' || depth > 3) return 8;
  let bytes = 16;
  if (Array.isArray(value)) {
    // (a long plain array of numbers: measured by its length, not walked)
    if (value.length > 64 && typeof value[0] === 'number') return bytes + value.length * 8;
    for (const item of value) bytes += payloadBytes(item, depth + 1);
    return bytes;
  }
  for (const key in value as Record<string, unknown>) bytes += payloadBytes((value as Record<string, unknown>)[key], depth + 1);
  return bytes;
}

export class PayloadCache {
  private readonly entries = new Map<string, { value: any; bytes: number }>();
  private readonly pending = new Map<string, Promise<any>>();
  private bytes = 0;

  constructor(private readonly maxBytes: number, private readonly maxEntries: number) {}

  get size(): number { return this.entries.size; }
  get totalBytes(): number { return this.bytes; }

  async get(key: string, load: () => Promise<any>): Promise<any> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);   // (most recent last)
      return hit.value;
    }
    let read = this.pending.get(key);
    if (!read) {
      read = load().then((value) => {
        this.put(key, value);
        return value;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, read);
    }
    return read;
  }

  private put(key: string, value: any): void {
    const bytes = payloadBytes(value);
    if (bytes > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    for (const [k, entry] of this.entries) {
      if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      this.entries.delete(k);
      this.bytes -= entry.bytes;
    }
  }

  clear(): void { this.entries.clear(); this.bytes = 0; }
}
