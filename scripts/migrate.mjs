#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, lstatSync, copyFileSync, openSync, closeSync, fsyncSync, constants } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { argumentsFor, installRoot, readManifest, json, operationLock } from "./install-lib.mjs";
import { startupPaths, loadConfig, readEnvironment } from "../dist/configuration/files.js";
import { validateServiceEnvironment } from "../dist/configuration/environment.js";
import { LocalCustomExecutorFiles } from "../dist/executors/files.js";
import { DatabaseSync } from "../dist/infrastructure/sqlite.js";
import { acquireLauncherLock, acquireLock } from "../dist/infrastructure/lock.js";
import { checkDataDirectory, replacePrivateText } from "../dist/infrastructure/private-files.js";
import { inspectTaskStorage, markTaskStorage, taskStorageFormat } from "../dist/tasks/storage/store.js";
import { inspectCoordinatorStorage } from "../dist/integrations/coordinator/storage.js";

process.umask(0o077);
const help = `用法：agent-task migrate --check [--home 绝对目录] [--json]
      agent-task migrate --backup 新的绝对备份目录 --yes [--home 绝对目录] [--json]
      agent-task migrate --resume --yes [--home 绝对目录] [--json]
支持的数据格式：0.1.0。缺表、损坏或不受支持的数据拒绝迁移。
执行前必须停服并保持宿主断开。先取得独占锁、备份并校验，再修改；中断后显式 --resume。
--check 只读，不取得写锁，其结果不能代替执行时的独占校验。`;
const lockNames = ["launcher-lock.sqlite", "service-lock.sqlite", "setup-lock.sqlite"];
const overlap = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

function validateDirectory(directory) {
  checkDataDirectory(directory);
  const regular = path => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid()) throw new Error("数据文件须为当前用户所有的普通文件");
  };
  const config = loadConfig(join(directory, "config.json"));
  validateServiceEnvironment(config, readEnvironment(join(directory, "environment.json")));
  new LocalCustomExecutorFiles(join(directory, "custom-executors.json")).read();
  const path = join(directory, "tasks.sqlite"), coordinators = join(directory, "coordinators");
  if (!existsSync(path)) {
    if (["coordinators", "results"].some(name => existsSync(join(directory, name)) && readdirSync(join(directory, name)).length)) {
      throw new Error("业务库缺失但存在会话或结果；拒绝创建替代库");
    }
    return { format: taskStorageFormat, marked: true, empty: true };
  }
  regular(path);
  if (existsSync(coordinators)) {
    checkDataDirectory(coordinators);
    for (const name of readdirSync(coordinators)) regular(join(coordinators, name));
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const state = inspectTaskStorage(db);
    for (const row of db.prepare("SELECT id,data FROM definitions").all()) {
      if (JSON.parse(row.data).conversationId !== null && !existsSync(join(coordinators, row.id + ".sqlite"))) {
        throw new Error("已绑定的协调会话文件缺失；拒绝创建替代会话");
      }
    }
    if (existsSync(coordinators)) {
      for (const name of readdirSync(coordinators)) {
        if (/^[a-f0-9-]{36}\.sqlite$/.test(name)) inspectCoordinatorStorage(join(coordinators, name));
        else if (!/^[a-f0-9-]{36}\.sqlite-(wal|shm)$/.test(name)) throw new Error("协调存储包含未知条目；拒绝猜测转换");
      }
    }
    return { ...state, empty: false };
  } finally { db.close(); }
}

function copyDirectory(source, destination, home, dataDir) {
  mkdirSync(destination, { mode: 0o700 });
  for (const name of readdirSync(source)) {
    // OS 锁身份不是历史数据，不将持锁中的 SQLite 锁文件当成可恢复数据。
    if ([home, dataDir].includes(source) && lockNames.some(lock => name === lock || name.startsWith(lock + "-"))) continue;
    const from = join(source, name), to = join(destination, name), stat = lstatSync(from);
    if (stat.uid !== process.getuid() || stat.isSymbolicLink()) throw new Error("备份源含非当前用户所有的条目或符号链接；未修改业务数据");
    if (stat.isDirectory()) copyDirectory(from, to, home, dataDir);
    else if (stat.isFile()) {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      const fd = openSync(to, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } else throw new Error("备份源含特殊文件；未修改业务数据");
  }
  const fd = openSync(destination, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

let releaseLauncher, releaseSetup, releaseData;
try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) { console.log(help); process.exit(0); }
  if (Object.keys(options).some(key => !["home", "check", "json", "backup", "yes", "resume"].includes(key))) throw new Error(help);
  if (options.check && (options.yes || options.backup || options.resume)) throw new Error("--check 不接受写入或续接选项");
  if (options.resume && options.backup) throw new Error("--resume 使用已记录备份，不接受另一份 --backup");
  const home = installRoot(options), manifest = readManifest(home, true);
  if (manifest.phase !== "ready") throw new Error("请先核查并完成初始化，不能用数据迁移修复 setup");
  const paths = startupPaths(home), dataDir = paths.dataDir, progressPath = join(home, "migration.json");
  const progress = existsSync(progressPath) ? json(progressPath) : null;
  if (progress !== null && (!progress || !["backed-up", "completed"].includes(progress.phase) ||
    typeof progress.target !== "string" || typeof progress.sourceMarked !== "boolean" ||
    typeof progress.backup !== "string" || typeof progress.dataDir !== "string")) throw new Error("迁移记录无效；请保留记录和备份，不能猜测续接");
  const state = validateDirectory(dataDir);
  const output = value => console.log(JSON.stringify(value, null, options.json ? undefined : 2));
  if (options.check) {
    output({ ...state, target: taskStorageFormat, migrationRequired: !state.marked, resumeRequired: progress?.phase === "backed-up" });
  } else {
    if (!options.yes) throw new Error("迁移写入需要先停服，并通过 --yes 明确批准；先运行 migrate --check");
    if (progress?.phase === "backed-up" && !options.resume) throw new Error("上次迁移未完成；请核查备份后显式 --resume，不重新开始");
    if (!options.resume && state.marked) { output({ status: "current", ...state }); process.exit(0); }
    if (options.resume && (!progress || progress.phase !== "backed-up" || progress.target !== taskStorageFormat || progress.dataDir !== dataDir || typeof progress.sourceMarked !== "boolean")) {
      throw new Error("没有匹配的待续接迁移；未修改数据");
    }
    const backup = options.resume ? progress.backup : options.backup;
    if (typeof backup !== "string" || !isAbsolute(backup) || overlap(backup, home) || overlap(backup, dataDir)) throw new Error("备份须为安装目录和数据目录之外的新绝对目录");
    checkDataDirectory(backup);
    releaseLauncher = await acquireLauncherLock(home);
    releaseSetup = operationLock(home);
    releaseData = await acquireLock(dataDir);
    const lockedProgress = existsSync(progressPath) ? json(progressPath) : null;
    if (JSON.stringify(lockedProgress) !== JSON.stringify(progress)) throw new Error("迁移记录已变化；请重新检查，不沿用旧的执行意图");
    if (startupPaths(home).dataDir !== dataDir || loadConfig(paths.configPath).dataDir !== dataDir) throw new Error("数据目录定位已变化或存在待生效切换；先核查目录，不猜测迁移目标");
    const current = validateDirectory(dataDir);
    if (current.empty) throw new Error("待迁移业务库缺失；拒绝创建替代库");
    const nested = dataDir.startsWith(home + "/"), backupData = nested ? join(backup, "home", relative(home, dataDir)) : join(backup, "data");
    const record = { target: taskStorageFormat, sourceMarked: options.resume ? progress.sourceMarked : current.marked, backup, dataDir, phase: "backed-up" };
    const receipt = { project: "agent-task", home, dataDir, target: taskStorageFormat, sourceMarked: record.sourceMarked };
    if (options.resume) {
      const saved = json(join(backup, "backup.json"));
      if (Object.keys(receipt).some(key => saved[key] !== receipt[key])) throw new Error("备份记录不匹配；拒绝续接");
    } else {
      mkdirSync(backup, { mode: 0o700 }); // 不复用或覆盖任何已有备份目录。
      copyDirectory(home, join(backup, "home"), home, dataDir);
      if (!nested) copyDirectory(dataDir, backupData, home, dataDir);
    }
    const backedUp = validateDirectory(backupData);
    if (backedUp.format !== taskStorageFormat || backedUp.marked !== record.sourceMarked) throw new Error("备份格式校验失败；未修改业务数据");
    if (!options.resume) {
      replacePrivateText(join(backup, "backup.json"), JSON.stringify(receipt) + "\n", true);
      // 只有完整备份通过校验后才记录可续接阶段；此前失败仅留下独立备份目录。
      replacePrivateText(progressPath, JSON.stringify(record) + "\n", true);
    }
    const db = new DatabaseSync(join(dataDir, "tasks.sqlite"));
    try { markTaskStorage(db); } finally { db.close(); }
    validateDirectory(dataDir);
    replacePrivateText(progressPath, JSON.stringify({ ...record, phase: "completed" }) + "\n");
    output({ status: "completed", format: taskStorageFormat, backup, restartRequired: true });
  }
} catch (error) {
  const message = error.name === "ZodError" ? "配置或记录不符合当前契约；未猜测转换" : error.message;
  console.error(process.argv.includes("--json") ? JSON.stringify({ error: message }) : message);
  process.exitCode = 1;
} finally {
  await releaseData?.();
  releaseSetup?.();
  releaseLauncher?.();
}
