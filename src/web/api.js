let token = "";

export function disconnect() { token = ""; }
export async function connect(value) {
  token = value;
  try { return await request("/status"); }
  catch (error) { disconnect(); throw error; }
}
export async function request(path, body) {
  let response;
  try {
    response = await fetch("/admin/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error("请求结果未确认。请刷新核对，不要盲目重复写入。"); }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(response.status === 401 ? "管理员令牌无效，请重新连接。" : result.error ?? "请求被拒绝：" + response.status);
    error.status = response.status;
    throw error;
  }
  return (await response.json()).data;
}
