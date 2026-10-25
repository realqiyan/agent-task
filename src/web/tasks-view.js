import { request } from "./api.js";
import { element, table, button, block, notice, time } from "./dom.js";

function paging(root, page, state, navigate) {
  const actions = element("div"); actions.className = "actions";
  actions.append(button("上一页", () => navigate({ ...state, after: Math.max(0, state.after - 20) }), state.after === 0),
    button("下一页", () => navigate({ ...state, after: page.next }), page.next === null));
  root.append(actions);
}
export async function renderTasks(root, state, navigate) {
  if (state.kind === "tasks") {
    const page = await request("/tasks?after=" + state.after);
    root.append(element("h2", "任务"), element("p", "触发计划状态不等于运行结果；空闲页面每 10 秒刷新，交互时可手动刷新。"),
      table(["任务", "触发计划状态", "计划", "下次触发"], page.items.map(task => [
        button(task.name, () => navigate({ kind: "task", id: task.id, after: 0 })),
        task.scheduleStatus, JSON.stringify(task.schedule), time(task.nextAt),
      ])));
    paging(root, page, state, navigate);
  } else if (state.kind === "task") await task(root, state, navigate);
  else await run(root, state, navigate);
}
async function task(root, state, navigate) {
  const [task, page] = await Promise.all([
    request("/tasks/" + encodeURIComponent(state.id)),
    request("/runs?taskId=" + encodeURIComponent(state.id) + "&after=" + state.after),
  ]);
  root.append(button("返回任务列表", () => navigate({ kind: "tasks", after: 0 })), element("h2", task.input.name),
    element("p", task.id + " · 触发计划：" + task.scheduleStatus + " · 下次触发：" + time(task.nextAt)),
    element("p", "以下操作只影响未来触发，不停止当前运行，也不回滚外部操作。恢复不会补跑；取消后不可恢复未来触发。"));
  const actions = element("div"); actions.className = "actions";
  for (const [action, label, enabled] of [
    ["pause", "暂停未来触发", task.scheduleStatus === "active"],
    ["resume", "恢复未来触发", task.scheduleStatus === "paused"],
    ["cancel", "取消未来触发", !["cancelled", "expired"].includes(task.scheduleStatus)],
  ]) {
    actions.append(button(label, async () => {
      if (!confirm(label + "？\n不影响当前运行。恢复不会补跑；取消不可恢复。")) return;
      await request("/task-schedule-control", { taskId: task.id, action });
      notice("未来触发已更新；当前运行未被取消。");
      navigate(state);
    }, !enabled || task.nextAt === null));
  }
  root.append(actions, block("整体目标", task.input.prompt),
    block("计划、预算与工作空间", { ...task.input, prompt: undefined, nodes: undefined, workspace: task.workspace }),
    table(["节点", "执行端", "依赖节点"], task.input.nodes.map(node => [node.id, node.executorId, node.dependsOn.join(", ") || "无"])),
    block("固定 DAG 与执行端快照（只读）", { nodes: task.input.nodes, executors: task.executors }), element("h3", "运行历史"),
    table(["运行", "状态", "已接受节点", "开始 / 结束", "错误"], page.items.map(run => [
      button(run.id, () => navigate({ kind: "run", id: run.id })), run.status,
      run.accepted + " / " + run.total, time(run.createdAt) + " / " + time(run.finishedAt), run.error,
    ])));
  paging(root, page, state, navigate);
}
async function run(root, state, navigate) {
  const run = await request("/runs/" + encodeURIComponent(state.id));
  root.append(button("返回任务", () => navigate({ kind: "task", id: run.taskId, after: 0 })),
    element("h2", "运行 " + run.id), element("p", run.status + " · " + time(run.createdAt) + " → " + time(run.finishedAt)),
    element("p", "协议回合结束不等于任务完成；只有明确接受的交付才能解锁依赖。"));
  if (run.error) root.append(block("运行错误 / 阻塞原因", run.error));
  if (run.summary) root.append(block("运行摘要", run.summary));
  root.append(table(["节点", "执行端", "状态", "开始", "错误"], run.nodes.map(node =>
    [node.definition.id, node.definition.executorId, node.status, time(node.startedAt), node.error])));
  for (const node of run.nodes) {
    const details = element("details"); details.dataset.key = node.id;
    details.append(element("summary", node.definition.id + " · " + node.status),
      block("节点与会话记录", { definition: node.definition, workspace: node.workspace, inputFiles: node.inputFiles,
        deliveryId: node.deliveryId, deliveries: node.deliveries, baseline: node.baseline, resultFile: node.resultFile, sessionId: node.sessionId, error: node.error }, node.id + "-metadata"));
    if (node.result !== null) details.append(block("已接受交付", node.result, node.id + "-result"),
      block("接受理由", node.acceptance, node.id + "-acceptance"));
    node.turns.forEach((turn, index) => details.append(block("回合 " + (index + 1) + "（原始材料，不等于交付）", turn, node.id + "-turn-" + index)));
    root.append(details);
  }
  root.append(element("h3", "问题与已有回复（只读）"), element("p", "本页面不回答问题。请通过 MCP 的现有人工回复流程处理。"));
  if (!run.questions.length) root.append(element("p", "无问题记录。"));
  for (const question of run.questions) {
    const card = element("article");
    card.append(element("h3", question.reply ? "已回复" : "待回答"),
      element("p", question.question), block("已完成工作", question.completedWork, question.id + "-work"),
      element("p", "问题 ID：" + question.id + " · 节点：" + (question.nodeId ?? "整体任务")),
      element("p", "问题期限：" + time(question.expiresAt) + " · 会话期限：" + time(question.sessionExpiresAt)));
    if (question.reply) card.append(block("已有回复", question.reply.answer, question.id + "-answer"));
    root.append(card);
  }
}
