import { request } from "./api.js";
import { element, field, select, button, submit, block, table, notice } from "./dom.js";

const lines = input => input.value.split("\n").map(value => value.trim()).filter(Boolean);
function executorEditor(host, executor) {
  const card = element("fieldset"), fields = {};
  card.append(element("legend", "ACP 执行端"));
  for (const [key, label, type, value] of [
    ["id", "注册 ID", "text", executor.id],
    ["command", "ACP 可执行文件（绝对路径，不含密钥）", "text", executor.command],
    ["cwd", "默认工作空间（绝对路径）", "text", executor.cwd],
    ["args", "参数（JSON 字符串数组；不得包含密钥）", "textarea", JSON.stringify(executor.args ?? [])],
    ["envKeys", "传入执行端的环境变量名（每行一个，不填值）", "textarea", (executor.envKeys ?? []).join("\n")],
    ["permissionAllowlist", "ACP 审批工具名白名单（每行一个）", "textarea", (executor.permissionAllowlist ?? []).join("\n")],
    ["resultReadRoots", "结果读取目录（规范绝对路径，每行一个）", "textarea", (executor.resultReadRoots ?? []).join("\n")],
  ]) {
    const item = field(label, value, type); fields[key] = item.input; card.append(item.row);
  }
  const approved = field("已由管理员审核原生授权，允许无人值守执行", executor.unattendedApproved, "checkbox");
  for (const input of Object.values(fields)) input.addEventListener("input", () => { approved.input.checked = false; });
  card.append(approved.row, element("p", "修改注册信息后须重新明确批准。白名单只约束实际发出的 ACP 审批请求，不是沙箱，也不是完整工具授权。"),
    button("从待保存配置中移除", () => { card.remove(); host.dispatchEvent(new Event("input", { bubbles: true })); }));
  host.append(card);
  return () => {
    if (card.parentNode !== host) return [];
    let args;
    try { args = JSON.parse(fields.args.value); } catch { throw new Error("执行端参数必须是 JSON 字符串数组。"); }
    return [{ id: fields.id.value, command: fields.command.value, cwd: fields.cwd.value, args,
      envKeys: lines(fields.envKeys), permissionAllowlist: lines(fields.permissionAllowlist),
      resultReadRoots: lines(fields.resultReadRoots), unattendedApproved: approved.input.checked }];
  };
}
function coordinatorEditor(host, config) {
  const provider = select("协调模型提供方", [["", "未配置"], ["openai", "OpenAI"], ["anthropic", "Anthropic"],
    ["deepseek", "DeepSeek"], ["openai-compatible", "OpenAI-compatible"]], config?.provider ?? "");
  const model = field("模型 ID", config?.model), compatible = element("fieldset");
  compatible.append(element("legend", "兼容端点元数据（由管理员确认，不自动查询）"));
  const custom = {
    baseUrl: field("端点 URL（不得包含凭据、查询参数或片段）", config?.baseUrl),
    apiKeyEnv: field("密钥变量名（先在下方保存新密钥）", config?.apiKeyEnv ?? "COORDINATOR_API_KEY"),
    api: select("API", [["openai-completions", "openai-completions"], ["openai-responses", "openai-responses"]], config?.api ?? "openai-completions"),
    contextWindow: field("上下文窗口", config?.contextWindow, "number"),
    maxTokens: field("最大输出 token", config?.maxTokens, "number"),
    reasoning: field("支持 reasoning", config?.reasoning, "checkbox"),
  };
  for (const item of Object.values(custom)) compatible.append(item.row);
  const visibility = () => { compatible.hidden = provider.input.value !== "openai-compatible"; model.row.hidden = !provider.input.value; };
  provider.input.addEventListener("change", visibility); visibility();
  host.append(provider.row, model.row, compatible);
  return () => {
    if (!provider.input.value) return undefined;
    const result = { provider: provider.input.value, model: model.input.value };
    if (result.provider === "openai-compatible") Object.assign(result, {
      baseUrl: custom.baseUrl.input.value, apiKeyEnv: custom.apiKeyEnv.input.value, api: custom.api.input.value,
      contextWindow: custom.contextWindow.input.valueAsNumber, maxTokens: custom.maxTokens.input.valueAsNumber,
      reasoning: custom.reasoning.input.checked,
    });
    return result;
  };
}
export async function renderSettings(root, navigate) {
  let state = await request("/settings");
  root.append(element("h2", "配置与凭据"), element("p", "配置和密钥分别保存。保存不修改当前进程；每次重新启动（包括故障后拉起）读取已保存值。"),
    element("p", "先保存新密钥，再保存引用它的配置。执行端原生登录和原生权限仍通过官方工具管理；这里不编辑其认证文件。"),
    block("当前运行配置（只读，无密钥值）", state.running),
    block("启动级配置（只读）", { dataDir: state.saved.dataDir, port: state.saved.port, tokenEnv: state.saved.tokenEnv }));
  if (state.writeBlocked) root.append(element("p", "上次文件提交结果不确定。请停服核查；当前禁止继续保存。"));
  const form = element("form"), modelHost = element("fieldset"), executors = element("div"), readers = [];
  modelHost.append(element("legend", "协调模型"));
  const readModel = coordinatorEditor(modelHost, state.saved.coordinator);
  form.append(modelHost, element("h3", "执行端注册与权限"), executors);
  for (const executor of state.saved.executors) readers.push(executorEditor(executors, executor));
  form.append(button("添加执行端", () => {
    readers.push(executorEditor(executors, { id: "", command: "", cwd: "", unattendedApproved: false }));
  }, state.writeBlocked));
  const preview = element("div");
  const save = submit(form, "校验并预览配置变更", async () => {
    const input = { editToken: state.editToken, config: { coordinator: readModel(), executors: readers.flatMap(read => read()) } };
    const checked = await request("/settings/validate", input);
    preview.replaceChildren(block("校验后的待保存配置", checked.config),
      block("重启后受执行端变更影响的任务", checked.affectedTasks));
    const affected = checked.affectedTasks.map(task => task.name + " (" + task.id + ")").join("\n") || "无";
    if (!confirm("本地校验通过，不代表模型认证或 ACP 执行已验证。\n受影响任务：\n" + affected +
      "\n\n旧任务快照不会被重写，派发可能被拒绝。确认保存配置？保存后仍须手动重启。")) return;
    await request("/settings/config", input);
    notice("配置已保存，未热更新。请检查活动运行后在终端手动重启。");
    navigate({ kind: "settings" }, true);
  });
  save.disabled = state.writeBlocked; form.append(save, preview); root.append(form);

  root.append(element("h3", "密钥（仅显示是否设置）"),
    element("p", "不提交即保留原值。新变量名使用 _KEY、_TOKEN、_SECRET 或 _PASSWORD 结尾；不能在这里修改服务/管理员令牌或运行环境。"));
  const statuses = element("div"), credentialForm = element("form");
  const key = field("凭据变量名"), value = field("新值（替换后不回显）", "", "password");
  key.input.required = true; value.input.required = true;
  value.input.maxLength = 16384;
  const drawCredentials = () => {
    statuses.replaceChildren(table(["变量名", "已保存", "当前进程已设置", "待重启", "操作"], state.credentials.map(credential => [
      credential.key, credential.saved ? "是" : "否", credential.running ? "是" : "否", credential.pendingRestart ? "是" : "否",
      button("删除已保存值", async () => {
        if (!confirm("删除 " + credential.key + " 的已保存值？当前进程仍保留旧值，直到重启。")) return;
        state = await request("/settings/credential", { editToken: state.editToken, key: credential.key, action: "delete" });
        drawCredentials(); notice("密钥删除已保存，待重启。配置表单中的未保存编辑仍保留。");
      }, !credential.saved || credential.referenced || state.writeBlocked),
    ])));
  };
  drawCredentials();
  credentialForm.append(key.row, value.row);
  const replace = submit(credentialForm, "单独保存此密钥", async () => {
    const input = { editToken: state.editToken, key: key.input.value, action: "replace", value: value.input.value };
    value.input.value = "";
    state = await request("/settings/credential", input);
    drawCredentials(); notice("密钥已保存，未热更新。配置表单中的未保存编辑仍保留，请继续校验并保存配置。");
  });
  replace.disabled = state.writeBlocked;
  credentialForm.append(replace);
  root.append(statuses, credentialForm, element("h3", "手动重启"),
    element("p", "先检查活动运行及待回答运行；待回答运行也可能持有 ACP 会话。必要时暂停相关未来触发，并等待活动工作结束。重启可能中断会话，不会自动重放不确定执行。"),
    block("Linux 用户服务", "systemctl --user restart agent-task.service"),
    element("p", "macOS 按部署说明 bootout 后用 setup 重新加载 LaunchAgent。前台服务停止后用原启动参数重新启动。启动失败时从终端修正私有文件，不删除历史或工作空间。"));
}
