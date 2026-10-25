import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { version } from "../dist/infrastructure/version.js";
const [tool, input = "{}"] = process.argv.slice(2);
if (!tool || !process.env.AGENT_TASK_TOKEN) {
  console.error("用法：安全注入 AGENT_TASK_TOKEN 后，运行 node scripts/mcp-call.mjs <工具名|--list> '[JSON参数]'\nAGENT_TASK_URL 默认为 http://127.0.0.1:8765/mcp");
  process.exit(2);
}
const client = new Client({ name: "agent-task-command", version });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.AGENT_TASK_URL ?? "http://127.0.0.1:8765/mcp"),
    { requestInit: { headers: { Authorization: "Bearer " + process.env.AGENT_TASK_TOKEN } } }));
  const result = tool === "--list" ? await client.listTools() : await client.callTool({ name: tool, arguments: JSON.parse(input) });
  console.log(JSON.stringify(result, null, 2));
  if ("isError" in result && result.isError) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await client.close(); }
