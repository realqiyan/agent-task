export function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  return node;
}
export function notice(text = "") { document.querySelector("#notice").textContent = text; }
export function report(error) {
  notice(error.message ?? "操作失败");
  if (error.status === 401) document.dispatchEvent(new Event("unauthorized"));
}
async function act(node, action) {
  node.disabled = true;
  try { await action(); } catch (error) { if (node.isConnected) report(error); }
  finally { node.disabled = false; }
}
export function button(text, action, disabled = false) {
  const node = element("button", text); node.type = "button"; node.disabled = disabled;
  node.addEventListener("click", () => { void act(node, action); });
  return node;
}
export function submit(form, text, action) {
  const node = form.querySelector("button[type=submit]") ?? element("button", text); node.type = "submit";
  form.addEventListener("submit", event => { event.preventDefault(); void act(node, action); });
  return node;
}
export function block(title, value, key = title) {
  const details = element("details"); details.dataset.key = key;
  details.append(element("summary", title), element("pre", typeof value === "string" ? value : JSON.stringify(value, null, 2)));
  return details;
}
export function table(headers, rows) {
  const wrapper = element("div"); wrapper.className = "table-wrap";
  const node = element("table"), head = element("tr");
  for (const label of headers) head.append(element("th", label));
  const thead = element("thead"); thead.append(head); node.append(thead);
  const body = element("tbody");
  for (const row of rows) {
    const tr = element("tr");
    for (const value of row) {
      const td = element("td");
      td.append(value instanceof Node ? value : document.createTextNode(value == null ? "—" : String(value)));
      tr.append(td);
    }
    body.append(tr);
  }
  node.append(body); wrapper.append(node);
  return wrapper;
}
export function field(label, value = "", type = "text") {
  const row = element("label", label), input = element(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") input.type = type;
  if (type === "checkbox") input.checked = Boolean(value); else input.value = value ?? "";
  if (type === "password") { input.autocomplete = "off"; input.spellcheck = false; }
  row.append(input);
  return { row, input };
}
export function select(label, choices, value = "") {
  const row = element("label", label), input = element("select");
  for (const [key, text] of choices) {
    const option = element("option", text); option.value = key; input.append(option);
  }
  input.value = value; row.append(input);
  return { row, input };
}
export function time(value) { return value == null ? "—" : new Date(value).toLocaleString(); }
