import { readFileSync } from "node:fs";

// 每个进程启动时固定版本，不能用升级后磁盘上的版本冒充运行版本。
export const version: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export function versionStatus(running: { launcherVersion: string | null; serviceVersion: string | null }) {
  const versions = [running.launcherVersion, running.serviceVersion];
  const restartRequired = versions.some(value => value !== null && value !== version) ? true
    : versions.every(value => value !== null) ? false : null;
  return { installedVersion: version, launcherVersion: running.launcherVersion, serviceVersion: running.serviceVersion, restartRequired };
}
