'use strict';
// 从 TODO.md + ARCHIVE.md + HISTORY.md 生成需求线路图。
// 台账是唯一数据源：这里只读不写，页面里不保存任何第二份数据。
//   node tools/build-metro.js          生成静态的 metro.html（只读，可直接双击打开）
//   tools/board-server.js 复用这里的 buildData / renderHtml，提供可操作的版本。

const fs = require('fs');
const path = require('path');
const { stationState, eachTask, splitLines, listArchivedProjects, readPins, beltReport, dueMs } = require('./ledger.js');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(__dirname, 'metro-template.html');

const FULL_LINE_RE =
  /^- \[[ xX]\] #T\d+\s+(.+?)\s+due:(\S+)\s+status:\S+\s+priority:P[123]\b/;

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function parseTasks(markdown, source) {
  const { lines } = splitLines(markdown);
  const tasks = [];
  eachTask(lines, (t, i) => {
    const m = lines[i].match(FULL_LINE_RE);
    const body = m[1];
    const pipe = body.indexOf('｜');
    const text = pipe >= 0 ? body.slice(pipe + 1).trim() : body.trim();
    tasks.push({
      id: t.id, project: t.project, text, title: shortTitle(text),
      due: m[2], status: t.status, priority: t.priority, source,
      state: stationState(t),
      exec: t.fields.exec || '',
      created: t.fields.created || '',
      done: t.fields.done || '',
      accept: t.fields.accept || '', // auto = 自动验收（AI 替你验的），me = 人工验收（你亲手验的），旧站空着
      paused: t.fields.paused || '',
      archived: t.fields.archived || '',
    });
  });
  return tasks;
}

// 站名：取「——」「：」之前的主干，去掉（内部T0xx）这类括注；完整文字留给详情。
function shortTitle(text) {
  let t = text.split('——')[0];
  // 「在 F:\xxx 项目（中）做……」开头的路径状语对站名没用，去掉。
  t = t.replace(/^在\s*`?[A-Za-z]:[\\/][^\s`]*`?\s*(项目)?中?/, '');
  // 先去掉（内部T0xx…）括注，再按冒号截——括注里可能自带冒号。
  t = t.replace(/（内部[^）]*）/g, '').replace(/`/g, '').trim();
  const colon = t.indexOf('：');
  if (colon >= 6) t = t.slice(0, colon);
  const semi = t.search(/[；;]/);
  if (semi >= 8) t = t.slice(0, semi);
  return t;
}

// HISTORY.md：`- 2026-09-21 14:03 #T028 项目｜进行中 → 已到站｜备注`
function parseHistory(markdown) {
  const byId = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) #(T\d+) .+?｜([^｜]+)(?:｜(.*))?$/);
    if (!m) continue;
    if (!byId.has(m[2])) byId.set(m[2], []);
    byId.get(m[2]).push({ at: m[1], change: m[3].trim(), note: (m[4] || '').trim() });
  }
  return byId;
}

// 项目页开头 frontmatter 里的 parent（线路图上的父节点，同一仓库的几条线挂在一起）和 branch（代码分支）。
// 行尾「 # 注释」去掉；分支只取「（」之前的主干，括号里的说明留在项目页。
function readPageMeta(projectsDir, name) {
  const text = readIfExists(path.join(projectsDir, `${name}.md`));
  const fm = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  const get = (k) => ((fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm')) || [])[1] || '').replace(/\s+#.*$/, '').trim();
  return { parent: get('parent'), branch: get('branch').split(/[（(]/)[0].trim() };
}

function buildData(root = DEFAULT_ROOT) {
  const todoMd = readIfExists(path.join(root, 'TODO.md'));
  const archiveMd = readIfExists(path.join(root, 'ARCHIVE.md'));
  if (!todoMd) throw new Error('找不到 TODO.md');
  const history = parseHistory(readIfExists(path.join(root, 'HISTORY.md')));

  const byId = new Map();
  // 归档在前、台账在后：同一编号以台账为准。
  for (const t of parseTasks(archiveMd, 'ARCHIVE.md')) byId.set(t.id, t);
  for (const t of parseTasks(todoMd, 'TODO.md')) byId.set(t.id, t);

  const idNum = (id) => Number(id.slice(1));
  const projectsDir = path.join(root, 'projects');
  const registered = new Set(
    fs.existsSync(projectsDir)
      ? fs.readdirSync(projectsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
      : []
  );
  const archivedProjects = new Map(listArchivedProjects(archiveMd).map((p) => [p.name, p.archived]));

  const pins = readPins(root);
  const pinnedTasks = new Set(pins.tasks);
  const pinnedProjects = new Set(pins.projects);

  const groups = new Map();
  for (const t of byId.values()) {
    t.history = history.get(t.id) || [];
    t.pinned = pinnedTasks.has(t.id);
    if (!groups.has(t.project)) groups.set(t.project, []);
    groups.get(t.project).push(t);
  }

  const lines = [...groups.entries()].map(([name, stations]) => {
    // 站序 = 需求提出的先后（created，其次编号），不是完成的先后。
    stations.sort((a, b) =>
      (a.created || '9999').localeCompare(b.created || '9999') || idNum(a.id) - idNum(b.id));
    const count = (s) => stations.filter((x) => x.state === s).length;
    // 登记为已归档、且台账里已经没有它的任务，才算归档线路；又被加了新任务就当它复活了。
    const isArchived = archivedProjects.has(name) && stations.every((s) => s.source === 'ARCHIVE.md');
    const meta = registered.has(name) ? readPageMeta(projectsDir, name) : { parent: '', branch: '' };
    return {
      name,
      parent: meta.parent,
      branch: meta.branch,
      pinned: pinnedProjects.has(name),
      registered: registered.has(name),
      archived: isArchived ? archivedProjects.get(name) : '',
      page: registered.has(name) ? `projects/${encodeURIComponent(name)}.md` : '',
      firstId: Math.min(...stations.map((s) => idNum(s.id))),
      total: stations.length,
      done: count('done'), review: count('review'), doing: count('doing'), todo: count('todo'), paused: count('paused'), dropped: count('dropped'),
      stations,
    };
  });

  // 线路编号按「第一条需求的编号」定，之后不会因为状态变化而改号。
  lines.sort((a, b) => a.firstId - b.firstId).forEach((l, i) => { l.no = i + 1; });
  // 展示顺序：还有未到站的在前（登记过的主要项目优先），其余按编号。分组由页面负责。
  const open = (l) => l.review + l.doing + l.todo + l.paused > 0;
  lines.sort((a, b) =>
    Number(open(b)) - Number(open(a)) || Number(b.registered) - Number(a.registered) || a.no - b.no);

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    generatedAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    ledgerUpdated: (todoMd.match(/last_updated:\s*(\S+)/) || [])[1] || '',
    lines,
    // 传送带（#T122）：页面顶上那条带的数据；到点换成毫秒，页面自己倒计时
    belt: beltOf(todoMd, now),
  };
}

function beltOf(todoMd, now) {
  const r = beltReport({ todoMd, now });
  const out = {};
  for (const k of Object.keys(r)) out[k] = r[k].map((x) => ({ ...x, dueAt: dueMs(x.due) || null, askAt: dueMs(x.ask) || null }));
  return out;
}

// server = null → 静态只读页；server = { token } → 由本地服务提供，可以改台账。
function renderHtml(data, server = null) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  for (const mark of ['/*__METRO_DATA__*/', '/*__SERVER__*/']) {
    if (!template.includes(mark)) throw new Error(`模板里找不到占位符 ${mark}`);
  }
  // 任务文字里若出现 </script> 会截断内联脚本，转义掉。
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  return template
    .replace('/*__METRO_DATA__*/', () => json(data))
    .replace('/*__SERVER__*/', () => json(server));
}

function writeStatic(root = DEFAULT_ROOT) {
  const data = buildData(root);
  fs.writeFileSync(path.join(root, 'metro.html'), renderHtml(data, null), 'utf8');
  return data;
}

module.exports = { buildData, renderHtml, writeStatic };

if (require.main === module) {
  const data = writeStatic();
  const sum = (k) => data.lines.reduce((n, l) => n + l[k], 0);
  console.log(`metro.html 已生成：${data.lines.length} 条线路，${sum('total')} 站，已到站 ${sum('done')}，停运 ${sum('dropped')}，其余 ${sum('total') - sum('done') - sum('dropped')}`);
}
