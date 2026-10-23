import { request } from "./api.js";
import { element, field, select, button, submit, block, table, notice, report } from "./dom.js";

function executorStatus(host, initial) {
  let state = initial, timer;
  const labels = { missing: "未安装", disabled: "已禁用", installing: "准备中", ready: "可派发", error: "准备失败" };
  const draw = () => {
    clearTimeout(timer);
    host.replaceChildren(table(["执行端", "状态", "本机路径", "ACP 适配器版本", "错误", "操作"], state.executors.map(executor => [
      executor.id, executor.state === "missing" && executor.nativePath ? "已发现，待准备" : labels[executor.state],
      executor.nativePath, executor.adapterVersion ?? (executor.type === "opencode" ? "原生 ACP" : "—"), executor.error,
      executor.type === "opencode" ? "通过原生 CLI 更新" : button("升级 ACP 适配器", async () => {
        if (!confirm("升级 " + executor.id + " 的托管 ACP 适配器？准备期间暂停向此执行端派发新工作。")) return;
        state = await request("/executors/upgrade", { id: executor.id }); draw();
        notice("适配器升级已开始，完成后更新状态。");
      }, !executor.nativePath || ["disabled", "installing"].includes(executor.state)),
    ])));
    if (state.executors.some(executor => executor.state === "installing")) timer = setTimeout(async () => {
      if (!host.isConnected) return;
      try { state = await request("/executors"); if (host.isConnected) draw(); }
      catch (error) { if (host.isConnected) report(error); }
    }, 2000);
  };
  draw();
  return async () => { state = await request("/executors/refresh", {}); draw(); };
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
  const initial = await Promise.all([request("/settings"), request("/executors")]);
  let state = initial[0];
  root.append(element("h2", "配置与凭据"), element("p", "配置和密钥分别保存。保存不修改当前进程；每次重新启动（包括故障后拉起）读取已保存值。"),
    element("p", "先保存新密钥，再保存引用它的配置。执行端原生登录和原生权限仍通过官方工具管理；这里不编辑其认证文件。"),
    block("当前运行配置（只读，无密钥值）", state.running));
  if (state.writeBlocked) root.append(element("p", "上次文件提交结果不确定。请停服核查；当前禁止继续保存。"));
  const executorHost = element("div");
  const refreshExecutors = executorStatus(executorHost, initial[1]);
  root.append(element("h3", "本机执行端"),
    element("p", "自动检测 pi、codex、claude 和 opencode。可派发表示启动依赖已准备，不代表原生认证或工具权限已验收。"),
    button("重新检测并准备执行端", refreshExecutors), executorHost);
  const form = element("form"), modelHost = element("fieldset"), executorOptions = element("fieldset");
  modelHost.append(element("legend", "协调模型"));
  const readModel = coordinatorEditor(modelHost, state.saved.coordinator);
  const startup = {
    dataDir: field("下次启动的数据目录（规范绝对路径；不搬迁或删除旧历史）", state.saved.dataDir),
    port: field("下次启动的监听端口（0 为自动分配）", state.saved.port, "number"),
    tokenEnv: field("MCP 令牌环境变量名（改名保留令牌值）", state.saved.tokenEnv),
  };
  executorOptions.append(element("legend", "下次启动启用的执行端"),
    element("p", "默认使用所有检测到的执行端。取消勾选后保存并重启；已有任务不会自动改派。"));
  const enabled = ["pi", "codex", "claude", "opencode"].map(type => {
    const item = field(type, !state.saved.disabledExecutors.includes(type), "checkbox");
    executorOptions.append(item.row); return { type, input: item.input };
  });
  const advanced = element("details"); advanced.dataset.key = "advanced-settings";
  advanced.append(element("summary", "高级设置"), element("h3", "启动配置"),
    ...Object.values(startup).map(item => item.row), executorOptions);
  form.append(modelHost, advanced);
  const preview = element("div");
  const save = submit(form, "校验并预览配置变更", async () => {
    const input = { editToken: state.editToken,
      config: { dataDir: startup.dataDir.input.value, port: startup.port.input.valueAsNumber, tokenEnv: startup.tokenEnv.input.value,
      coordinator: readModel(), disabledExecutors: enabled.filter(item => !item.input.checked).map(item => item.type) } };
    const checked = await request("/settings/validate", input);
    preview.replaceChildren(block("校验后的待保存配置", checked.config),
      block("配置变更", checked.changes),
      block("重启后受执行端变更影响的任务", checked.affectedTasks));
    const affected = checked.affectedTasks.map(task => task.name + " (" + task.id + ")").join("\n") || "无";
    if (!confirm("本地校验通过，不代表模型认证或 ACP 执行已验证。\n受影响任务：\n" + affected +
      "\n\n旧任务快照不会被重写，派发可能被拒绝。确认保存配置？保存后仍须手动重启。")) return;
    await request("/settings/config", input);
    notice("配置已保存，未热更新。检查活动运行后可在本页或 CLI 重启。");
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
  root.append(statuses, credentialForm, element("h3", "重启服务"),
    element("p", "重启只应用已保存配置，未保存草稿会丢失。活动执行及待回答运行可能持有 ACP 会话；重启会关闭会话，不自动重试或重放不确定执行。"),
    button("重启并检查可用性", async () => {
      if (!confirm("确认使用已保存配置重启？活动工作可能中断，旧数据不会迁移。")) return;
      notice("正在关闭旧运行并启动新实例，请勿重复操作……");
      const ready = await request("/restart", {});
      document.dispatchEvent(new CustomEvent("service-restarted", { detail: ready }));
    }, state.writeBlocked),
    block("重启命令", "agent-task restart [--home /absolute/installation]"),
    element("p", "只有新实例通过认证健康检查才显示成功。若请求结果不确定，请先运行 agent-task status；启动失败时检查当前 dataDir/service.log，不删除历史或重放任务来修复。"));
}
