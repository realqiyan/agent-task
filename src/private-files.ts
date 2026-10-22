import { existsSync, constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { dirname, basename, join, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export function checkDataDirectory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Expected a canonical absolute dataDir");
  let parent = path;
  while (!existsSync(parent)) parent = dirname(parent);
  if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory()) throw new Error("dataDir must not traverse symlinks");
  if (parent === path) {
    const stat = lstatSync(path);
    if (stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new Error("dataDir must be owned and private");
  }
}

function privateDirectory(path: string): void {
  const directory = dirname(path), stat = lstatSync(directory);
  if (realpathSync(directory) !== directory || !stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) {
    throw new Error("Expected a canonical, private, owned configuration directory");
  }
}
function ownedFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid!()) throw new Error("Expected an owned regular configuration file");
}
export function readPrivateText(path: string): string {
  privateDirectory(path); ownedFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) || stat.size > 1_048_576) {
      throw new Error("Expected a private, owned configuration file of at most 1 MiB");
    }
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > 1_048_576) throw new Error("Configuration file grew beyond limit");
    return text;
  } finally { closeSync(fd); }
}
export class FileCommitError extends Error {
  constructor(readonly uncertain: boolean) {
    super(uncertain ? "Configuration publication could not be confirmed; stop and inspect the files" : "Configuration was not published");
  }
}
/** Caller owns the configuration. No await between comparison, validation and publication. */
export function replacePrivateText(path: string, text: string): void {
  const temporary = join(dirname(path), "." + basename(path) + "." + randomUUID() + ".tmp");
  let fd: number | undefined, created = false, published = false;
  try {
    privateDirectory(path); ownedFile(path);
    if (Buffer.byteLength(text) > 1_048_576) throw new Error("Configuration exceeds file limit");
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    writeFileSync(fd, text, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    privateDirectory(path); ownedFile(path);
    renameSync(temporary, path); published = true;
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { throw new FileCommitError(published); }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (created && !published) { try { unlinkSync(temporary); } catch { /* Never remove the committed file. */ } }
  }
}
