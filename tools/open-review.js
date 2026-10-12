'use strict';
// 去验收：把某一站的验收界面替用户打开——Godot 跑游戏、没开的服务先开再开网页、打开效果图 / 文档 / 文件夹。
// 进度卡上点「待你验收」= 用户发「去验收 T0xx」，AI 就跑这个脚本（规则在 ~/.claude/CLAUDE.md）。
// 打开方式写在项目页 projects/<项目>.md 的「## 验收怎么打开」一节，一站可写几行、按顺序执行（写法见 PROTOCOL.md 3.1）：
//   - #T097 对照图：D:\…\验收对照\T097-对照.html     （AI 实拍 vs 示意图，先开）
//   - #T097 手机：http://192.168.x.x:8787/           （只打印，手机上开）
//   - #T074 #T075 运行：D:\work\shop\打开看板.bat | http://127.0.0.1:4750/
//   - #T059 godot：F:\godot\MyGame
// 用法：node tools/open-review.js T059              只准备：查文件、查服务、找 Godot，一个窗口都不开（默认）
//       node tools/open-review.js T059 --show       用户同意后才用：真的开到桌面
//       node tools/open-review.js T059 --dry-run    只打印要执行的命令
//       node tools/open-review.js --list            列出待验收的站、各自登记了怎么打开没有
// 输出：能开什么 / 开了什么 + 这站在项目页「待你验收」里的原文，AI 据此给验收标准。
// 退出码：0 准备好 / 都打开了；2 这站还没登记怎么打开（照样打印验收步骤）；1 出错。
// 规矩：用户没同意之前，一个窗口都不开到桌面：
// 默认不开任何窗口；对照图由 AI 在对话里给他看；他回「开到桌面 T0xx」或点卡上「同意，开到桌面」才 --show。
// 「服务」只在没开时才开，不重启用户在用的服务。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const SHOW = argv.includes('--show'); // 用户同意了才开到桌面
const LIST = argv.includes('--list');
const bi = argv.indexOf('--board'); // 测试用：指向看板副本
const ROOT = bi >= 0 ? path.resolve(argv[bi + 1]) : path.resolve(__dirname, '..');
const { buildData } = require(path.join(ROOT, 'tools', 'build-metro.js'));

const GODOT_DIRS = ['F:\\godot', 'D:\\godot', 'E:\\godot', 'C:\\godot', 'C:\\Program Files\\Godot', path.join(os.homedir(), 'Desktop')];
const MAX_STEPS_TEXT = 4000; // 验收步骤原文太长就截断，全文在项目页
const WAIT_SECONDS = Number(process.env.OPEN_REVIEW_WAIT_SECONDS) || 60; // 等服务起来最多几秒（测试时调小）

const say = (s) => process.stdout.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unquote = (s) => String(s || '').trim().replace(/^`|`$/g, '').replace(/^["']|["']$/g, '').trim();

// 「## 标题…」到下一个「## 」之间的行
function section(md, heading) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) out.push(lines[i]);
  return out;
}

// 「- #T074 #T075 运行：路径 | 探活网址」
function recipes(md) {
  const out = [];
  for (const line of section(md, '验收怎么打开')) {
    const m = line.match(/^\s*[-*]\s+((?:#T\d+[\s、，,]*)+)([^：:]+?)\s*[：:]\s*(.+?)\s*$/);
    if (!m) continue;
    const [target, extra] = m[3].split(/\s+\|\s+/);
    out.push({ ids: m[1].match(/T\d+/g), kind: m[2].trim().toLowerCase(), target: unquote(target), extra: unquote(extra), line: line.trim() });
  }
  return out;
}

// 「待你验收」里提到这站的那一条（顶层条目连同它缩进的子条目）
function acceptanceText(md, id) {
  const blocks = [];
  let cur = null;
  for (const l of section(md, '待你验收')) {
    if (/^(\d+\.|[-*])\s/.test(l)) blocks.push((cur = [l]));
    else if (cur && /^\s+\S/.test(l)) cur.push(l);
    else cur = null;
  }
  // 编号要出现在条目开头（标题里），只是顺口提到这站的条目（比如「已本地提交：… #T048 …」）不算
  const text = blocks.filter((b) => new RegExp(`#${id}(?!\\d)`).test(b[0].slice(0, 48))).map((b) => b.join('\n')).join('\n');
  return text.length > MAX_STEPS_TEXT ? `${text.slice(0, MAX_STEPS_TEXT)}\n……（太长截断了，全文在项目页）` : text;
}

function frontmatter(md, key) {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = fm && fm[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  return m ? m[1].replace(/\s+#.*$/, '').trim() : '';
}

// ---------- 打开 ----------

// 统一走 PowerShell Start-Process：中文路径、空格、& 都不用操心转义（命令整段 UTF-16 编码传过去）
function psStart(file, args, { cwd, minimized } = {}) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  let cmd = `Start-Process -FilePath ${q(file)}`;
  if (args && args.length) cmd += ` -ArgumentList ${q(args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '))}`;
  if (cwd) cmd += ` -WorkingDirectory ${q(cwd)}`;
  if (minimized) cmd += ' -WindowStyle Minimized';
  if (DRY) return say(`  （只打印）${cmd}`);
  const ps = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;try{${cmd}}catch{Write-Output $_.Exception.Message;exit 1}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.status !== 0) throw new Error(`打不开 ${file}：${((r.stdout || '') + (r.stderr || '')).trim() || (r.error && r.error.message) || '未知原因'}`);
}

function probe(url, ms = 2000) {
  return new Promise((resolve) => {
    const req = (url.startsWith('https:') ? https : http).get(url, { timeout: ms }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitUp(url) {
  const end = Date.now() + WAIT_SECONDS * 1000;
  while (Date.now() < end) {
    if (await probe(url)) return true;
    await sleep(500);
  }
  return false;
}

function mustExist(p) {
  if (!fs.existsSync(p)) throw new Error(`找不到 ${p}（项目页「验收怎么打开」里写的路径可能过期了）`);
}

const isLocal = (url) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url);
const isScript = (p) => /\.(bat|cmd)$/i.test(p);
const verNum = (v) => v.split('.').map(Number);
const verCmp = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

// 按项目页 engine: 里的版本找 Godot（F:\godot\Godot_v4.6.1-stable_win64.exe 这种），也认环境变量 GODOT_EXE
function findGodot(engine, mono) {
  if (process.env.GODOT_EXE && fs.existsSync(process.env.GODOT_EXE)) return process.env.GODOT_EXE;
  const want = (engine.match(/Godot\s*v?(\d+(?:\.\d+)+)/i) || [])[1] || '';
  const found = [];
  const scan = (dir, depth) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of items) {
      const p = path.join(dir, d.name);
      const m = d.isFile() && d.name.match(/^Godot_v(\d+(?:\.\d+)*)-stable(_mono)?_win64\.exe$/i);
      if (m) found.push({ p, v: m[1], mono: !!m[2] });
      else if (d.isDirectory() && depth > 0 && /godot/i.test(d.name)) scan(p, depth - 1);
    }
  };
  GODOT_DIRS.forEach((d) => scan(d, 1));
  if (!found.length) throw new Error(`找不到 Godot（在 ${GODOT_DIRS.join('、')} 里找过；可设环境变量 GODOT_EXE）`);
  const rank = (g) => (g.v === want ? 4 : want && g.v.startsWith(want.split('.').slice(0, 2).join('.')) ? 2 : 0) + (g.mono === mono ? 1 : 0);
  found.sort((a, b) => rank(b) - rank(a) || verCmp(b.v, a.v));
  return found[0];
}

const KINDS = {
  async 网页(s) {
    if (!DRY && isLocal(s.target) && !(await probe(s.target))) say(`  ⚠ ${s.target} 现在没响应（服务可能没开），照样打开了`);
    psStart(s.target);
    return `网页 ${s.target}`;
  },
  async 文件(s) {
    mustExist(s.target);
    // .md / .txt 这台电脑没有关联程序，直接开会弹「选择打开方式」；用编辑器（Qoder 的 code 命令）开，没有就记事本
    if (/\.(md|txt|log)$/i.test(s.target)) {
      const editor = spawnSync('where', ['code'], { encoding: 'utf8', windowsHide: true }).status === 0 ? 'code' : 'notepad.exe';
      psStart(editor, editor === 'code' ? ['--new-window', s.target] : [s.target]);
      return `文件 ${s.target}（用${editor === 'code' ? '编辑器' : '记事本'}开）`;
    }
    psStart(s.target);
    return `文件 ${s.target}`;
  },
  async 文件夹(s) {
    mustExist(s.target);
    psStart(s.target);
    return `文件夹 ${s.target}`;
  },
  // 每次都跑（适合自己会判断「开着就只开网页、旧版就换新」的启动脚本）；写了探活网址就等它起来
  async 运行(s) {
    mustExist(s.target);
    psStart(s.target, [], { cwd: path.dirname(s.target), minimized: isScript(s.target) });
    if (!s.extra) return `运行 ${s.target}`;
    if (DRY) return `运行 ${s.target}，再等 ${s.extra} 起来`;
    return (await waitUp(s.extra)) ? `运行 ${s.target}，${s.extra} 已起来` : `运行 ${s.target}（⚠ ${WAIT_SECONDS} 秒了 ${s.extra} 还没起来）`;
  },
  // 只在没开时才开（正式服务这种，开着就不碰）
  async 服务(s) {
    if (!s.extra) throw new Error(`「服务」要写成「路径 | 探活网址」：${s.line}`);
    if (!DRY && (await probe(s.extra))) return `服务本来就开着（${s.extra}），没动它`;
    mustExist(s.target);
    psStart(s.target, [], { cwd: path.dirname(s.target), minimized: true });
    if (DRY) return `服务 ${s.target}（没开才开）`;
    return (await waitUp(s.extra)) ? `服务原来没开，已开好：${s.target}` : `服务 ${s.target} 已启动，但 ${WAIT_SECONDS} 秒了 ${s.extra} 还没响应`;
  },
  // AI 实拍 vs 示意图并排的那一页（PROTOCOL 3.1 第 5 条），写在这站第一行、先开
  async 对照图(s) {
    mustExist(s.target);
    psStart(s.target);
    return `对照图 ${s.target}（左示意图、右实拍，下面是 AI 自己对过的差异）`;
  },
  // 要在手机上验的站：只把地址打印给用户，不在电脑上开
  async 手机(s) {
    if (!DRY && !(await probe(s.target))) return `手机上打开：${s.target}（⚠ 这台电脑现在访问不到它，服务可能没开）`;
    return `手机上打开：${s.target}`;
  },
  async godot(s, ctx) { return godot(s, ctx, false); },
  async godot编辑器(s, ctx) { return godot(s, ctx, true); },
};
KINDS.url = KINDS.网页; KINDS.file = KINDS.文件; KINDS.folder = KINDS.文件夹; KINDS.run = KINDS.运行; KINDS.service = KINDS.服务;

// 只准备（默认）：查得到、起得来，但一个窗口都不开，告诉用户同意后会开什么
async function prepare(s, ctx) {
  switch (s.kind) {
    case '对照图':
      mustExist(s.target);
      return `对照图：${s.target}（AI 先在对话里给你看，不占桌面）`;
    case '文件': case 'file':
      mustExist(s.target);
      return `同意后打开文件：${s.target}`;
    case '文件夹': case 'folder':
      mustExist(s.target);
      return `同意后打开文件夹：${s.target}`;
    case '网页': case 'url':
      return `同意后在浏览器打开：${s.target}${isLocal(s.target) && !(await probe(s.target)) ? '（⚠ 现在没响应，服务可能没开）' : ''}`;
    case '运行': case 'run':
      mustExist(s.target);
      return `同意后运行：${s.target}${s.extra ? `（会等 ${s.extra} 起来）` : ''}`;
    case '服务': case 'service':
      if (!s.extra) throw new Error(`「服务」要写成「路径 | 探活网址」：${s.line}`);
      if (await probe(s.extra)) return `服务开着（${s.extra}）`;
      mustExist(s.target);
      return `服务没开：同意后先最小化启动 ${s.target}`;
    case '手机':
      return KINDS.手机(s);
    case 'godot': case 'godot编辑器': {
      mustExist(path.join(s.target, 'project.godot'));
      const mono = fs.readdirSync(s.target).some((f) => f.endsWith('.csproj'));
      const g = findGodot(frontmatter(ctx.md, 'engine'), mono);
      return `同意后 Godot ${g.v} ${s.kind === 'godot' ? '跑游戏' : '开编辑器'}：${s.target}${s.extra ? ` ${s.extra}` : ''}`;
    }
    default:
      throw new Error(`不认识的类型「${s.kind}」：${s.line}`);
  }
}

function godot(s, ctx, editor) {
  mustExist(path.join(s.target, 'project.godot'));
  const mono = fs.readdirSync(s.target).some((f) => f.endsWith('.csproj'));
  const g = findGodot(frontmatter(ctx.md, 'engine'), mono);
  // 测试用：OPEN_REVIEW_GODOT_ARGS="--position 0,30000 --quit-after 300" 让窗口开在屏幕外、自己退出
  const extra = (process.env.OPEN_REVIEW_GODOT_ARGS || '').split(/\s+/).filter(Boolean);
  psStart(g.p, [...(editor ? ['-e'] : []), '--path', s.target, ...(s.extra ? [s.extra] : []), ...extra], { cwd: s.target });
  return `Godot ${g.v} ${editor ? '编辑器' : '跑游戏'}：${s.target}${s.extra ? ` ${s.extra}` : ''}`;
}

// ---------- 主流程 ----------

function stationIndex() {
  const data = buildData(ROOT);
  const byId = new Map();
  for (const l of data.lines) for (const s of l.stations) byId.set(s.id, { ...s, line: l });
  return { data, byId };
}

function projectPage(name) {
  const f = path.join(ROOT, 'projects', `${name}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

const ZH = { done: '已到站', review: '待你验收', doing: '进行中', todo: '未到站', paused: '暂缓', dropped: '停运' };

function list() {
  const { data } = stationIndex();
  for (const l of data.lines) {
    if (l.archived) continue;
    const md = projectPage(l.name);
    const rs = recipes(md);
    for (const s of l.stations.filter((x) => x.state === 'review')) {
      const mine = rs.filter((r) => r.ids.includes(s.id));
      const pic = mine.some((r) => r.kind === '对照图') ? '有对照图' : '缺对照图';
      say(`${s.id}  ${l.name}｜${s.title}  ${mine.length ? `能打开：${mine.map((r) => r.kind).join(' + ')}` : '还没登记怎么打开'}  ${pic}`);
    }
  }
}

async function open(idRaw) {
  const id = idRaw.replace('#', '').toUpperCase();
  const { byId } = stationIndex();
  const st = byId.get(id);
  if (!st) throw new Error(`看板里没有 ${id}`);
  const md = projectPage(st.line.name);
  say(`去验收 ${id} · ${st.line.name} · ${st.title}（${ZH[st.state] || st.state}）`);
  if (st.state !== 'review') say(`  注意：这站现在是「${ZH[st.state] || st.state}」，不是待你验收，照样按登记的方式打开`);
  const steps = recipes(md).filter((r) => r.ids.includes(id));
  let code = 0;
  if (!steps.length) {
    say(`这站还没登记怎么打开（projects/${st.line.name}.md 的「## 验收怎么打开」里没有 #${id}）。`);
    code = 2;
  } else {
    const prep = !SHOW && !DRY;
    say(DRY ? '会这样打开（--dry-run，没真的打开）：'
      : SHOW ? '已开到桌面（你同意了）：'
        : '准备好了，按你的规矩一个窗口都没开（你同意才开到桌面）：');
    for (const s of steps) {
      if (prep) { say(`  - ${await prepare(s, { md })}`); continue; }
      const fn = KINDS[s.kind];
      if (!fn) throw new Error(`不认识的类型「${s.kind}」：${s.line}`);
      say(`  - ${await fn(s, { md })}`);
    }
    if (st.state === 'review' && !steps.some((s) => s.kind === '对照图')) {
      say('  ⚠ 这站没有对照图（转待验收前本该先交「实拍 vs 示意图」，PROTOCOL 3.1 第 5 条），只能凭文字验收');
    }
    if (prep) {
      const pics = steps.filter((s) => s.kind === '对照图').map((s) => s.target);
      if (pics.length) say(`给用户看的对照图（在对话里发，不开窗口）：${pics.join('；')}`);
      if (steps.some((s) => !['对照图', '手机'].includes(s.kind))) {
        say(`要开到桌面：用户回「开到桌面 ${id}」或点卡上「同意，开到桌面」后，再跑 node tools/open-review.js ${id} --show`);
      }
    }
  }
  const text = acceptanceText(md, id);
  say(text ? `\n项目页里这站的验收步骤：\n${text}` : `\n项目页「待你验收」里没找到写着 #${id} 的条目。`);
  return code;
}

(async () => {
  try {
    if (LIST) { list(); process.exit(0); }
    const id = argv.find((a, i) => /^#?T\d+$/i.test(a) && argv[i - 1] !== '--board');
    if (!id) { say('用法：node tools/open-review.js T059 [--show | --dry-run] | --list'); process.exit(1); }
    process.exit(await open(id));
  } catch (e) {
    say(`出错：${e.message || e}`);
    process.exit(1);
  }
})();
