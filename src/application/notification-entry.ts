import { configSchema } from "../configuration/contract.js";
import { readEnvironment, startupPaths } from "../configuration/files.js";
import { readPrivateText } from "../infrastructure/private-files.js";
import { controlService } from "../integrations/local-service/control.js";
import { notificationRequest, notificationResponse } from "../protocol/notification-contract.js";

/** 插件桥接：只访问已有后台；凭据不进入插件、参数或响应。 */
export async function runNotifications(home: string): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk); size += data.length;
    if (size > 16_384) throw new Error("通知请求过大");
    chunks.push(data);
  }
  const input = notificationRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const ready = await controlService(home, "status", 2000);
  const paths = startupPaths(home);
  const config = configSchema.parse(JSON.parse(readPrivateText(paths.configPath)));
  const token = readEnvironment(paths.environmentPath)[config.tokenEnv];
  if (!token) throw new Error("通知服务凭据不可用");
  const url = new URL(ready.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) {
    throw new Error("通知服务地址无效");
  }
  url.pathname = "/notifications";
  const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error("通知请求失败；未确认的事件会保留");
  console.log(JSON.stringify(notificationResponse.parse(await response.json())));
}
