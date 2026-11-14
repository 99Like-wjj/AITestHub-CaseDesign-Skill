/** Host owns authentication, transport, confirmation, cancellation and network policy. */
export interface ToolPort {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Private scoped storage. Lock and atomic write guarantees are part of the adapter contract. */
export interface ResultPort {
  read(raw: unknown): unknown;
  assertSafe(value: unknown): void;
}

export interface WorkspacePort {
  readText(key: string): Promise<string | null>;
  writeTextAtomic(key: string, text: string): Promise<void>;
  withExclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export class CaseDesignError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CaseDesignError';
  }
}
