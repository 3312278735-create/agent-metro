'use strict';
// 线路图的本地服务：让页面上的「改站点状态 / 归档项目 / 恢复项目」能写回台账。
// 只监听 127.0.0.1；写操作要带页面内嵌的一次性令牌；每次请求都现读台账，不缓存。
// 由「打开地铁图.bat」启动。页面关掉约 10 分钟后自动退出。
// 看板代码（tools/ 下除本文件外的 .js）改过之后，下一次请求自动换上新版，不用重启；
// 本文件自己改过的话，页面右上角「刷新」会让服务在同样的最小化窗口里重启一次。
//
// 服务窗口被点进「选择」模式时，服务一打日志就会卡住：启动时关掉这个窗口的「快速编辑」；
// 万一还是卡住了（比如用菜单「标记」），再双击 bat 会发现旧服务不答话，把它换掉。
//
// 测试用参数：--root <台账副本目录>  --port <端口>  --no-open（不自动开浏览器）
// 内部参数：--takeover（重启接班：端口还被旧服务占着时稍等再试，不当作「已在运行」退出）

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execFileSync, spawn } = require('child_process');

const argv = process.argv.slice(2);
const argValue = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = path.resolve(argValue('--root') || path.resolve(__dirname, '..'));
const HOST = '127.0.0.1';
const PORT = Number(argValue('--port')) || 47615;
const NO_OPEN = argv.includes('--no-open');
const TAKEOVER = argv.includes('--takeover');
const IDLE_EXIT_MS = 10 * 60 * 1000;
const TOKEN = crypto.randomBytes(24).toString('hex');
const BOOT = crypto.randomBytes(6).toString('hex'); // 每次启动都不同，页面靠它认出「重启好了」
const URL_HOME = `http://${HOST}:${PORT}/`;
const WINDOW_TITLE = '看板服务 - 关掉这个窗口就停止'; // 与「打开地铁图.bat」里的窗口标题一致

let lastSeen = Date.now();
const now = () => new Date().toLocaleTimeString();

/* 看板代码热加载：build-metro.js、ledger.js 这些改过就重新 require。新代码加载失败时继续用旧版。 */
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch (e) { return 0; } };
const SELF_MTIME = mtimeOf(__filename);
const selfStale = () => mtimeOf(__filename) !== SELF_MTIME;
let lib = null; // { buildData, renderHtml, writeStatic, applyToDisk, setPin }
let libStamp = '';
let libError = '';

function loadLib() {
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js'))
    .map((f) => path.join(__dirname, f)).filter((f) => f !== __filename);
  const stamp = files.map((f) => `${f}:${mtimeOf(f)}`).join('|');
  if (lib && stamp === libStamp) return false;
  libStamp = stamp;
  const previous = lib;
  for (const f of files) delete require.cache[f];
  try {
    const metro = require('./build-metro.js');
    const ledger = require('./ledger.js');
    lib = { buildData: metro.buildData, renderHtml: metro.renderHtml, writeStatic: metro.writeStatic, applyToDisk: ledger.applyToDisk, setPin: ledger.setPin };
    libError = '';
    if (previous) console.log(`[${now()}] 看板代码有更新，已换上新版`);
    return Boolean(previous);
  } catch (e) {
    if (!previous) throw e;
    libError = e.message;
    console.error(`[${now()}] 新版看板代码加载失败，继续用旧版：${e.message}`);
    return false;
  }
}
loadLib();

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('请求太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('请求不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const OPS = {
  // 你在线路图上把一站点成「已到站」或勾「我亲手验过了」，页面带 accept: 'me' = 人工验收
  '/api/set-status': (b) => lib.applyToDisk('set-status', { id: String(b.id || ''), status: String(b.status || ''), note: String(b.note || ''), accept: b.status === 'done' && b.accept === 'me' ? 'me' : '' }, ROOT),
  '/api/archive-project': (b) => lib.applyToDisk('archive-project', { name: String(b.name || ''), note: String(b.note || ''), undoneAs: b.undoneAs === 'done' ? 'done' : 'dropped' }, ROOT),
  '/api/restore-project': (b) => lib.applyToDisk('restore-project', { name: String(b.name || ''), note: String(b.note || '') }, ROOT),
  '/api/pin': (b) => {
    const kind = String(b.kind || ''), key = String(b.key || '').slice(0, 100);
    if (kind !== 'project' && kind !== 'task') throw new Error('置顶对象只能是项目或站点');
    // 只允许置顶台账里真实存在的线路 / 站点，pins.json 里不留垃圾。
    const lines = lib.buildData(ROOT).lines;
    const exists = kind === 'project' ? lines.some((l) => l.name === key) : lines.some((l) => l.stations.some((s) => s.id === key));
    if (!exists) throw new Error(`找不到要置顶的${kind === 'project' ? '项目' : '站点'}「${key}」`);
    return lib.setPin({ kind, key, pinned: b.pinned === true }, ROOT);
  },
};

// 本文件改过之后由「刷新」触发：在同样的最小化窗口里起一个新服务接班，自己退出。
// 重启前先做语法检查：新文件有语法错误就不重启，继续用旧版服务。
function checkSelf() {
  try {
    execFileSync(process.execPath, ['--check', __filename], { stdio: 'pipe', windowsHide: true });
    return '';
  } catch (e) {
    const detail = String(e.stderr || e.message).split(/\r?\n/).find((l) => /Error/.test(l)) || e.message;
    return `新版看板服务有语法错误，没有重启：${detail}`;
  }
}
let restarting = false;
function restartSelf() {
  restarting = true;
  const pass = [];
  if (argValue('--root')) pass.push('--root', ROOT);
  if (argValue('--port')) pass.push('--port', String(PORT));
  const args = [__filename, ...pass, '--no-open', '--takeover'].map((a) => `"${a}"`).join(' ');
  console.log(`[${now()}] 看板服务本身有更新，正在重启…`);
  server.close();
  // stdio 用 ignore：不给 cmd 接管道，否则新服务会继承管道，本进程要等它们关掉才退得了。
  const starter = spawn(`start "${WINDOW_TITLE}" /min "${process.execPath}" ${args}`, { shell: 'cmd.exe', cwd: ROOT, stdio: 'ignore', windowsHide: true });
  let settled = false;
  const giveUp = (why) => {
    if (settled) return;
    settled = true;
    // 起不来新服务就接着用旧的，页面等不到新服务会提示用户双击 bat。
    console.error('重启失败，继续用旧版服务：' + why);
    restarting = false;
    server.listen(PORT, HOST);
  };
  starter.on('error', (e) => giveUp(e.message));
  starter.on('exit', (code) => {
    if (code !== 0) return giveUp(`start 退出码 ${code}`);
    settled = true;
    setTimeout(() => process.exit(0), 200);
  });
}

const server = http.createServer(async (req, res) => {
  lastSeen = Date.now();
  try {
    // 只认本机来的 Host，挡掉 DNS 重绑定。
    const host = String(req.headers.host || '');
    if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: '只接受本机访问' });

    const url = new URL(req.url, URL_HOME);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/metro.html')) {
      loadLib();
      const page = { token: TOKEN, boot: BOOT, stale: selfStale(), libError };
      return send(res, 200, lib.renderHtml(lib.buildData(ROOT), page), 'text/html; charset=utf-8');
    }

    // 项目页链接：只放行 projects/ 下的 .md，按纯文本给。
    if (req.method === 'GET' && url.pathname.startsWith('/projects/')) {
      const name = path.basename(decodeURIComponent(url.pathname));
      const file = path.join(ROOT, 'projects', name);
      if (!name.endsWith('.md') || !fs.existsSync(file)) return send(res, 404, '没有这个项目页', 'text/plain; charset=utf-8');
      return send(res, 200, fs.readFileSync(file), 'text/plain; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/api/ping') return send(res, 200, { ok: true, boot: BOOT });

    // 页面右上角「刷新」：换上新版看板代码；本文件改过就重启服务。页面随后自己重新载入。
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      if (req.headers['x-board-token'] !== TOKEN) return send(res, 403, { error: '页面已过期，请刷新后再试' });
      if (restarting) return send(res, 200, { ok: true, restarting: true, boot: BOOT });
      if (selfStale()) {
        const error = checkSelf();
        if (!error) {
          send(res, 200, { ok: true, restarting: true, boot: BOOT });
          restartSelf();
          return;
        }
        const reloaded = loadLib();
        return send(res, 200, { ok: true, restarting: false, reloaded, libError: [libError, error].filter(Boolean).join('；') });
      }
      const reloaded = loadLib();
      send(res, 200, { ok: true, restarting: false, reloaded, libError });
      console.log(`[${now()}] /api/refresh → ${reloaded ? '已换上新版看板代码' : '看板代码没有变化'}`);
      return;
    }

    if (req.method === 'POST' && OPS[url.pathname]) {
      if (req.headers['x-board-token'] !== TOKEN) return send(res, 403, { error: '页面已过期，请刷新后再试' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: '需要 JSON' });
      const body = await readJson(req);
      loadLib();
      let result;
      try {
        result = OPS[url.pathname](body);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      try { lib.writeStatic(ROOT); } catch (e) { /* 静态页只是副本，生成失败不影响这次操作 */ }
      send(res, 200, { ok: true, result }); // 先回页面再打日志：控制台万一卡住，页面也已经拿到结果
      console.log(`[${now()}] ${url.pathname} ${JSON.stringify(body)} → 成功`);
      return;
    }

    return send(res, 404, { error: '没有这个地址' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: '服务出错：' + e.message });
  }
});

function openBrowser() {
  if (NO_OPEN) return;
  exec(`start "" "${URL_HOME}"`, { shell: 'cmd.exe' });
}

// 关掉本服务窗口的「快速编辑」：开着的话，在窗口里点一下就进入「选择」模式，之后服务一打日志就卡住，
// 页面上点什么都没反应（2026-09-22 出过一次）。PowerShell 子进程继承本服务的控制台，改的就是这个窗口；
// 不加 windowsHide，否则它会另开一个隐藏控制台。PowerShell 会把窗口标题改成自己的，退出后改回来。关不掉也不影响服务。
function disableQuickEdit() {
  if (process.platform !== 'win32' || !require('tty').isatty(0)) return;
  const ps = [
    "Add-Type -Namespace Board -Name Con -MemberDefinition '",
    '[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n);',
    '[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);',
    '[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);',
    "';",
    '$h = [Board.Con]::GetStdHandle(-10); $m = 0;',
    'if ([Board.Con]::GetConsoleMode($h, [ref]$m)) { [void][Board.Con]::SetConsoleMode($h, ($m -band (-bnot 0x40)) -bor 0x80) }',
  ].join(' ');
  const title = process.title;
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { stdio: ['inherit', 'ignore', 'ignore'] })
      .on('error', () => {})
      .on('exit', () => { try { process.title = title; } catch (e) { /* 标题改不回来不要紧 */ } });
  } catch (e) { /* 关不掉就算了 */ }
}

/* 端口已被占：先问占着的服务答不答话。答话就直接打开页面；不答话（卡死了）就确认它是看板服务，
   把它关掉、由本进程接班——双击「打开地铁图.bat」就能修好。 */
function pingExisting(ms) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path: '/api/ping', method: 'POST', timeout: ms }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}
function listenerPid() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'latin1', windowsHide: true, timeout: 10000 });
    for (const line of out.split(/\r?\n/)) {
      const [proto, local, remote, , pid] = line.trim().split(/\s+/);
      if (proto === 'TCP' && local === `${HOST}:${PORT}` && remote === '0.0.0.0:0') return Number(pid) || 0;
    }
  } catch (e) { /* 查不到就当没有 */ }
  return 0;
}
function isBoardServer(pid) {
  try {
    const cmd = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: 'latin1', windowsHide: true, timeout: 15000 });
    return /board-server\.js/i.test(cmd);
  } catch (e) { return false; }
}
let replacing = false;
async function onPortBusy() {
  if (await pingExisting(3000)) {
    console.log('看板服务已在运行，直接打开页面。');
    openBrowser();
    setTimeout(() => process.exit(0), 500);
    return;
  }
  const pid = process.platform === 'win32' ? listenerPid() : 0;
  if (pid && pid !== process.pid && isBoardServer(pid)) {
    console.log(`[${now()}] 旧的看板服务（PID ${pid}）没有响应，已把它关掉，由本窗口接班。`);
    try { process.kill(pid); } catch (e) { /* 已经退了 */ }
    replacing = true;
    takeoverTries = 0;
    setTimeout(() => server.listen(PORT, HOST), 300);
    return;
  }
  // 占着端口的不是看板服务（或查不出来）：不去动它，照旧打开页面。
  console.log(`端口 ${PORT} 被占着，占用者没有响应，也认不出是不是看板服务；照旧打开页面。`);
  openBrowser();
  setTimeout(() => process.exit(0), 500);
}

let takeoverTries = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && (TAKEOVER || replacing) && takeoverTries++ < 40) {
    setTimeout(() => server.listen(PORT, HOST), 250); // 旧服务还在退出，稍等再占端口
    return;
  }
  if (e.code === 'EADDRINUSE' && !replacing) { onPortBusy(); return; }
  console.error('启动失败：' + e.message);
  process.exit(1);
});

server.once('listening', () => {
  disableQuickEdit();
  console.log(`看板服务已启动：${URL_HOME}${TAKEOVER ? '（重启接班）' : ''}`);
  console.log(`台账目录：${ROOT}`);
  console.log('关掉这个窗口就停止服务；页面关掉约 10 分钟后也会自动退出。');
  openBrowser();
});
server.listen(PORT, HOST);

setInterval(() => {
  if (Date.now() - lastSeen > IDLE_EXIT_MS) {
    console.log('长时间没有页面在用，自动退出。');
    process.exit(0);
  }
}, 60 * 1000).unref();
