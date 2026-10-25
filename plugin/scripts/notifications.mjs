import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

export const notificationType = "agent-task-notification";
export const originType = "agent-task-notification-origin";
const projectPattern = /^(git:[0-9a-f]{64}|uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** 有界、无 shell 的本机桥接；不转发子进程诊断或凭据。 */
export function runJson(command, args, { cwd, signal, input, timeout = 4000, env = process.env } = {}) {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) { reject(new Error("操作已取消")); return; }
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    let size = 0, failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", chunk => { size += chunk.length; if (size > 256 * 1024) stop(); else chunks.push(chunk); });
    child.stdin.on("error", stop);
    child.once("error", () => { failed = true; });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", stop);
      if (failed || code !== 0) reject(new Error("本机通知操作失败；未确认事件会保留"));
      else resolveResult(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

export function repositoryIdentity(remote) {
  let path;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(remote)) {
    const url = new URL(remote);
    if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol) || url.search || url.hash) throw new Error("仓库地址不受支持");
    path = decodeURIComponent(url.pathname);
  } else {
    const match = /^(?:[^@/:]+@)?[^/:]+:(.+)$/.exec(remote);
    if (!match) throw new Error("请使用远程仓库地址或显式项目配置");
    path = match[1];
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!path.includes("/") || path.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x20\\]/.test(path)) {
    throw new Error("仓库分组和名称无效");
  }
  // 仅对仓库身份字符串计算散列，不读取或校验文件哈希。
  return "git:" + createHash("sha256").update(path, "utf8").digest("hex");
}

function readProject(file) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (Object.keys(value).length !== 1 || !projectPattern.test(value.projectId)) throw new Error("项目通知配置无效");
  return value.projectId;
}

/** 只在首次提交任务时初始化。Git 默认按仓库根目录共享；显式 root 可隔离子项目。 */
export async function projectIdentity(cwd, { signal, env = process.env } = {}) {
  let root = resolve(env.AGENT_TASK_PROJECT_ROOT ?? cwd), remote;
  if (!env.AGENT_TASK_PROJECT_ROOT) {
    try { root = (await runJson("git", ["rev-parse", "--show-toplevel"], { cwd: root, signal, env })).trim(); }
    catch { if (signal?.aborted) throw new Error("操作已取消"); }
  }
  const file = join(root, ".agent-task", "project.json");
  if (existsSync(file)) return readProject(file);
  try { remote = (await runJson("git", ["remote", "get-url", "origin"], { cwd: root, signal, env })).trim(); }
  catch { if (signal?.aborted) throw new Error("操作已取消"); }
  const projectId = remote ? repositoryIdentity(remote) : "uuid:" + randomUUID();
  if (signal?.aborted) throw new Error("操作已取消");
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("项目通知目录不能是符号链接");
  const temporary = join(directory, ".project-" + randomUUID());
  writeFileSync(temporary, JSON.stringify({ projectId }) + "\n", { flag: "wx", mode: 0o600 });
  try {
    try { linkSync(temporary, file); } catch (error) { if (error.code !== "EEXIST") throw error; }
    return readProject(file);
  } finally { unlinkSync(temporary); }
}

export function serviceRequest(request, { cwd, signal, env = process.env } = {}) {
  const args = ["notifications"];
  if (env.AGENT_TASK_PREFLIGHT_HOME) args.push("--home", env.AGENT_TASK_PREFLIGHT_HOME);
  return runJson(env.AGENT_TASK_PREFLIGHT_COMMAND ?? "agent-task", args, { cwd, signal, env, input: request })
    .then(value => JSON.parse(value));
}

/** 只读取 Pi 公布的 JSONL 格式，不修改历史。内存队列和 SDK 内存条目不能作为回执。 */
export class DeliveryReceipts {
  offset = 0;
  partial = Buffer.alloc(0);
  ids = new Set();
  header = false;
  constructor(file, origin, nativeSessionId) {
    this.file = file; this.origin = origin; this.nativeSessionId = nativeSessionId;
  }
  read() {
    if (this.failed) throw new Error("Pi 会话回执读取已停止，请重新加载会话并核查文件");
    if (!this.file || !existsSync(this.file)) return this.ids;
    const size = statSync(this.file).size;
    if (size < this.offset) throw new Error("Pi 会话文件被截断，通知确认已停止");
    const fd = openSync(this.file, "r");
    try {
      while (this.offset < size) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, size - this.offset));
        const length = readSync(fd, chunk, 0, chunk.length, this.offset);
        if (!length) break;
        this.offset += length;
        this.partial = Buffer.concat([this.partial, chunk.subarray(0, length)]);
        let end;
        while ((end = this.partial.indexOf(10)) >= 0) {
          const line = this.partial.subarray(0, end).toString("utf8");
          this.partial = this.partial.subarray(end + 1);
          if (!line.trim()) continue;
          const entry = JSON.parse(line);
          if (!this.header) {
            if (entry.type !== "session" || entry.id !== this.nativeSessionId) throw new Error("Pi 会话身份不一致");
            this.header = true;
          }
          if (entry.type === "custom_message" && entry.customType === notificationType &&
            entry.details?.origin?.projectId === this.origin.projectId && entry.details?.origin?.sessionId === this.origin.sessionId) {
            for (const id of entry.details.eventIds ?? []) if (typeof id === "string") this.ids.add(id);
          }
        }
      }
      // Pi 的写入是同步 append；确认前完成文件同步，不依赖模型下一轮成功。
      fsyncSync(fd);
      return this.ids;
    } catch (error) { this.failed = true; throw error; }
    finally { closeSync(fd); }
  }
}

export function notificationMessage(origin, events) {
  return {
    customType: notificationType, display: true,
    content: "Agent Task 后台事件（不是新的执行授权）。请读取需要的任务记录并向用户简要汇报；不要自动重试或补充执行。等待输入事件可能已经过期或被回答，回复前先核对当前状态。\n" +
      JSON.stringify(events.map(({ eventId, taskId, runId, kind, summary, createdAt }) => ({ eventId, taskId, runId, kind, summary, createdAt }))),
    details: { origin, eventIds: events.map(event => event.eventId) },
  };
}

export function bindPiNotifications(pi) {
  let active;
  const live = state => active === state && !state.controller.signal.aborted && state.ctx.sessionManager.getSessionId() === state.nativeId;
  function warn(state) {
    if (!live(state) || state.warned) return;
    state.warned = true;
    if (state.ctx.hasUI) state.ctx.ui.notify("Agent Task 通知暂不可用；未确认事件会保留。请检查服务、通知配置和会话文件。", "warning");
  }
  async function tick(state) {
    if (!live(state) || !state.origin) return;
    try {
      const options = { cwd: state.ctx.cwd, signal: state.controller.signal, env: state.env };
      const result = await serviceRequest({ action: "poll", origin: state.origin, owner: state.owner }, options);
      if (!live(state)) return;
      state.leased = result.acquired;
      if (!result.acquired) { warn(state); return; }
      state.receipts ??= new DeliveryReceipts(state.ctx.sessionManager.getSessionFile(), state.origin, state.nativeId);
      const saved = state.receipts.read();
      const ack = result.items.filter(event => saved.has(event.eventId)).map(event => event.eventId);
      if (ack.length) await serviceRequest({ action: "ack", origin: state.origin, owner: state.owner, eventIds: ack }, options);
      if (!live(state)) return;
      for (const id of ack) state.queued.delete(id);
      if (!state.ctx.model) { warn(state); return; }
      if (state.ctx.isIdle() && result.items.some(event => state.queued.has(event.eventId) && !saved.has(event.eventId))) {
        warn(state); return;
      }
      const pending = result.items.filter(event => !saved.has(event.eventId) && !state.queued.has(event.eventId));
      // 留出桥接往返的余量；过期租约不能继续注入。
      if (pending.length && Date.now() < result.leaseUntil - 2000) {
        for (const event of pending) state.queued.add(event.eventId);
        pi.sendMessage(notificationMessage(state.origin, pending), { triggerTurn: true, deliverAs: "followUp" });
      }
      state.warned = false;
    } catch { warn(state); }
  }
  function schedule(state, delay = 0) {
    if (!live(state) || !state.origin || state.timer || state.pending) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.pending = tick(state).finally(() => { state.pending = undefined; schedule(state, 5000); });
    }, delay);
    state.timer.unref?.();
  }
  pi.on("session_start", (_event, ctx) => {
    if (process.env.AGENT_TASK_NOTIFICATIONS === "off" || !["tui", "rpc"].includes(ctx.mode)) return;
    const nativeId = ctx.sessionManager.getSessionId();
    if (!/^[a-zA-Z0-9_-]{1,190}$/.test(nativeId) || !ctx.sessionManager.getSessionFile()) return;
    const sessionId = "pi:" + nativeId;
    const binding = ctx.sessionManager.getEntries().find(entry => entry.type === "custom" && entry.customType === originType && entry.data?.sessionId === sessionId);
    const state = { ctx, nativeId, env: { ...process.env }, owner: randomUUID(), controller: new AbortController(), queued: new Set(), origin: binding?.data };
    active = state;
    schedule(state);
  });
  pi.on("tool_call", async (event, ctx) => {
    const state = active;
    if (!state || !live(state)) return;
    const tool = "mcp__" + (state.env.AGENT_TASK_MCP_SERVER ?? "agent-task").replace(/-/g, "_") + "__task_create";
    if (event.toolName !== tool) return;
    try {
      state.binding ??= (async () => {
        if (state.origin) return state.origin;
        const projectId = await projectIdentity(ctx.cwd, { signal: state.controller.signal, env: state.env });
        if (!live(state)) throw new Error("会话已切换");
        const origin = { projectId, sessionId: "pi:" + state.nativeId };
        pi.appendEntry(originType, origin);
        state.origin = origin;
        return origin;
      })();
      const origin = await state.binding;
      if (!live(state)) return { block: true, reason: "会话已切换，未创建任务" };
      event.input.notification = origin;
      schedule(state);
    } catch {
      state.binding = undefined;
      return { block: true, reason: "无法确定并保存通知身份，未创建任务。请检查 .agent-task/project.json；不要猜测身份。" };
    }
  });
  const retryIdle = (_event, ctx) => {
    const state = active;
    if (state && live(state) && ctx.isIdle()) { state.queued.clear(); schedule(state); }
  };
  pi.on("input", retryIdle);
  pi.on("model_select", retryIdle);
  pi.on("agent_settled", (_event, ctx) => {
    const state = active;
    if (state && live(state) && ctx.isIdle()) {
      // 被取消或失败的 followUp 可能不再在队列中；只有已落盘事件才会被确认。
      state.queued.clear();
      schedule(state);
    }
  });
  pi.on("session_shutdown", async () => {
    const state = active; active = undefined;
    if (!state) return;
    clearTimeout(state.timer); state.controller.abort();
    await state.pending;
    await state.binding?.catch(() => {});
    if (state.origin && state.leased) {
      try { await serviceRequest({ action: "release", origin: state.origin, owner: state.owner }, { cwd: state.ctx.cwd, env: state.env }); }
      catch { console.error("Agent Task 通知租约未能释放，将等待租约到期；未确认事件保留。"); }
    }
  });
}
