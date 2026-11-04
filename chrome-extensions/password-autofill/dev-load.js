// Chrome 137+ 已忽略 --load-extension，通过 CDP 的 Extensions.loadUnpacked 加载本目录（需 --enable-unsafe-extension-debugging）。
// 用法：node dev-load.js [端口，默认 9333]
const port = process.argv[2] || 9333;
(async () => {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: __dirname } }));
  ws.onmessage = e => { console.log(e.data); ws.close(); };
})().catch(err => { console.error(err.message); process.exit(1); });
