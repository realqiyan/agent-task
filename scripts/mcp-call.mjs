import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { version } from "../dist/infrastructure/version.js";
const [tool, input = "{}"] = process.argv.slice(2);
if (!tool || !process.env.TASK_CONDUCTOR_TOKEN) {
  console.error("用法：安全注入 TASK_CONDUCTOR_TOKEN 后，运行 node scripts/mcp-call.mjs <工具名|--list> '[JSON参数]'\nTASK_CONDUCTOR_URL 默认为 http://127.0.0.1:8765/mcp");
  process.exit(2);
}
const client = new Client({ name: "task-conductor-command", version });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.TASK_CONDUCTOR_URL ?? "http://127.0.0.1:8765/mcp"),
    { requestInit: { headers: { Authorization: "Bearer " + process.env.TASK_CONDUCTOR_TOKEN } } }));
  const result = tool === "--list" ? await client.listTools() : await client.callTool({ name: tool, arguments: JSON.parse(input) });
  console.log(JSON.stringify(result, null, 2));
  if ("isError" in result && result.isError) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await client.close(); }
