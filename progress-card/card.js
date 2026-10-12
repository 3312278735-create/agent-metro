'use strict';
// 进度卡：Claude Code 全局规则（2026-09-23 用户定，规则写在 ~/.claude/CLAUDE.md）。
// 每次回复末尾，把「当前项目在总看板上的那条地铁线」和 AI 这一轮的「我在做 / 接下来 / 要你关注」画成一张卡。
// 站名、顺序、状态直接调用总看板自己的 tools/build-metro.js 现读，和地铁图是同一份台账。
// 只读，不写任何文件；读不到看板也照样出卡（只有三块文字）。
//
// 用法：
//   bash：  node "<看板目录>/progress-card/card.js" [--text] <<'EOF'
//           {"doing":{"task":"T063","text":"……"},
//            "next":[{"task":"T061","text":"……"},"……"],
//            "you":[{"task":"T060","title":"……","text":"……"}]}
//           EOF
//   只有 PowerShell：先用 Write 工具把 json 存成文件，再 node card.js [--text] <文件>
//           （PowerShell 5.1 往 node 管道里传中文会变成问号）
//   输出：默认是 show_widget 用的 HTML；--text 是没有 show_widget 时贴进回复的几行 Markdown。
//   可选：--cwd <目录>（默认当前目录）  --project <看板项目名>（不按目录找）  --board <看板目录>
// 右栏合成三块（看板#T125）：做完了（验收挂在同编号那条下面）/ 还没完 / 要你定。
// json 可加 asks: [{task, text, done: true|"doing"|false}]（你派的活，做完的标绿）；next / you 的条目加 ai: true = AI 自己建议的（置灰、收进折叠）（看板#T123）
//         --now 2026-10-02T11:30 或 --today 2026-10-02（按哪个时刻算传送带，测试用）；json 可加 names: {"T118": "按钮挪位"} 指定带上方块的短名
// 传送带（2026-09-29）：定了到点日（台账 due:）的站画在卡片顶上的履带上，到点的出「到点了，要你定」，见下面「传送带」一节。
//
// 按目录找线：总看板 projects/*.md 的 path: 是当前目录或它的上级就算（取最长的；同一目录登记了
// 几个项目就几条线都画）。当前目录就是总看板本身时，画所有还在推进的线路的汇总。
// 「待你验收 ↗」是按钮（2026-09-24）：点了替用户发「去验收 T0xx」/「我要验收 <项目>」，AI 再跑总看板 tools/open-review.js。

const fs = require('fs');
const path = require('path');

const DEFAULT_BOARD = path.resolve(__dirname, '..'); // 默认：本文件所在仓库就是看板；也可用 --board 或环境变量 TK_BOARD_DIR 指到别处
const ZH = { done: '已到站', review: '待你验收', doing: '进行中', todo: '未到站', paused: '暂缓', dropped: '停运' };
const SYM = { done: '✓', review: '!', doing: '▶', todo: '○', paused: '‖', dropped: '×' };
// 谁验收的（看板#T157）：auto = AI 替用户验收到站（不太紧要、AI 查得到结果的站），me = 用户亲手验收；旧站没记
const ACC = { auto: '自动验收', me: '人工验收' };
const accOf = (s) => (s.state === 'done' && ACC[s.accept] ? s.accept : '');
const ORDER = ['done', 'review', 'doing', 'todo', 'paused', 'dropped'];
const OPEN = new Set(['review', 'doing', 'todo', 'paused']);
const KEEP_DONE = 2; // 已到站的只列最近几站，免得长线路把卡撑得太长

// 颜色全用宿主的主题变量，深浅色自动跟随；绿 = 到站，橙 = 待你验收，蓝 = 进行中，空心灰 = 未到站（同地铁图）。
const STYLE = `<style>
.pc-r{display:flex;gap:10px}.pc-c{flex:none;width:16px;display:flex;flex-direction:column;align-items:center}
.pc-d{width:14px;height:14px;margin-top:4px;box-sizing:border-box;border-radius:50%;border:2px solid var(--border-stronger)}
.pc-l{flex:1;width:2px;min-height:6px;margin-top:3px;background:var(--border-strong)}
.pc-b{flex:1;min-width:0;display:flex;align-items:flex-start;gap:8px;padding-bottom:8px;font-size:14px;line-height:1.5}
.pc-n{flex:1;min-width:0}.pc-now .pc-n{font-weight:500}.pc-id{font-size:12px;color:var(--text-muted);margin-right:6px}
.pc-k{flex:none;font-size:12px;padding:1px 8px;border-radius:var(--radius);color:var(--text-muted)}.pc-m{flex:none;font-size:12px;color:var(--text-secondary)}
[data-s=done] .pc-d{background:var(--text-success);border-color:var(--text-success)}[data-s=done] .pc-k{background:var(--bg-success);color:var(--text-success)}
[data-s=review] .pc-d{background:var(--text-warning);border-color:var(--text-warning)}[data-s=review] .pc-k{background:var(--bg-warning);color:var(--text-warning)}
[data-s=doing] .pc-d{background:var(--text-accent);border-color:var(--text-accent)}[data-s=doing] .pc-k{background:var(--bg-accent);color:var(--text-accent)}
[data-s=paused] .pc-d{border-style:dashed;border-color:var(--text-secondary)}[data-s=dropped] .pc-d{background:var(--border)}
.pc-box{background:var(--surface-1);border-radius:var(--radius);padding:10px 12px}.pc-warn{background:transparent;border:0.5px solid var(--border-warning)}
.pc-h{font-size:13px;color:var(--text-secondary);margin-bottom:4px}.pc-h i{font-size:16px;vertical-align:-2px;margin-right:4px}
.pc-ol{margin:0;padding-left:1.3em;font-size:14px;line-height:1.6}.pc-t{font-weight:500}.pc-note{font-size:12px;color:var(--text-muted)}
.pc-r .pc-k.pc-here{background:transparent;border:0.5px solid var(--border-accent);color:var(--text-accent)}
.pc-go{cursor:pointer;font:inherit;font-size:12px;line-height:1.5;height:auto;min-height:0;margin:0;padding:1px 8px;border-radius:var(--radius);border:0.5px solid var(--border-warning);background:var(--bg-warning);color:var(--text-warning)}
.pc-go:hover{border-color:var(--text-warning)}.pc-ol .pc-go{margin-left:6px;vertical-align:1px}
.pc-ck{list-style:none;padding-left:0}.pc-ck li{margin:2px 0}.pc-ck input:checked+span,.pc-ck input:checked+details>summary{color:var(--text-muted);text-decoration:line-through}
.pc-it{flex:1;min-width:0}.pc-it summary{cursor:pointer}.pc-it[open]>summary{margin-bottom:2px}.pc-it .pc-dd div{display:inline}
.pc-ck-h{font-size:12px;font-weight:500;color:var(--text-secondary);margin:8px 0 2px}.pc-ck-h:first-child{margin-top:0}
.pc-ck-how{margin:2px 0 4px 21px;font-size:13px;line-height:1.6;color:var(--text-secondary)}.pc-ck-how b{font-weight:500;color:var(--text-primary)}
.pc-dc{list-style:none;padding-left:0}.pc-dc li{margin:2px 0}.pc-dc .pc-ck-how{margin-left:0}.pc-dc .pc-dt{margin-left:0}
.pc-vf{font-size:13px;color:var(--text-secondary)}
.pc-dt{margin:0 0 4px 21px;font-size:12px}.pc-dt summary{cursor:pointer;color:var(--text-accent);width:max-content}
.pc-dd{margin-top:4px;padding:6px 8px;background:var(--surface-1);border-radius:var(--radius);color:var(--text-secondary);line-height:1.6}
.pc-tm{flex:none;font-size:12px;padding:1px 8px;border-radius:var(--radius);border:0.5px solid var(--border);color:var(--text-secondary)}
.pc-tm.soon{border-color:var(--border-warning);color:var(--text-warning)}.pc-tm.late{background:var(--bg-danger);border-color:var(--border-danger);color:var(--text-danger)}
.pc-bwrap{margin-bottom:12px}.pc-bhead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:14px;margin-bottom:4px}
.pc-lg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--text-secondary);margin:0 0 8px}.pc-lg span{display:inline-flex;align-items:center;gap:5px}.pc-sw{width:12px;height:10px;border-radius:3px;border:0.5px solid var(--border-stronger)}
.pc-cv{display:grid;grid-template-columns:92px repeat(8,minmax(0,1fr));column-gap:4px;row-gap:2px}
.pc-st{display:flex;flex-direction:column;justify-content:flex-end;gap:4px;padding-bottom:2px;min-width:0}
.pc-bx{font-size:12px;line-height:1.35;padding:4px 6px;border-radius:var(--radius);border:0.5px solid var(--border-stronger);background:var(--surface-2);color:var(--text-primary);overflow:hidden}
.pc-bx b{display:block;font-weight:500;font-size:11px;color:var(--text-muted)}.pc-bx span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all}
.pc-bx.ask{border-style:dashed}.pc-bx.run{border:1px solid var(--border-accent);background:var(--bg-accent);color:var(--text-accent)}.pc-bx.run b{color:var(--text-accent)}
.pc-bx.rev{border-color:var(--border-warning);background:var(--bg-warning);color:var(--text-warning)}.pc-bx.rev b{color:var(--text-warning)}.pc-bx.pc-bhere{outline:1.5px solid var(--border-accent);outline-offset:1px}
.pc-more{font-size:11px;color:var(--text-muted);text-align:center}
.pc-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--text-accent);margin-left:4px;vertical-align:1px;animation:pc-pl 1.2s ease-in-out infinite}
.pc-ax{text-align:center;font-size:11px;line-height:1.3;color:var(--text-muted)}.pc-ax.soon{color:var(--text-warning)}.pc-ax.end{color:var(--text-danger)}
.pc-bin{grid-row:1/3;grid-column:1/2;align-self:end;border:0.5px dashed var(--border-stronger);border-radius:var(--radius);padding:6px;font-size:12px;line-height:1.5;color:var(--text-secondary);margin-bottom:6px;min-width:0}
.pc-belt{grid-column:2/-1;width:100%;height:auto;display:block}
.pc-trk{fill:none;stroke:var(--border-stronger)}.pc-tread{fill:none;stroke:var(--text-secondary);animation:pc-tr 1.2s linear infinite}
.pc-wh{fill:var(--surface-2);stroke:var(--text-secondary)}.pc-sk{fill:none;stroke:var(--text-muted)}.pc-hub{fill:var(--text-secondary)}
.pc-spin{transform-box:fill-box;transform-origin:center;animation:pc-sp 3.2s linear infinite}.pc-spin.big{animation-duration:4.8s}
@keyframes pc-tr{to{stroke-dashoffset:28}}@keyframes pc-sp{to{transform:rotate(-360deg)}}@keyframes pc-pl{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.pc-tread,.pc-spin,.pc-dot{animation:none}}
@media (max-width:520px){.pc-cv{grid-template-columns:64px repeat(var(--n,8),minmax(0,1fr));column-gap:2px}.pc-cv>.pc-empty{display:none}.pc-bx{font-size:11px;padding:3px 4px}}
.pc-bx.pc-click{cursor:pointer}.pc-bx.pc-click:hover{border-color:var(--text-warning)}
.pc-btns{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px}.pc-btns .pc-go{margin-left:0}
.pc-n .pc-tm{display:inline-block;margin-left:6px;padding:0 6px;line-height:1.5;vertical-align:1px}
.pc-binids{display:flex;flex-wrap:wrap;gap:0 4px;margin-bottom:2px}.pc-binids .pc-id{margin-right:0;color:var(--text-primary)}
.pc-box.t-ask{background:transparent;border:0.5px solid var(--border-success)}.pc-box.t-ask>.pc-h{color:var(--text-success)}
.pc-box.t-doing{background:var(--bg-accent)}.pc-box.t-doing>.pc-h{color:var(--text-accent)}
.pc-box.t-check{background:var(--bg-warning)}.pc-box.t-check>.pc-h{color:var(--text-warning)}
.pc-box.t-next{background:var(--surface-1)}
.pc-box.t-you{background:var(--bg-pro,var(--bg-danger))}.pc-box.t-you>.pc-h{color:var(--text-pro,var(--text-danger))}
.pc-box.t-check .pc-dd{background:var(--surface-2)}
.pc-as{display:inline-block;font-size:12px;line-height:1.5;padding:0 6px;border-radius:var(--radius);margin-left:6px;vertical-align:1px}
.pc-as.done{background:var(--bg-success);color:var(--text-success)}.pc-as.doing{background:var(--bg-accent);color:var(--text-accent)}.pc-as.todo{border:0.5px solid var(--border);color:var(--text-muted)}
.pc-asks li.a-done{color:var(--text-success)}
.pc-fold{margin-top:6px}.pc-fold>summary{cursor:pointer;font-size:12px;color:var(--text-muted);width:max-content}
.pc-fold .pc-ol{font-size:13px;color:var(--text-muted);margin-top:2px}.pc-fold .pc-t{font-weight:400}
.pc-box.t-done{background:var(--bg-success)}.pc-box.t-done>.pc-h{color:var(--text-success)}
.pc-box.pc-inner{background:var(--surface-2);margin:4px 0 6px;padding:8px 10px;color:var(--text-primary)}
.pc-sub{font-size:12px;font-weight:500;color:var(--text-secondary);margin:6px 0 2px}
.pc-nowline{font-size:14px;line-height:1.6;margin-bottom:2px}
.pc-as.rev{background:var(--bg-warning);color:var(--text-warning)}
summary.pc-fh{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px}summary.pc-fh::-webkit-details-marker{display:none}
summary.pc-fh::after{content:"";flex:none;margin-left:auto;width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);opacity:.6;transition:transform .15s}
details:not([open])>summary.pc-fh::after{transform:rotate(-45deg)}
details:not([open])>summary.pc-fh{margin-bottom:0!important}
details.pc-box:not([open]){padding-bottom:10px}
summary.pc-fh .pc-h{margin:0}
.pc-num{font-size:16px;font-weight:500;margin-right:3px}
.pc-lhead{font-size:12px;color:var(--text-muted);margin:0 0 4px}
.pc-strip{position:relative;display:flex;flex-wrap:nowrap;align-items:flex-start;overflow-x:auto;scrollbar-width:none;padding:6px 0 4px;margin:0 0 10px}
.pc-strip::-webkit-scrollbar{display:none}.pc-strip::before,.pc-strip::after{content:"";flex:none;width:50%}
.pc-sp{flex:none;cursor:pointer}
.pc-sp.pick{opacity:1}.pc-sp.pick .pc-sd{outline:2px solid var(--text-accent);outline-offset:1px}
.pc-sp.pick em.pc-sn{max-width:none;color:var(--text-primary)}
.pc-spd{font-size:13px;line-height:1.6;color:var(--text-primary);background:var(--surface-1);border-radius:var(--radius);padding:6px 10px;margin:-4px 0 12px}
.pc-spd .pc-spk{display:block;font-size:13px;color:var(--text-secondary)}.pc-spd .pc-go{margin-left:8px;vertical-align:1px}
.pc-spd .pc-spk b,.pc-spv b{font-weight:500;color:var(--text-primary)}
.pc-spv{margin-top:4px;font-size:13px;line-height:1.6;color:var(--text-secondary)}.pc-spv ol{margin:0;padding-left:1.4em}.pc-spv .pc-t{color:var(--text-primary)}
.pc-spd{padding:8px 12px}.pc-spd[data-s=review]{background:var(--bg-warning)}.pc-spd[data-s=done]{background:var(--bg-success)}.pc-spd[data-s=doing]{background:var(--bg-accent)}
.pc-spd[data-s=review]>b{color:var(--text-warning)}.pc-spd[data-s=done]>b{color:var(--text-success)}.pc-spd[data-s=doing]>b{color:var(--text-accent)}
.pc-spd .pc-spv{background:var(--surface-2);border-radius:var(--radius);padding:6px 10px;margin-top:6px}
.pc-box.pc-bwrap{background:color-mix(in srgb,#1D9E75 13%,var(--surface-1))}.pc-bwrap>summary .pc-t{color:color-mix(in srgb,#1D9E75 70%,var(--text-primary))}
.pc-sp{position:relative;display:inline-flex;flex-direction:column;align-items:center;padding:0 5px;min-width:30px}
.pc-sp::before{content:"";position:absolute;top:5px;left:0;right:0;height:1.5px;background:var(--border-strong)}
.pc-sp:first-child::before{left:50%}.pc-sp:last-child::before{right:50%}
.pc-sd{position:relative;z-index:1;width:7px;height:7px;margin-top:2px;border-radius:50%;box-sizing:border-box;border:1.5px solid var(--border-stronger);background:var(--surface-2)}
.pc-sp em{font-style:normal;font-size:10px;line-height:1.3;color:var(--text-muted);margin-top:3px;white-space:nowrap}
.pc-sp.off{opacity:.65}
.pc-sp em.pc-sn{margin-top:0;max-width:7.5em;overflow:hidden;text-overflow:ellipsis}
.pc-sp.on em.pc-sn{max-width:none;font-size:12px}
.pc-sp.on .pc-sd{width:14px;height:14px;margin-top:-2px;outline:2px solid var(--border-accent);outline-offset:1px}
.pc-sp.on em{font-size:13px;color:var(--text-primary);font-weight:500}
.pc-grp{display:flex;flex:none}.pc-grp>.pc-gi{display:none}.pc-grp.open>.pc-gi{display:flex}.pc-grp.open>.pc-gc{display:none}
.pc-gc,.pc-gx{position:relative;flex:none;display:inline-flex;flex-direction:column;align-items:center;padding:0 5px;cursor:pointer}
.pc-gc::before,.pc-gx::before{content:"";position:absolute;top:5px;left:0;right:0;height:1.5px;background:var(--border-strong)}
.pc-gc b,.pc-gx b{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:20px;height:12px;font-weight:500;font-size:10px;line-height:1;letter-spacing:-1px;border-radius:6px;background:var(--surface-2);border:1.5px solid var(--border-stronger);color:var(--text-secondary)}
.pc-gc em,.pc-gx em{font-style:normal;font-size:10px;line-height:1.3;color:var(--text-muted);margin-top:3px;white-space:nowrap}
.pc-gc:hover b,.pc-gx:hover b{border-color:var(--text-secondary)}
.pc-sp[data-s=done] .pc-sd{background:var(--text-success);border-color:var(--text-success)}
.pc-sp[data-a=auto] .pc-sd{background:var(--surface-2)}
.pc-acc{display:inline-block;margin-left:6px;padding:0 6px;border-radius:5px;font-size:11px;line-height:17px;font-weight:400;color:var(--text-success);vertical-align:1px}.pc-acc-me{background:var(--bg-success)}.pc-acc-auto{border:1px dashed var(--text-success)}
.pc-sp[data-s=review] .pc-sd{background:var(--text-warning);border-color:var(--text-warning)}
.pc-sp[data-s=doing] .pc-sd{background:var(--text-accent);border-color:var(--text-accent)}
.pc-sp[data-s=paused] .pc-sd{border-style:dashed}
.pc-sp.pc-click{cursor:pointer}
</style>`;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const norm = (id) => String(id || '').replace(/#/g, '').toUpperCase().trim();
const item = (x) => (typeof x === 'string' ? { text: x } : x || {});
const idNum = (id) => parseInt(String(id).replace(/\D/g, ''), 10) || 0;
const normPath = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

function parseArgs(argv) {
  const o = { text: false, cwd: process.cwd(), project: '', board: process.env.TK_BOARD_DIR || DEFAULT_BOARD, file: '', today: '', now: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text') o.text = true;
    else if (a === '--cwd') o.cwd = argv[++i];
    else if (a === '--project') o.project = argv[++i];
    else if (a === '--board') o.board = argv[++i];
    else if (a === '--today') o.today = argv[++i];
    else if (a === '--now') o.now = argv[++i];
    else o.file = a;
  }
  return o;
}

function readInput(file) {
  if (file) return Promise.resolve(fs.readFileSync(file, 'utf8'));
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
  });
}

// 总看板 projects/*.md 的 frontmatter：project: 名字，path: 目录（# 后面是注释）。
// related_repo: 下面缩进的 path: 也算这个项目的目录——代码放在另一个仓库的（例如游戏的启动器单独一个仓库），
// 在那边开的会话照样画这个项目的线。
function readProjects(board) {
  const dir = path.join(board, 'projects');
  const out = [];
  const clean = (v) => v.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const fm = fs.readFileSync(path.join(dir, f), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;
    const name = fm[1].match(/^project:[ \t]*(.*)$/m);
    const paths = [...fm[1].matchAll(/^[ \t]*(?:-[ \t]+)?path:[ \t]*(.*)$/gm)].map((m) => clean(m[1])).filter(Boolean);
    if (paths.length) out.push({ name: (name && clean(name[1])) || f.slice(0, -3), paths });
  }
  return out;
}

function resolveScope(opt) {
  let data, projects;
  try {
    const { buildData } = require(path.join(opt.board, 'tools', 'build-metro.js'));
    data = buildData(opt.board);
    projects = readProjects(opt.board);
    loadArrivals(opt.board);
    attachFields(opt.board, data);
  } catch (e) {
    return { mode: 'none', lines: [], note: '读不到总看板，这次只列三块' };
  }
  const byName = (n) => data.lines.find((l) => l.name === n);
  if (opt.project) {
    const l = byName(opt.project);
    return l ? { mode: 'lines', lines: [l] } : { mode: 'none', lines: [], note: `总看板里没有「${opt.project}」这条线` };
  }
  const cwd = normPath(opt.cwd);
  if (within(cwd, normPath(opt.board))) {
    const open = data.lines.filter((l) => !l.archived && l.review + l.doing + l.todo + l.paused > 0);
    return { mode: 'overview', lines: open };
  }
  let best = -1;
  let hits = [];
  for (const p of projects) {
    for (const dir of p.paths) {
      const pp = normPath(dir);
      if (!within(cwd, pp)) continue;
      if (pp.length > best) { best = pp.length; hits = [p]; } else if (pp.length === best && !hits.includes(p)) hits.push(p);
    }
  }
  if (!hits.length) {
    return { mode: 'none', lines: [], note: '这个目录还没在总看板登记，所以画不出线路（到总看板说一句要登记它，就有线路了）' };
  }
  const lines = hits.map((p) => byName(p.name)).filter(Boolean);
  if (!lines.length) return { mode: 'none', lines: [], note: `「${hits.map((p) => p.name).join('、')}」在总看板登记了，但还没有任务` };
  // 同一目录登记了几个项目时，已归档的不画（全都归档了才画）
  const active = lines.filter((l) => !l.archived);
  return { mode: 'lines', lines: active.length ? active : lines };
}

function counts(l) {
  return ORDER.filter((k) => l[k] > 0).map((k) => `${ZH[k]} ${l[k]}`);
}

// 汇总里只数还没到站的：待你验收、进行中、未到站、暂缓
function openCounts(l) {
  return ['review', 'doing', 'todo', 'paused'].filter((k) => l[k] > 0).map((k) => `${ZH[k]} ${l[k]}`);
}

// 同一天到站的几站，按 HISTORY.md 里「→ 已到站」的时刻排先后（最新在上，第一次出现即最近一次）。
// 几站同一天到站时，原来只按日期 + 编号挑，编号小的会被藏掉。
const ARRIVED = new Map();
function loadArrivals(board) {
  try {
    const re = /^- (\d{4}-\d\d-\d\d \d\d:\d\d) #(T\d+) [^｜]*｜[^｜]*→ 已到站/;
    for (const line of fs.readFileSync(path.join(board, 'HISTORY.md'), 'utf8').split(/\r?\n/)) {
      const m = line.match(re);
      if (m && !ARRIVED.has(m[2])) ARRIVED.set(m[2], m[1]);
    }
  } catch { /* 读不到就只按日期 + 编号 */ }
}

// 没到站的全列；已到站的只列最近 KEEP_DONE 站；停运的不列，数量写在底下
function pickStations(l) {
  const done = l.stations.filter((s) => s.state === 'done');
  const at = (s) => ARRIVED.get(norm(s.id)) || '';
  const keep = new Set(done.slice()
    .sort((a, b) => (b.done || '').localeCompare(a.done || '') || at(b).localeCompare(at(a)) || idNum(b.id) - idNum(a.id))
    .slice(0, KEEP_DONE).map((s) => s.id));
  const shown = l.stations.filter((s) => OPEN.has(s.state) || keep.has(s.id));
  const hidden = [];
  const autoHidden = done.filter((s) => !keep.has(s.id) && accOf(s) === 'auto').length;
  if (done.length > keep.size) hidden.push(`已到站 ${done.length - keep.size} 站${autoHidden ? `（其中自动验收 ${autoHidden}）` : ''}`);
  const dropped = l.stations.filter((s) => s.state === 'dropped').length;
  if (dropped) hidden.push(`停运 ${dropped} 站`);
  return { shown, hidden };
}

function urgent(l) {
  return ['review', 'doing', 'paused', 'todo'].find((k) => l[k] > 0) || 'done';
}

// 「待你验收」是按钮：点了替用户在对话框发一句话（show_widget 提供全局 sendPrompt），
// AI 收到「去验收 T0xx」就跑总看板 tools/open-review.js 把验收界面打开（规则在 ~/.claude/CLAUDE.md）。
function goButton(msg, label) {
  const js = `typeof sendPrompt==='function'&&sendPrompt(${JSON.stringify(msg)})`;
  return `<button type="button" class="pc-go" title="${esc(msg)}" onclick="${esc(js)}">${esc(label)}</button>`;
}

function badge(s) {
  return s.state === 'review' ? goButton(`去验收 ${norm(s.id)}`, `${ZH.review} ↗`) : `<span class="pc-k">${ZH[s.state] || esc(s.state)}${accOf(s) ? ` · ${ACC[accOf(s)]}` : ''}</span>`;
}

function row(state, name, id, right, isLast, here, extra = '') {
  return `<div class="pc-r${here ? ' pc-now' : ''}" data-s="${esc(state)}">`
    + `<div class="pc-c"><span class="pc-d"></span>${isLast ? '' : '<span class="pc-l"></span>'}</div>`
    + `<div class="pc-b"><div class="pc-n">${id ? `<span class="pc-id">${esc(id)}</span>` : ''}${esc(name)}${extra}</div>`
    + (here ? '<span class="pc-k pc-here">我在这</span>' : '') + right + '</div></div>';
}

function lineHtml(l, hereId) {
  const picked = pickStations(l);
  const hidden = picked.hidden;
  // 带上的站已经画在上面传送带里，这里不再重复（看板#T124）
  const onBelt = picked.shown.filter((s) => timing(s).onBelt);
  const shown = picked.shown.filter((s) => !timing(s).onBelt);
  const rows = shown.map((s, i) => row(s.state, s.title, s.id, badge(s), i === shown.length - 1, norm(s.id) === hereId, timeChip(s)));
  return `<details class="pc-line"><summary class="pc-h pc-fh" style="margin-bottom:8px">${esc(l.name)} 线路 · ${l.total} 站 · ${esc(counts(l).join(' · '))}</summary>`
    + (onBelt.length ? `<div class="pc-note" style="margin:-4px 0 8px">${onBelt.map((s) => esc(norm(s.id))).join('、')} 在上面传送带里，点方块可去验收</div>` : '')
    + rows.join('\n')
    + (hidden.length ? `<div class="pc-note" style="margin:0 0 8px 26px">另有${esc(hidden.join('、'))}没列出</div>` : '')
    + '</details>';
}

function overviewHtml(lines) {
  const sum = (k) => lines.reduce((n, l) => n + l[k], 0);
  const head = [`${lines.length} 条在推进`, ...['review', 'doing'].filter((k) => sum(k)).map((k) => `${ZH[k]} ${sum(k)}`)];
  // 有待验收的线：「待你验收 N ↗」是按钮，点了发「我要验收 <项目>」，AI 出这条线的卡，再点具体哪一站
  const right = (l) => (l.review ? goButton(`我要验收 ${l.name}`, `${ZH.review} ${l.review} ↗`) : '')
    + `<span class="pc-m">${esc(openCounts(l).filter((x) => !x.startsWith(ZH.review)).join(' · '))}</span>`;
  return `<details class="pc-line"><summary class="pc-h pc-fh" style="margin-bottom:8px">全部线路 · ${esc(head.join(' · '))}</summary>`
    + lines.map((l, i) => row(urgent(l), l.name, '', right(l), i === lines.length - 1, false)).join('\n') + '</details>';
}

// 每块可折叠（看板#T126）：点标题收起 / 展开；默认全部收起
function box(icon, label, body, warn, tone) {
  return `<details class="pc-box${warn ? ' pc-warn' : ''}${tone ? ` t-${tone}` : ''}"><summary class="pc-h pc-fh"><i class="ti ti-${icon}" aria-hidden="true"></i>${label}</summary>${body}</details>`;
}

// reviewIds：卡上各条线里待验收的站；条目带的编号（可写几个，如「T060 T063」）里有待验收的，末尾加「去验收 ↗」
function listHtml(items, withTitle, reviewIds = new Set()) {
  if (!items.length) return '<div style="font-size:14px;color:var(--text-muted)">暂无</div>';
  // ai: true = AI 自己建议的、不是你派的（2026-09-29 用户：给个灰色、先收起）
  const main = items.filter((x) => !item(x).ai);
  const ai = items.filter((x) => item(x).ai);
  const li = (x) => {
    const t = item(x);
    const id = t.task ? `<span class="pc-id">${esc(norm(t.task))}</span>` : '';
    const title = withTitle && t.title ? `<span class="pc-t">${esc(t.title)}</span>：` : '';
    const go = (norm(t.task).match(/T\d+/g) || []).find((x) => reviewIds.has(x));
    return `<li>${id}${title}${esc(t.text)}${go ? goButton(`去验收 ${go}`, '去验收 ↗') : ''}</li>`;
  };
  return (main.length ? `<ol class="pc-ol">${main.map(li).join('')}</ol>` : '')
    + (ai.length ? `<details class="pc-fold"><summary>AI 建议的 ${ai.length} 条（不急，想看再展开）</summary><ol class="pc-ol">${ai.map(li).join('')}</ol></details>` : '');
}

// 你派的活（看板#T123）：asks = [{task, text, done: true | 'doing' | false}]，做完的整行绿色
function asksHtml(asks) {
  if (!asks || !asks.length) return '';
  const st = (d) => (d === true ? ['done', '✓ 完成'] : d === 'doing' ? ['doing', '进行中'] : ['todo', '还没做']);
  const rows = asks.map((x) => {
    const t = item(x);
    const [k, lab] = st(t.done);
    return `<li class="a-${k}">${t.task ? `<span class="pc-id">${esc(norm(t.task))}</span>` : ''}${esc(t.text)}<span class="pc-as ${k}">${lab}</span></li>`;
  }).join('');
  return box('user-check', '你派的活', `<ol class="pc-ol pc-asks">${rows}</ol>`, false, 'ask');
}

// 验收标准（2026-09-24 用户定：去验收时必须告诉他验收啥）：check = {task, items:[…]}，每条「看哪里 → 应该是什么样」。
// 画成带勾选框的清单；勾完点「交验收结果」把勾选情况发回给 AI（check.tasks 可列几站一起交）；末尾写清怎么回。
// 验收标准分三块：
//   items    要你动手验的：每条 {text 验什么, do 怎么做, see 应该看到, why 作用（这一条的目标：做成了能得到什么，一句话）}；do + see 合成一行「怎么验」，不写不对的样子（09-24 用户定）
//            —— 光陈述事实不算标准；没有「怎么做 + 应该看到」的写不进这里
//   decide   要你拍板的：{text 什么事, advice 建议, reply 怎么回}
//   verified 我替你查过的：只是告诉你，不用你验（字符串）
// 旧写法 items:[{text, detail}] 仍然认（detail 当 why）。
const lines = (d) => (Array.isArray(d) ? d : d ? [d] : []).map((l) => `<div>${esc(l)}</div>`).join('');
function checkHtml(check, mode) {
  if (!check) return '';
  const id = norm(check.task);
  const items = (check.items || []).map((x) => {
    const t = item(x);
    const why = t.why || t.detail;
    // 一行「怎么验」，bad 不再显示
    const rows = t.do || t.see
      ? `<div><b>怎么验</b>：${esc(t.do || '')}${t.do && t.see ? '，应该看到 ' : ''}${esc(t.see || '')}　→ 打勾</div>`
      : '';
    // why 只回答「为什么要验这个」（这是什么 / 防的是什么 / 不验会怎样）；顺带的话放 note，另起一行，别混进 why
    // 每条默认收起，只露标题，点下箭头展开怎么验 / 为什么
    // 「为什么要验」改叫「作用」，写成这一条的目标（做成了能得到什么），放在怎么验前面
    const body = (why ? `<div class="pc-dd" style="margin-top:0"><b>作用</b>：${lines(why)}</div>` : '')
      + (rows ? `<div class="pc-ck-how" style="margin-left:0">${rows}</div>` : '')
      + (t.note ? `<div class="pc-ck-how" style="margin-left:0;font-size:12px;color:var(--text-muted)">顺带：${esc(t.note)}</div>` : '');
    return `<li><div style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" style="margin:5px 0 0;flex:none;cursor:pointer">`
      + (body ? `<details class="pc-it"><summary>${esc(t.text)}</summary>${body}</details>` : `<span>${esc(t.text)}</span>`)
      + '</div></li>';
  }).join('');
  const decide = (check.decide || []).map((x) => {
    const t = item(x);
    return `<li><span class="pc-t">${esc(t.text)}</span>${t.advice ? `<div class="pc-ck-how"><b>我的建议</b>：${esc(t.advice)}</div>` : ''}`
      + (t.reply ? `<div class="pc-ck-how"><b>怎么回</b>：${esc(t.reply)}</div>` : '')
      + (t.why ? `<details class="pc-dt"><summary>来龙去脉</summary><div class="pc-dd">${lines(t.why)}</div></details>` : '') + '</li>';
  }).join('');
  const verified = (check.verified || []).map((x) => `<li>${esc(item(x).text)}</li>`).join('');
  // show：同意后要开到桌面的东西（用户规矩：窗口默认不上桌面，他点了才开）→ 按钮发「开到桌面 T0xx」
  const show = (check.show || []).map((x) => esc(item(x).text));
  if (!items && !decide && !verified && !show.length) return '';
  const sec = (title, body, cls) => (body ? `<div class="pc-ck-h">${title}</div><ol class="pc-ol ${cls}">${body}</ol>` : '');
  const how = check.reply || `动手验的都对、拍板的回了 → 回「完成 ${id || 'T0xx'}」；有一条不对 → 直接说第几条、哪里不对，我记下、退回去改`;
  const showHtml = show.length
    ? `<div class="pc-ck-h">要开到桌面的（你点了才开，没点一个窗口都不开）</div><div class="pc-ck-how" style="margin-left:0">${show.join('、')}`
      + ` ${goButton(`开到桌面 ${id || 'T0xx'}`, '同意，开到桌面 ↗')}</div>`
    : '';
  // 勾选框不再是摆设：
  // 底部「交验收结果」按钮把勾选情况发给 AI——全勾 → 「完成 T0xx」；没勾全 → 「验收 T0xx：没勾第几条」。
  const ids = (Array.isArray(check.tasks) && check.tasks.length ? check.tasks : [id || 'T0xx']).map(norm);
  const submit = items
    ? `<div style="margin-top:8px"><button type="button" class="pc-go" onclick="(function(b){var box=b.closest('.pc-box');var cs=[].slice.call(box.querySelectorAll('.pc-ck input[type=checkbox]'));var miss=[];cs.forEach(function(c,i){if(!c.checked)miss.push(i+1)});var ids=${esc(JSON.stringify(ids))};var msg=miss.length?('验收 '+ids.join(' ')+'：第 '+miss.join('、')+' 条没勾（其余勾了）'):ids.map(function(x){return '完成 '+x}).join('，')+'（'+cs.length+' 条全勾了）';if(typeof sendPrompt==='function')sendPrompt(msg);b.textContent='已发：'+msg;})(this)">勾完了，交验收结果 ↗</button></div>`
    : '';
  // 右栏三块（看板#T125）
  if (mode === 'inner') {
    const fold = verified ? `<details class="pc-fold" style="margin-top:8px"><summary>我替你查过的 ${(check.verified || []).length} 条（不用你验，想看再展开）</summary><ol class="pc-ol pc-vf">${verified}</ol></details>` : '';
    return (items || show.length || verified)
      ? `<div class="pc-box pc-inner">${showHtml}${sec('要你动手验的', items, 'pc-ck')}${submit}${fold}<div style="font-size:12px;color:var(--text-secondary);margin-top:6px">${esc(how)}</div></div>`
      : '';
  }
  if (mode === 'decide') return decide ? `<div class="pc-sub">要你拍板${id ? `（${esc(id)}）` : ''}</div><ol class="pc-ol pc-dc">${decide}</ol>` : '';
  return box('checklist', `验收标准${id ? ` · ${esc(id)}` : ''}`,
    showHtml + sec('要你动手验的', items, 'pc-ck') + submit + sec('要你拍板的', decide, 'pc-dc') + (verified ? `<details class="pc-fold" style="margin-top:8px"><summary>我替你查过的 ${(check.verified || []).length} 条（不用你验，想看再展开）</summary><ol class="pc-ol pc-vf">${verified}</ol></details>` : '')
    + `<div style="font-size:13px;color:var(--text-secondary);margin-top:8px">${esc(how)}</div>`, false, 'check');
}

// ---------- 传送带：到点翻篇（2026-09-29 用户定） ----------
// 用户顾不过来的时候，传送带也要能自己转。
// 「底下做个传送带滚动的效果像坦克轮胎样，不在传送带的就不用」「其实是很小的改动，按小时就能做完」（→ 按小时算，验收期两天）。
// 带上的站 = 还没到站（待你验收 / 进行中 / 未到站）且有到点（台账 due:）的站，越靠左越快到点（09-29 用户说刻度反了，改成左近右远、「到点」筐在最左）。
// 带子刻度不等距：3 天+ / 后天 / 明天 / 今天 / 3 小时内 / 2 小时内 / 1 小时内 / 30 分内，这样验收期（天）和 AI 干活（小时）画得进同一条带。
// 还没开工、只有预算（台账 budget:）的站不上带，在带子上方排队。开工时台账自动把到点定成「现在 + 预算」。
// 到点：AI 的站当场收尾（落进「翻篇」）；等你验的过了验收期落进验收筐；等你审定的（ask:）过期按默认开工。
// 默认动作由 AI 按全局规矩（~/.claude/CLAUDE.md「到点翻篇 + 传送带」一节）去做，本脚本只读、只画。
const BELT_STATES = new Set(['review', 'doing', 'todo']);
let NOW = 0; // 毫秒；--now 2026-10-02T11:30 可覆盖（测试用）
let TODAY = '';
let NAMES = {};
let CHECK = null; // 这张卡的验收清单（json 的 check），细线点站时用
let BOARD = ''; // 总看板目录，细线点站时去项目页找「怎么验」
const pad2 = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const clockOf = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const DUE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
// 到点换成毫秒：只写日期的算到那天 24:00（和台账 ledger.js 同一口径）
function dueMs(v) {
  const m = DUE_RE.exec(v || '');
  if (!m) return NaN;
  return m[4] ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime();
}
const dayNum = (iso) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(iso || '');
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
};
const isoPlus = (n) => new Date((dayNum(TODAY) + n) * 86400000).toISOString().slice(0, 10);
function spanMin(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|分|分钟|h|小时|d|天)$/i.exec(String(s || '').trim());
  if (!m) return NaN;
  const k = m[2].toLowerCase();
  return Math.round(parseFloat(m[1]) * (k === 'h' || k === '小时' ? 60 : k === 'd' || k === '天' ? 1440 : 1));
}
// 1 小时 20 分 / 45 分钟 / 2 小时
const fmtSpan = (min) => (min < 60 ? `${min} 分钟` : min % 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min / 60} 小时`);
const prettyDue = (v) => (DUE_RE.test(v || '') ? v.slice(5).replace('T', ' ') : v);

// 台账行尾的字段（budget: 预算、ask: 审定期限）build-metro 没带出来，这里自己读一遍 TODO.md
function attachFields(board, data) {
  try {
    const { eachTask, splitLines } = require(path.join(board, 'tools', 'ledger.js'));
    const { lines } = splitLines(fs.readFileSync(path.join(board, 'TODO.md'), 'utf8'));
    const map = new Map();
    eachTask(lines, (t) => map.set(t.id, t.fields));
    for (const l of data.lines) {
      for (const s of l.stations) {
        const f = map.get(s.id) || {};
        s.ask = f.ask || '';
        s.budget = f.budget || '';
      }
    }
  } catch { /* 读不到就当没有预算和审定期限 */ }
}

function timing(s) {
  const t = {};
  t.left = (dueMs(s.due) - NOW) / 60000; // 离到点还有几分钟；没到点是 NaN
  t.days = dayNum(s.due) - dayNum(TODAY); // 到点那天离今天几天
  t.clock = /T/.test(s.due || '');
  t.askLeft = (dueMs(s.ask) - NOW) / 60000;
  t.budget = spanMin(s.budget);
  const h = s.history || [];
  t.postponed = h.filter((x) => /^延期/.test(x.change)).length;
  // 「撤销误操作」的那次退回不算返工
  t.rework = Math.max(0, h.filter((x) => x.change === '待验收 → 进行中').length
    - h.filter((x) => x.change === '进行中 → 待验收' && /撤销误操作/.test(x.note)).length);
  t.onBelt = BELT_STATES.has(s.state) && !Number.isNaN(t.left);
  t.queued = s.state === 'todo' && !t.onBelt && !Number.isNaN(t.budget); // 排队：还没开工，只有预算
  t.asking = s.state === 'todo' && !Number.isNaN(t.askLeft);
  // 到点落进哪个筐：等你验的 → 验收筐；AI 的站 → 翻篇（AI 当场收尾）
  t.bin = t.onBelt && t.left < 0 ? (s.state === 'review' ? 'check' : 'flip') : '';
  // 要你定：验收期今天到的、返工到第 3 轮的（AI 的站到点不用你定，当场收尾）
  t.decide = t.onBelt && !t.bin && ((s.state === 'review' && t.days <= 0) || t.rework >= 3);
  return t;
}

function overText(min) {
  return min < 60 ? `${Math.max(1, Math.ceil(min))} 分钟` : min < 1440 ? `${Math.floor(min / 60)} 小时` : `${Math.floor(min / 1440)} 天`;
}

function timeText(s, t = timing(s)) {
  const rw = t.rework ? ` · 返工 ${t.rework} 轮` : '';
  if (Number.isNaN(t.left)) return t.queued ? `排队 · 预算 ${fmtSpan(t.budget)}` : '';
  if (s.state === 'review') {
    const txt = t.left < 0 ? `验收超时 ${overText(-t.left)}` : t.days >= 2 ? `验收期还剩 ${t.days} 天` : t.days === 1 ? '验收期明天到' : '验收期今天到';
    return txt + rw;
  }
  if (t.left < 0) return `超时 ${overText(-t.left)}` + rw;
  if (t.days >= 1 || !t.clock) return (t.days >= 2 ? `还剩 ${t.days} 天` : t.days === 1 ? '明天到点' : '今天到点') + rw;
  return `${clockOf(dueMs(s.due))} 到点 · 还剩 ${fmtSpan(Math.max(1, Math.round(t.left)))}` + rw;
}

// 线路列表每站后面的时间小牌；等你审定的多一块「待审定」
function timeChip(s) {
  if (!BELT_STATES.has(s.state)) return '';
  const t = timing(s);
  const ask = t.asking ? '<span class="pc-tm soon">待审定</span>' : '';
  const txt = timeText(s, t);
  if (!txt) return ask;
  const cls = t.left < 0 || t.rework >= 3 ? 'late' : (t.clock ? t.left < 60 : t.days <= 0) ? 'soon' : '';
  return ask + `<span class="pc-tm ${cls}">${esc(t.bin === 'check' ? `${txt} · 在验收筐` : txt)}</span>`;
}

// 带上的小方块只写短名：去掉「手机：」这类短前缀，截到第一个逗号 / 括号；全名在鼠标停上去的提示里。
// 卡片 json 可以给 names: {"T118": "按钮挪位"} 直接指定。
function beltName(s) {
  const over = NAMES[norm(s.id)];
  if (over) return over;
  let n = String(s.title || '').replace(/^[^：]{1,4}：/, '');
  const cut = n.search(/[，,（(；;—]/);
  if (cut >= 2) n = n.slice(0, cut);
  return n;
}

function beltBox(s, t, hereId) {
  const cls = s.state === 'doing' ? 'run' : s.state === 'review' ? 'rev' : 'ask';
  const dot = s.state === 'doing' ? '<i class="pc-dot"></i>' : '';
  const here = norm(s.id) === hereId ? ' pc-bhere' : '';
  const go = s.state === 'review' ? ` onclick="${esc(`typeof sendPrompt==='function'&&sendPrompt(${JSON.stringify(`去验收 ${norm(s.id)}`)})`)}"` : '';
  return `<div class="pc-bx ${cls}${here}${go ? ' pc-click' : ''}"${go} title="${esc(`${norm(s.id)} ${s.title}｜${timeText(s, t)}${go ? '｜点一下去验收' : ''}`)}"><b>${esc(norm(s.id))}${dot}</b><span>${esc(beltName(s))}</span></div>`;
}

// 履带：一圈虚线沿跑道形路径往前走（上面往右、下面往左），里面的轮子跟着转，像坦克履带。
const TRACK = 'M34 8H526A20 20 0 0 1 526 48H34A20 20 0 0 1 34 8Z';
const bigWheel = (x) => `<g class="pc-spin big"><circle cx="${x}" cy="28" r="15" class="pc-wh" stroke-width="2"/>`
  + `<path d="M${x} 15V41M${x - 13} 28H${x + 13}M${x - 9} 19L${x + 9} 37M${x + 9} 19L${x - 9} 37" class="pc-sk" stroke-width="1.5"/>`
  + `<circle cx="${x}" cy="28" r="4" class="pc-hub"/></g>`;
const wheel = (x) => `<g class="pc-spin"><circle cx="${x}" cy="28" r="11" class="pc-wh" stroke-width="2"/>`
  + `<path d="M${x} 18V38M${x - 10} 28H${x + 10}" class="pc-sk" stroke-width="1.5"/></g>`;
const BELT_SVG = `<svg class="pc-belt" viewBox="0 0 560 56" aria-hidden="true"><path d="${TRACK}" class="pc-trk" stroke-width="9"/>`
  + `<path d="${TRACK}" class="pc-tread" stroke-width="9" stroke-dasharray="9 5"/>`
  + bigWheel(34) + bigWheel(526) + [96, 157, 219, 280, 342, 403, 465].map(wheel).join('') + '</svg>';

// 刻度：左边远、右边近；右端过去就是「到点」筐
const BUCKETS = [
  { label: '3 天+', sub: () => `${isoPlus(3).slice(5)} 起` },
  { label: '后天', sub: () => isoPlus(2).slice(5) },
  { label: '明天', sub: () => isoPlus(1).slice(5) },
  { label: '今天', sub: () => '3 小时后' },
  { label: '3 小时内', sub: () => `${clockOf(NOW + 180 * 60000)} 前` },
  { label: '2 小时内', sub: () => `${clockOf(NOW + 120 * 60000)} 前` },
  { label: '1 小时内', sub: () => `${clockOf(NOW + 60 * 60000)} 前`, cls: 'soon' },
  { label: '30 分内', sub: () => `${clockOf(NOW + 30 * 60000)} 前`, cls: 'end' },
];
function bucketOf(t) {
  if (t.left < 30) return 7;
  if (t.left < 60) return 6;
  if (t.left < 120) return 5;
  if (t.left < 180) return 4;
  if (t.days >= 3) return 0;
  if (t.days === 2) return 1;
  if (t.days === 1) return 2;
  return 3;
}

function lineTimings(l) {
  return l.stations.map((s) => ({ s, t: timing(s) }));
}

// 总看板目录里（汇总模式）没有单独一条线：把所有在推进的线的站合成一条带
function allLine(lines) {
  return { name: '全部线路', stations: lines.flatMap((l) => l.stations) };
}

function beltHtml(l, hereId) {
  const all = lineTimings(l);
  const on = all.filter((x) => x.t.onBelt);
  const queued = all.filter((x) => x.t.queued);
  if (!on.length && !queued.length) return '';
  const cols = BUCKETS.map(() => []);
  const bins = { check: [], flip: [] };
  for (const x of on) {
    if (x.t.left < 0) bins[x.t.bin].push(x);
    else cols[bucketOf(x.t)].push(x);
  }
  // 同一格叠起来：正在做的压在最下面（贴着履带），其次等你验的，没开工的在上面；一格最多叠 3 块
  const rank = { doing: 0, review: 1, todo: 2 };
  for (const c of cols) c.sort((a, b) => rank[b.s.state] - rank[a.s.state] || b.t.left - a.t.left);
  const tall = Math.min(3, Math.max(1, ...cols.map((c) => c.length)));
  const minH = tall * 40 + (cols.some((c) => c.length > 3) ? 18 : 0);
  const empty = cols.map((c, i) => !c.length && i !== cols.length - 1);
  const shownCols = empty.filter((e) => !e).length;
  const colHtml = cols.map((c, i) => {
    const more = c.length > 3 ? `<div class="pc-more">+${c.length - 3}</div>` : '';
    return `<div class="pc-st${empty[i] ? ' pc-empty' : ''}" style="min-height:${minH}px">${more}${c.slice(-3).map((x) => beltBox(x.s, x.t, hereId)).join('')}</div>`;
  });
  const axis = BUCKETS.map((b, i) => `<div class="pc-ax${b.cls ? ` ${b.cls}` : ''}${empty[i] ? ' pc-empty' : ''}">${b.label}<br>${b.sub()}</div>`);
  const ids = (arr) => arr.map((x) => `<span class="pc-id" title="${esc(x.s.title)}">${esc(norm(x.s.id))}</span>`).join('');
  const binRow = (label, arr) => `<div>${label} ${arr.length}</div>` + (arr.length ? `<div class="pc-binids">${ids(arr)}</div>` : '');
  const bin = '<div class="pc-bin"><div class="pc-t" style="color:var(--text-primary)">到点</div>'
    + binRow('验收筐', bins.check) + binRow('翻篇', bins.flip)
    + '<div class="pc-note" style="margin-top:2px">没处理的落这里，不挡后面</div></div>';
  const legend = '<div class="pc-lg"><span><i class="pc-sw" style="background:var(--bg-accent);border-color:var(--border-accent)"></i>正在做</span>'
    + '<span><i class="pc-sw" style="background:var(--bg-warning);border-color:var(--border-warning)"></i>等你验（验收期两天）</span>'
    + '<span><i class="pc-sw" style="border-style:dashed"></i>还没开工</span>'
    + '<span style="color:var(--text-muted)">越靠左越快到点</span></div>';
  const queue = queued.length
    ? `<div class="pc-note" style="margin:-4px 0 6px">排队（开工才计时）：${queued.map((x) => `${esc(norm(x.s.id))} ${esc(beltName(x.s))} ${esc(fmtSpan(x.t.budget))}${x.t.asking ? '（待审定）' : ''}`).join('、')}</div>`
    : '';
  const first = on.slice().sort((a, b) => a.t.left - b.t.left)[0];
  const hot = first ? ` · 最急 ${esc(norm(first.s.id))} ${esc(beltName(first.s))}（${esc(timeText(first.s, first.t))}）` : '';
  return `<details class="pc-box pc-bwrap"><summary class="pc-bhead pc-fh"><span class="pc-t">${on.length} 站在传送带上 · ${esc(l.name)}${hot}</span>`
    + `<span class="pc-note">现在 ${TODAY.slice(5)} ${clockOf(NOW)}</span></summary>${legend}${queue}`
    + `<div class="pc-cv" style="--n:${shownCols}">${colHtml.slice().reverse().join('')}${bin}${BELT_SVG}<div></div>${axis.slice().reverse().join('')}</div></details>`;
}

// 「到点了，要你定」：等你审定的（按期限分组）+ 到点 AI 当场收尾的（一行）+ 验收期今天到 / 返工到第 3 轮的（每站三个按钮）
function decideHtml(lines, inner) {
  const all = lines.flatMap(lineTimings);
  const asks = all.filter((x) => x.t.asking);
  const late = all.filter((x) => x.t.bin === 'flip');
  const pick = all.filter((x) => x.t.decide);
  if (!asks.length && !late.length && !pick.length) return '';
  const li = [];
  const byDay = new Map();
  for (const x of asks) { if (!byDay.has(x.s.ask)) byDay.set(x.s.ask, []); byDay.get(x.s.ask).push(x); }
  for (const [day, xs] of [...byDay.entries()].sort()) {
    const ids = xs.map((x) => norm(x.s.id));
    const when = xs[0].t.askLeft < 0 ? '审定期已过：AI 这次就按站上写好的默认方案开工'
      : `${prettyDue(day)} 前不回，就按站上写好的默认方案开工`;
    li.push(`<li><span class="pc-t">等你审定</span>：${ids.map((x) => `<span class="pc-id">${esc(x)}</span>`).join('')}`
      + `<div class="pc-ck-how">${esc(when)}（要删东西、动你手摆的配置、跑真模型评测的，还是等你）</div>`
      + `<div class="pc-btns">${goButton(`审定通过 ${ids.join(' ')}`, '都同意，开工 ↗')}</div></li>`);
  }
  if (late.length) {
    li.push(`<li><span class="pc-t">到点，AI 当场收尾</span>：${late.map((x) => `<span class="pc-id" title="${esc(x.s.title)}">${esc(norm(x.s.id))}</span>`).join('')}`
      + '<div class="pc-ck-how">按现状交：能到站的到站，没做完的拆成新站排到线尾。想多给时间回「延期 T0xx」（每站一次），不要了回「停运 T0xx」</div></li>');
  }
  // 验收期今天到的并成一行，每站一个「去验收」；返工到第 3 轮的才每站三个按钮
  const today = pick.filter((x) => x.s.state === 'review' && x.t.rework < 3);
  if (today.length) {
    li.push(`<li><span class="pc-t">验收期今天到</span>：${today.map((x) => `<span class="pc-id" title="${esc(x.s.title)}">${esc(norm(x.s.id))} ${esc(beltName(x.s))}</span>`).join('')}`
      + '<div class="pc-ck-how">今天过完没验的落进验收筐，不挡后面的站，有空再验。想直接收下回「翻篇 T0xx」，要多给两天回「延期 T0xx」，不做了回「停运 T0xx」</div>'
      + `<div class="pc-btns">${today.map((x) => goButton(`去验收 ${norm(x.s.id)}`, `去验收 ${norm(x.s.id)} ↗`)).join('')}</div></li>`);
  }
  for (const { s, t } of pick.filter((x) => !today.includes(x))) {
    const id = norm(s.id);
    const dflt = s.state === 'review' ? '验收期过了没验就落进验收筐，不挡后面的站，有空再验' : '这一轮改完就按现状交，新意见另开站';
    const btns = [goButton(`翻篇 ${id}`, '翻篇 ↗'), t.postponed ? '' : goButton(`延期 ${id}`, '延一次 ↗'), goButton(`停运 ${id}`, '停运 ↗')].join('');
    li.push(`<li><span class="pc-id">${esc(id)}</span><span class="pc-t">${esc(beltName(s))}</span>：退回第 ${t.rework} 次了，按规矩要你定——收下就点「翻篇」${t.postponed ? '（已延过一次）' : '，再给一次时间点「延一次」'}，不做了点「停运」`
      + `<div class="pc-ck-how">不选的话：${esc(dflt)}</div><div class="pc-btns">${btns}</div></li>`);
  }
  const ol = `<ol class="pc-ol pc-dc">${li.join('')}</ol>`;
  return inner ? ol : box('clock', '到点了，要你定', ol, true);
}

function beltText(l) {
  const all = lineTimings(l);
  const on = all.filter((x) => x.t.onBelt).sort((a, b) => a.t.left - b.t.left);
  const queued = all.filter((x) => x.t.queued);
  if (!on.length && !queued.length) return [];
  const groups = new Map();
  for (const x of on) {
    const k = x.t.left < 0 ? (x.t.bin === 'check' ? '验收筐' : '翻篇') : BUCKETS[bucketOf(x.t)].label;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(norm(x.s.id));
  }
  const tail = queued.length ? `；排队 ${queued.map((x) => `${norm(x.s.id)}(${fmtSpan(x.t.budget)})`).join(' ')}` : '';
  return [`传送带（${on.length} 站在带上）：${[...groups].map(([k, ids]) => `${k} ${ids.join(' ')}`).join('；')}${tail}`];
}

function decideText(lines) {
  const all = lines.flatMap(lineTimings);
  const out = [];
  const asks = all.filter((x) => x.t.asking);
  const waiting = asks.filter((x) => x.t.askLeft >= 0);
  const overdue = asks.filter((x) => x.t.askLeft < 0).map((x) => norm(x.s.id));
  if (waiting.length) out.push(`- **等你审定**：${waiting.map((x) => `${norm(x.s.id)}（${prettyDue(x.s.ask)} 前）`).join('、')}，不回就按站上写好的默认方案开工；都同意回「审定通过 ${waiting.map((x) => norm(x.s.id)).join(' ')}」`);
  if (overdue.length) out.push(`- **审定期已过**：${overdue.join(' ')}，AI 这次就按站上写好的默认方案开工`);
  const late = all.filter((x) => x.t.bin === 'flip').map((x) => norm(x.s.id));
  if (late.length) out.push(`- **到点，AI 当场收尾**：${late.join(' ')}；想多给时间回「延期 T0xx」，不要了回「停运 T0xx」`);
  const today = all.filter((x) => x.t.decide && x.s.state === 'review' && x.t.rework < 3);
  if (today.length) out.push(`- **验收期今天到**：${today.map((x) => `${norm(x.s.id)} ${beltName(x.s)}`).join('、')}；今天过完没验的落进验收筐。直接收下回「翻篇 T0xx」，多给两天回「延期 T0xx」，不做了回「停运 T0xx」`);
  for (const { s, t } of all.filter((x) => x.t.decide && !today.includes(x))) {
    const id = norm(s.id);
    out.push(`- **要你定 ${id} ${beltName(s)}**（${timeText(s, t)}）：回「翻篇 ${id}」${t.postponed ? '' : `「延期 ${id}」`}「停运 ${id}」，不回就按默认走`);
  }
  return out;
}

function stampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 右栏合成三块（看板#T125）：
//   做完了（绿）：asks 里 done:true 的；check 的站挂在同编号那条下面（没有同编号的就单列一条「T0xx 待你验收」）
//   还没完（蓝）：正在做（doing）+ 没完成的 asks + 接下来（next）；asks 全做完、也没有 next 时整块不出
//   要你定（紫）：传送带到点 / 等你审定 + 验收里「要你拍板的」+ you（验收标准里已有的站不重复）
function rightHtml(scope, now, hereId, reviewIds) {
  const asks = (now.asks || []).map(item);
  const check = now.check;
  const checkIds = new Set(check ? [check.task, ...(check.tasks || [])].map(norm).filter(Boolean) : []);
  const idsOf = (t) => norm(t.task).match(/T\d+/g) || [];
  const idHtml = (t) => (t.task ? `<span class="pc-id">${esc(norm(t.task))}</span>` : '');
  const inner = check ? checkHtml(check, 'inner') : '';
  let placed = !inner;
  const doneLi = asks.filter((t) => t.done === true).map((t) => {
    const here = !placed && idsOf(t).some((i) => checkIds.has(i));
    if (here) placed = true;
    // 同一份验收清单管几站（check.tasks）时，其余几站也标「待你验收」
    const also = !here && inner && idsOf(t).some((i) => checkIds.has(i));
    return `<li class="a-done">${idHtml(t)}${esc(t.text)}${here ? `<span class="pc-as rev">待你验收</span>${inner}` : also ? '<span class="pc-as rev">待你验收（和上面一起验）</span>' : '<span class="pc-as done">✓ 完成</span>'}</li>`;
  });
  if (!placed) doneLi.push(`<li>${check.task ? `<span class="pc-id">${esc(norm(check.task))}</span>` : ''}<span class="pc-as rev" style="margin-left:0">待你验收</span>${inner}</li>`);
  const b1 = doneLi.length ? box('circle-check', `<b class="pc-num">${doneLi.length}</b>件 完成`, `<ol class="pc-ol pc-asks">${doneLi.join('')}</ol>`, false, 'done') : '';

  const doing = item(now.doing);
  const undone = asks.filter((t) => t.done !== true);
  const next = now.next || [];
  let b2 = '';
  if (undone.length || next.length) {
    // 正在做的站已经在「做完了」里，就不再写「正在做」
    const doingDone = hereId && asks.some((t) => t.done === true && idsOf(t).includes(hereId));
    const nowLine = doing.text && !doingDone ? `<div class="pc-nowline"><span class="pc-t">正在做</span>：${hereId ? `<span class="pc-id">${esc(hereId)}</span>` : ''}${esc(doing.text)}</div>` : '';
    const undoneHtml = undone.length
      ? `<ol class="pc-ol pc-asks">${undone.map((t) => `<li>${idHtml(t)}${esc(t.text)}<span class="pc-as ${t.done === 'doing' ? 'doing' : 'todo'}">${t.done === 'doing' ? '进行中' : '还没做'}</span></li>`).join('')}</ol>`
      : '';
    const nextHtml = next.length ? `<div class="pc-sub">接下来</div>${listHtml(next, false)}` : '';
    b2 = box('player-play', `<b class="pc-num">${undone.length + next.filter((x) => !item(x).ai).length}</b>件 还没完`, nowLine + undoneHtml + nextHtml, false, 'doing');
  }

  const you = (now.you || []).filter((x) => { const ids = idsOf(item(x)); return !(ids.length && ids.every((i) => checkIds.has(i))); });
  const beltDecide = scope.mode !== 'none' ? decideHtml(scope.lines, true) : '';
  const nDecide = (beltDecide.match(/<li>/g) || []).length + (check && check.decide ? check.decide.length : 0) + you.filter((x) => !item(x).ai).length;
  const parts = [
    beltDecide,
    check ? checkHtml(check, 'decide') : '',
    you.length ? listHtml(you, true, reviewIds) : '',
  ].filter(Boolean);
  const b3 = parts.length ? box('bell', `<b class="pc-num">${nDecide}</b>件 要你定`, parts.join(''), false, 'you') : '';
  if (!b1 && !b2 && !b3) return box('player-play', '正在做', `<div class="pc-nowline">${esc(doing.text || '无')}</div>`, false, 'doing');
  return [b1, b2, b3].filter(Boolean).join('\n');
}

// 等你验的站，点开详情要写「怎么验」（看板#T130）：光有「去验收」按钮等于没有详情
// 先用这张卡 check 里的清单（最新）；没有就去项目页「待你验收」里找这一站那一条：有编号的逐条取「怎么验」，老写法一段话就按「；」拆开
function reviewSteps(l, id) {
  const c = CHECK;
  if (c && (c.items || []).length && [c.task, ...(c.tasks || [])].map(norm).includes(id)) {
    return c.items.map((x) => {
      const t = item(x);
      return { title: t.text || '', how: [t.do, t.see].filter(Boolean).join('，应该看到 ') };
    });
  }
  let md = '';
  try { md = fs.readFileSync(path.join(BOARD, decodeURIComponent(l.page || '')), 'utf8'); } catch (e) { return []; }
  const rows = md.split(/\r?\n/);
  const top = rows.findIndex((r) => /^##\s*待你验收/.test(r));
  if (top < 0) return [];
  const hit = new RegExp(`^-\\s.*#${id}(?!\\d)`);
  let i = top + 1;
  while (i < rows.length && !/^##\s/.test(rows[i]) && !hit.test(rows[i])) i++;
  if (i >= rows.length || !hit.test(rows[i])) return [];
  const entry = [rows[i]];
  for (let k = i + 1; k < rows.length && /^\s+\S/.test(rows[k]); k++) entry.push(rows[k]);
  const clean = (x) => x.replace(/\*\*|`/g, '').trim().replace(/[。．]$/, '');
  const nums = entry.filter((r) => /^\s+\d+\.\s/.test(r)).map((r) => {
    const body = r.replace(/^\s+\d+\.\s+/, '');
    const m = /^\*\*(.+?)\*\*[。．.]?\s*(.*)$/.exec(body);
    const rest = m ? m[2] : body;
    const how = /怎么验[：:]\s*(.*)$/.exec(rest);
    return { title: m ? clean(m[1]) : '', how: clean(how ? how[1] : rest) };
  });
  if (nums.length) return nums;
  const main = entry[0].replace(/^-\s*(\*\*.*?\*\*)?\s*(——|[：:])?\s*/, '').replace(/都对\s*→.*$/, '');
  return main.split(/[；;]/).map((x) => clean(x)).filter(Boolean).map((x) => ({ title: '', how: x }));
}

// 线路横放最顶上（看板#T128）：rel = 这次回复里提到的站编号
function stripHtml(l, rel) {
  const { shown, hidden } = pickStations(l);
  const one = (s) => {
    const id = norm(s.id);
    const on = rel.has(id);
    // 点一下展开的详情：站名 + 去验收，下面一句「做什么」（看板#T130）
    // 不写状态 / 剩余时间 / 返工几轮
    // 只取第一句（到第一个分号），去掉括号里的补充，免得一长串看不懂
    const what = String(s.text || '').split('——').slice(1).join('——').split(/[；;]/)[0].replace(/（[^）]*）|\([^)]*\)/g, '').trim();
    const steps = s.state === 'review' ? reviewSteps(l, id) : [];
    const how = s.state !== 'review' ? ''
      : steps.length
        ? `<div class="pc-spv"><b>怎么验</b><ol>${steps.map((x) => `<li>${x.title ? `<span class="pc-t">${esc(x.title)}</span>${x.how ? '：' : ''}` : ''}${esc(x.how)}</li>`).join('')}</ol></div>`
        : '<div class="pc-spv"><b>怎么验</b>：项目页还没写，点「去验收」我先补上</div>';
    const acc = accOf(s);
    const detail = `<b>${esc(id)}</b> ${esc(s.title)}`
      + (acc ? `<span class="pc-acc pc-acc-${acc}">${ACC[acc]}</span>` : '')
      + (s.state === 'review' ? goButton(`去验收 ${id}`, '去验收 ↗') : '')
      + (what ? `<span class="pc-spk"><b>做什么</b>：${esc(what)}</span>` : '')
      + how;
    return `<span class="pc-sp ${on ? 'on' : 'off'}" data-s="${esc(s.state)}"${acc ? ` data-a="${acc}"` : ''} title="${esc(`${id} ${s.title}${acc ? `（${ACC[acc]}）` : ''}｜点一下看详情`)}" data-html="${esc(detail)}" onclick="window.pcPick&amp;&amp;pcPick(this)"><i class="pc-sd"></i><em>${esc(id)}</em><em class="pc-sn">${esc(beltName(s))}</em></span>`;
  };
  // 和这次回复无关、连着 2 站以上的，收成一个「⋯ N 站」，点开才展开（看板#T130 返工）
  const anyRel = shown.some((x) => rel.has(norm(x.id)));
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    if (!anyRel || run.length < 2) out.push(...run.map(one));
    else {
      out.push(`<span class="pc-grp"><span class="pc-gc" title="${esc(`${run.map((x) => norm(x.id)).join(' ')}｜点开看这 ${run.length} 站`)}" onclick="window.pcOpen&amp;&amp;pcOpen(this)"><b>⋯</b><em>${run.length} 站</em></span>`
        + `<span class="pc-gi">${run.map(one).join('')}<span class="pc-gx" title="收起这 ${run.length} 站" onclick="window.pcShut&amp;&amp;pcShut(this)"><b>‹</b><em>收起</em></span></span></span>`);
    }
    run = [];
  };
  for (const x of shown) {
    if (rel.has(norm(x.id))) { flush(); out.push(one(x)); } else run.push(x);
  }
  flush();
  return `<div class="pc-lhead">${esc(l.name)} 线路 · ${l.total} 站 · ${esc(counts(l).join(' · '))}${hidden.length ? ` · 另有${esc(hidden.join('、'))}没画` : ''} · 点站看详情，点「⋯」展开</div>`
    + `<div class="pc-strip">${out.join('')}</div><div class="pc-spd" hidden></div>`;
}

function relatedIds(now) {
  const rel = new Set();
  const add = (t) => (norm(t).match(/T\d+/g) || []).forEach((i) => rel.add(i));
  add(item(now.doing).task);
  (now.asks || []).forEach((x) => add(item(x).task));
  if (now.check) { add(now.check.task); (now.check.tasks || []).forEach(add); }
  (now.next || []).forEach((x) => { if (!item(x).ai) add(item(x).task); });
  (now.you || []).forEach((x) => { if (!item(x).ai) add(item(x).task); });
  return rel;
}

// 点细线上的站：展开详情、自动滑到正中；出卡时把这次提到的最后一站滑到正中（看板#T130）
const PICK_JS = '<script>'
  // 细线两头各垫半个宽度（见样式 .pc-strip::before/::after），最左、最右的站也能滑到正中；线短时站点也落在正中
  // （看板#T130）
  + 'window.pcAt=function(s,l,w,now){var q=s.getBoundingClientRect(),x=Math.round(s.scrollLeft+(l-q.left)-(s.clientWidth-w)/2);'
  + 'clearTimeout(s.pcT);if(!now&&s.scrollTo){s.scrollTo({left:x,behavior:"smooth"});'
  + 's.pcT=setTimeout(function(){if(Math.abs(s.scrollLeft-x)>1)s.scrollLeft=x},450)}else s.scrollLeft=x};'
  + 'window.pcCenter=function(s,el,now){var r=el.getBoundingClientRect();pcAt(s,r.left,r.width,now)};'
  + 'window.pcPick=function(el){var s=el.closest(".pc-strip"),d=s.nextElementSibling,was=el.classList.contains("pick");'
  + '[].forEach.call(s.querySelectorAll(".pc-sp"),function(c){c.classList.remove("pick")});'
  + 'if(was){d.hidden=true}else{el.classList.add("pick");d.innerHTML=el.getAttribute("data-html");d.setAttribute("data-s",el.getAttribute("data-s")||"");d.hidden=false}pcCenter(s,el)};'
  + 'window.pcOpen=function(c){var g=c.parentNode;g.classList.add("open");pcCenter(g.closest(".pc-strip"),g)};'
  + 'window.pcShut=function(x){var g=x.closest(".pc-grp");g.classList.remove("open");pcCenter(g.closest(".pc-strip"),g)};'
  // 出卡时摆到正中：点开过的站 → 这次说到的最后一站 → 都没有就整条线；窗口变宽变窄再摆一次
  + 'window.pcHome=function(){[].forEach.call(document.querySelectorAll(".pc-strip"),function(s){'
  + 'var p=s.querySelector(".pc-sp.pick"),on=s.querySelectorAll(".pc-sp.on"),el=p&&p.getClientRects().length?p:on[on.length-1];'
  + 'if(el)return pcCenter(s,el,1);'
  + 'var a=s.firstElementChild,b=s.lastElementChild;if(a){var l=a.getBoundingClientRect().left;pcAt(s,l,b.getBoundingClientRect().right-l,1)}})};'
  + 'pcHome();setTimeout(pcHome,300);var pcW=window.innerWidth;'
  + 'window.addEventListener("resize",function(){if(window.innerWidth!==pcW){pcW=window.innerWidth;pcHome()}});'
  + '</script>';

function renderHtml(scope, now) {
  const hereId = norm(item(now.doing).task);
  const doing = item(now.doing);
  const you = now.you || [];
  const reviewIds = new Set(scope.lines.flatMap((l) => l.stations.filter((s) => s.state === 'review').map((s) => norm(s.id))));
  const left = scope.mode === 'overview' ? overviewHtml(scope.lines)
    : scope.mode === 'lines' ? scope.lines.map((l) => lineHtml(l, hereId)).join('<div style="height:10px"></div>')
      : '';
  const where = scope.mode === 'overview' ? '全部线路'
    : scope.mode === 'lines' ? scope.lines.map((l) => `${l.name}：${l.total} 站，${counts(l).join('、')}`).join('；')
      : scope.note;
  const asks = now.asks || [];
  // 验收标准里已经有的站，「要你关注」不再重复（看板#T124）
  const checkIds = new Set(now.check ? [now.check.task, ...(now.check.tasks || [])].map(norm).filter(Boolean) : []);
  const youShown = you.filter((x) => { const ids = norm(item(x).task).match(/T\d+/g) || []; return !(ids.length && ids.every((i) => checkIds.has(i))); });
  const summary = `进度卡。${where}。`
    + (asks.length ? `你派的活：${asks.map((x) => `${item(x).text}${item(x).done === true ? '（完成）' : item(x).done === 'doing' ? '（进行中）' : '（还没做）'}`).join('；')}。` : '')
    + `我在做：${doing.text || '无'}。`
    + (you.length ? `要你关注：${you.map((x) => item(x).title || item(x).text).join('；')}。` : '');
  const right = rightHtml(scope, now, hereId, reviewIds);
  const foot = scope.mode === 'none'
    ? `${esc(scope.note)} · ${stampNow()}`
    : `站名和状态取自总看板（和地铁图同一份台账） · ${stampNow()} 生成`;
  return [
    STYLE,
    `<h2 class="sr-only">${esc(summary)}</h2>`,
    scope.mode === 'lines' ? scope.lines.map((l) => stripHtml(l, relatedIds(now))).join('') : '',
    scope.mode === 'lines' ? scope.lines.map((l) => beltHtml(l, hereId)).join('') : scope.mode === 'overview' ? beltHtml(allLine(scope.lines), hereId) : '',
    left && scope.mode !== 'lines'
      ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px 24px;padding:4px 0"><div>${left}</div><div style="display:flex;flex-direction:column;gap:10px">${right}</div></div>`
      : `<div style="display:flex;flex-direction:column;gap:10px;padding:4px 0">${right}</div>`,
    `<div class="pc-note" style="margin-top:6px">${foot}</div>`,
    scope.mode === 'lines' ? PICK_JS : '',
  ].join('\n') + '\n';
}

function renderText(scope, now) {
  const hereId = norm(item(now.doing).task);
  const doing = item(now.doing);
  const circled = (i) => (i < 10 ? '①②③④⑤⑥⑦⑧⑨⑩'[i] : `${i + 1})`);
  const inline = (items, withTitle) => (items || []).map((x, i) => {
    const t = item(x);
    return `${circled(i)} ${t.task ? `${norm(t.task)} ` : ''}${withTitle && t.title ? `${t.title}：` : ''}${t.text || ''}${t.ai ? '（AI 建议，可不看）' : ''}`;
  }).join('　') || '暂无';
  const out = [];
  if (scope.mode === 'lines') {
    for (const l of scope.lines) {
      const { shown, hidden } = pickStations(l);
      out.push(`**进度卡** · ${l.name} 线路 ${l.total} 站：${counts(l).join(' · ')}`);
      out.push(shown.map((s) => `\`${SYM[s.state] || '?'}${s.id}${accOf(s) === 'auto' ? ' 自动验收' : ''}${norm(s.id) === hereId ? ' 我在这' : ''}\``).join(' ')
        + `（✓到站 !待你验收 ▶进行中 ○未到站${hidden.length ? `；另有${hidden.join('、')}没列出` : ''}）`);
      out.push(...beltText(l));
      if (shown.some((s) => s.state === 'review')) out.push('想验收哪站，说「去验收 T0xx」，我帮你把验收界面打开。');
      out.push('');
    }
  } else if (scope.mode === 'overview') {
    out.push(`**进度卡** · 全部线路 ${scope.lines.length} 条在推进`);
    out.push(scope.lines.map((l) => `\`${SYM[urgent(l)]}${l.name}\` ${openCounts(l).join(' · ')}`).join('　'));
    out.push(...beltText(allLine(scope.lines)));
    if (scope.lines.some((l) => l.review)) out.push('想验收哪条线，说「我要验收 <项目名>」。');
    out.push('');
  } else {
    out.push(`**进度卡** · ${scope.note}`);
    out.push('');
  }
  // 右栏三块（看板#T125）：做完了 / 还没完 / 要你定
  const tAsks = (now.asks || []).map(item);
  const c = now.check;
  const cIds = new Set(c ? [c.task, ...(c.tasks || [])].map(norm).filter(Boolean) : []);
  const idsOf = (t) => norm(t.task).match(/T\d+/g) || [];
  const mark = (t) => `${t.task ? `${norm(t.task)} ` : ''}${t.text}`;
  const doneAsks = tAsks.filter((t) => t.done === true);
  const hasCheck = c && (c.items || []).length;
  if (doneAsks.length || hasCheck) out.push(`- **${doneAsks.length} 件 完成**：${doneAsks.map((t) => `✓ ${mark(t)}`).join('　') || '见下面验收'}`);
  if (hasCheck) {
    const tid = norm(c.task) || 'T0xx';
    out.push(`  - ${tid} 待你验收：`);
    c.items.forEach((x, i) => {
      const t = item(x);
      out.push(`    - ${circled(i)} ${t.text}${t.do || t.see ? `　怎么验：${t.do || ''}${t.do && t.see ? '，应该看到 ' : ''}${t.see || ''}` : ''}`);
    });
    out.push(`    - ${c.reply || `都对回「完成 ${tid}」，有不对直接说第几条`}`);
  }
  const undone = tAsks.filter((t) => t.done !== true);
  if (undone.length || (now.next || []).length) {
    const doingDone = hereId && tAsks.some((t) => t.done === true && idsOf(t).includes(hereId));
    const parts = [doing.text && !doingDone ? `正在做 ${hereId ? `${hereId} ` : ''}${doing.text}` : '', ...undone.map((t) => `${t.done === 'doing' ? '▶' : '○'} ${mark(t)}`)].filter(Boolean);
    out.push(`- **${undone.length + (now.next || []).filter((x) => !item(x).ai).length} 件 还没完**：${parts.join('　')}`);
    if ((now.next || []).length) out.push(`  - 接下来：${inline(now.next, false)}`);
  }
  const decideLines = scope.mode === 'lines' ? decideText(scope.lines) : [];
  const tYou = (now.you || []).filter((x) => { const ids = idsOf(item(x)); return !(ids.length && ids.every((i) => cIds.has(i))); });
  const pick = c && (c.decide || []).length ? `要你拍板：${c.decide.map((x) => `${item(x).text}${item(x).advice ? `（建议：${item(x).advice}）` : ''}`).join('；')}` : '';
  if (decideLines.length || tYou.length || pick) {
    out.push(`- **${decideLines.length + tYou.filter((x) => !item(x).ai).length + (c && c.decide ? c.decide.length : 0)} 件 要你定**：${[pick, tYou.length ? inline(tYou, true) : ''].filter(Boolean).join('；') || '见下面'}`);
    out.push(...decideLines.map((l) => `  ${l}`));
  }
  return out.join('\n') + '\n';
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const raw = (await readInput(opt.file)).replace(/^\uFEFF/, '').trim();
  const now = raw ? JSON.parse(raw) : {};
  const at = DUE_RE.exec(opt.now || (opt.today ? `${opt.today}T12:00` : ''));
  NOW = at && at[4] ? new Date(+at[1], +at[2] - 1, +at[3], +at[4], +at[5]).getTime() : Date.now();
  TODAY = localIso(new Date(NOW));
  NAMES = Object.fromEntries(Object.entries(now.names || {}).map(([k, v]) => [norm(k), String(v)]));
  CHECK = now.check || null;
  BOARD = opt.board;
  const scope = resolveScope(opt);
  process.stdout.write(opt.text ? renderText(scope, now) : renderHtml(scope, now));
}

main().catch((e) => { console.error(`进度卡出错：${e.message || e}`); process.exit(1); });
