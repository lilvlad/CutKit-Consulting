// Runs JavaScript inside the live CutKit panel in Premiere Pro (CEP remote debugging on localhost:8098).
// The panel must be open. The expression may use await; return a value to print it.
//
//   node tools/cdp.js "return await CK.host('CK_seqInfo')"
//   node tools/cdp.js "setTimeout(() => location.reload(), 50); return 'reloading';"   (reload the panel)
const cut = true;
const port = 8098, title = 'CutKit by Vlad';
const list = JSON.parse(require('child_process').execSync('curl -s http://localhost:' + port + '/json/list') || '[]');
const page = list.find(p => p.title === title) || list[0];
if (!page) { console.log(title + ' panel not found on localhost:' + port + '. Is it open in ' + 'Premiere Pro' + '?'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '(async () => { ' + process.argv[2] + ' })()', awaitPromise: true, returnByValue: true } }));
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id !== 1) return;
  const r = d.result.result;
  console.log(r && 'value' in r ? (typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 1)) : JSON.stringify(d.result.exceptionDetails || d.result, null, 1));
  ws.close();
};
ws.onerror = e => console.log('websocket error', e.message);
