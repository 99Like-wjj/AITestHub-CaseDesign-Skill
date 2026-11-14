import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaseDesignError, type WorkspacePort } from './ports.js';

/** No networking or shell. The host must select a private, non-repository root. */
export class LocalWorkspacePort implements WorkspacePort {
  private constructor(readonly root: string) {}
  static async create(root: string): Promise<LocalWorkspacePort> {
    if (!isAbsolute(root))
      throw new CaseDesignError(
        'UNSAFE_STORE_ROOT',
        '运行目录必须为明确的绝对路径。',
      );
    const absolute = resolve(root);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    // Reject links on every existing path segment, not only the leaf.
    let cursor = absolute;
    while (dirname(cursor) !== cursor) {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new CaseDesignError(
          'UNSAFE_STORE_ROOT',
          '运行目录不能经过符号链接。',
        );
      cursor = dirname(cursor);
    }
    if (
      resolve(await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()
    )
      throw new CaseDesignError(
        'UNSAFE_STORE_ROOT',
        '运行目录真实路径不一致。',
      );
    return new LocalWorkspacePort(absolute);
  }
  private async path(key: string): Promise<string> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}\.json$/.test(key) ||
      key.includes('..') ||
      basename(key) !== key
    )
      throw new CaseDesignError(
        'UNSAFE_STORE_KEY',
        '只允许受控相对JSON文件名。',
      );
    const path = join(this.root, key);
    if (
      relative(this.root, path).startsWith('..') ||
      isAbsolute(relative(this.root, path))
    )
      throw new CaseDesignError('UNSAFE_STORE_KEY', '文件越过运行目录。');
    if (
      (await lstat(this.root)).isSymbolicLink() ||
      resolve(await realpath(this.root)).toLowerCase() !==
        this.root.toLowerCase()
    )
      throw new CaseDesignError('UNSAFE_STORE_ROOT', '运行目录发生替换。');
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new CaseDesignError(
          'UNSAFE_STORE_FILE',
          '拒绝链接或非普通文件。',
        );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    return path;
  }
  async readText(key: string): Promise<string | null> {
    const path = await this.path(key);
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    }
  }
  async writeTextAtomic(key: string, text: string): Promise<void> {
    const path = await this.path(key),
      temporary = join(this.root, `${key}.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.path(key);
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  async withExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const path = await this.path(key),
      lock = `${path}.lock`;
    let handle;
    try {
      handle = await open(lock, 'wx', 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
        throw new CaseDesignError(
          'STORE_BUSY',
          '账本正被使用或遗留未核实的锁；禁止抢锁重发。',
        );
      throw error;
    }
    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      await handle.sync();
      return await work();
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }
}
