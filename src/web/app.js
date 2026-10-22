import { connect, disconnect, request } from "./api.js";
import { element, notice, report, submit } from "./dom.js";
import { renderTasks } from "./tasks-view.js";
import { renderSettings } from "./settings-view.js";

const login = document.querySelector("#login"), navigation = document.querySelector("#navigation");
const main = document.querySelector("#view"), status = document.querySelector("#status"), token = document.querySelector("#token");
let connected = false, view = { kind: "tasks", after: 0 }, sequence = 0, loading = false, dirty = false;

function health(value) {
  status.textContent = (value.running && value.storageHealthy ? "服务运行中" : "服务不可用") +
    " · 活动协调运行：" + value.activeTaskRunIds.length + " · ACP 会话：" + value.activeNodeRunIds.length +
    (value.settings.pendingRestart ? " · 已保存变更，待手动重启（当前权限和凭据未变）" : " · 无待重启变更") +
    (value.settings.writeBlocked ? " · 配置保存已冻结，请停服核查" : "");
}
async function render() {
  const current = ++sequence, target = { ...view }, root = element("section");
  const open = new Set([...main.querySelectorAll("details[open]")].map(node => node.dataset.key));
  loading = true;
  const navigate = (next, force = false) => { if (root.isConnected) void go(next, force); };
  try {
    if (target.kind === "settings") await renderSettings(root, navigate);
    else await renderTasks(root, target, navigate);
    if (current !== sequence || !connected) return;
    for (const node of root.querySelectorAll("details")) node.open = open.has(node.dataset.key);
    root.addEventListener("input", () => { dirty = true; });
    main.replaceChildren(root); dirty = false;
  } catch (error) { if (current === sequence && connected) report(error); }
  finally { if (current === sequence) loading = false; }
}
async function go(next, force = false) {
  if (!force && dirty && !confirm("离开或刷新将丢弃尚未保存的表单编辑，继续？")) return;
  view = next; dirty = false; await render();
}
function logout() {
  connected = false; sequence++; loading = false; dirty = false; disconnect();
  main.replaceChildren(); status.textContent = ""; token.value = "";
  navigation.hidden = true; login.hidden = false;
}
login.append(submit(login, "连接控制台", async () => {
  const value = token.value; token.value = "";
  const result = await connect(value);
  connected = true; login.hidden = true; navigation.hidden = false; notice(); health(result);
  await go({ kind: "tasks", after: 0 }, true);
}));
document.querySelector("#tasks").addEventListener("click", () => { void go({ kind: "tasks", after: 0 }); });
document.querySelector("#settings").addEventListener("click", () => { void go({ kind: "settings" }); });
document.querySelector("#refresh").addEventListener("click", async () => {
  await go(view);
  if (connected) { try { health(await request("/status")); } catch (error) { report(error); } }
});
document.querySelector("#logout").addEventListener("click", () => { logout(); notice("已退出；刷新后也须重新输入管理员令牌。"); });
document.addEventListener("unauthorized", logout);
window.addEventListener("pagehide", logout);
setInterval(async () => {
  if (!connected || document.hidden || loading) return;
  const current = sequence;
  try {
    const value = await request("/status");
    if (connected && current === sequence) {
      health(value);
      if (view.kind !== "settings" && !main.contains(document.activeElement)) await render();
    }
  } catch (error) { if (connected && current === sequence) report(error); }
}, 10_000);
