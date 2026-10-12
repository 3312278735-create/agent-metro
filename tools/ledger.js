'use strict';
// 台账操作库：改单个站点的状态（带备注）、归档整个项目、恢复项目。
// 核心是纯函数（字符串进、字符串出），方便在副本上测试；落盘由 applyToDisk 负责，动手前先备份。
//
// 命令行：
//   node tools/ledger.js set-status <T编号> <done|review|doing|todo|paused|dropped> [--me] [备注…]
//     review = 待验收：AI 能做的已做完，球在用户那边（验收 / 拍板）；用户说「完成」才到站。
//     done 默认记「自动验收」（AI 自己查过就到站）；用户亲口说「完成 T0xx」时加 --me，记「人工验收」。
//   node tools/ledger.js archive-project <项目名>
//   node tools/ledger.js restore-project <项目名>
//   node tools/ledger.js list-projects
//   node tools/ledger.js set-budget <T编号> <30m|1h|1.5h|none> [备注]   这一站最多花多久；转进行中时自动计时（到点 = 现在 + 预算）
//   node tools/ledger.js set-due <T编号> <2026-10-01|2026-10-01T15:00|15:00|+1h|none> [备注]   到点（转待验收时自动定成两天后）
//   node tools/ledger.js set-ask <T编号> <日期|日期T钟点|none> [备注]   等用户审定到哪天；过了还没回，AI 按站上写好的默认方案开工；none = 审定过了
//   node tools/ledger.js belt [--json]   传送带巡检（只读）：到点没收尾 / 审定过期 / 验收筐 / 在带上 / 排队
//   node tools/ledger.js desk-sync <导出目录> [--dry]   验收台同步：页面上点的结果记进台账，台账的待验收站补卡 / 收卡（见下面「验收台同步」）

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

// 与 daily-focus/lib/todo-plan.js 的 TASK_LINE_RE 同一口径。
const TASK_LINE_RE =
  /^- \[([ xX])\] #(T\d+)\s+(.+?)\s+due:(\S+)\s+status:(\S+)\s+priority:(P[123])\b(.*)$/;

const SECTION_BY_STATUS = {
  doing: '## 进行中',
  review: '## 待验收',
  todo: '## 未开始',
  paused: '## 暂停',
  done: '## 已完成',
};
const STATE_LABEL = { done: '已到站', review: '待验收', doing: '进行中', todo: '未到站', paused: '暂缓', dropped: '停运' };
// 谁验收的（2026-10-10 用户定）：accept:auto = 不太紧要、AI 自己查得到结果的站，AI 替用户验收到站；accept:me = 用户亲手验收。
// 只挂在已到站的行上；离开已到站时去掉。旧站没有这个字段，线路图上不打标。
const ACCEPT_LABEL = { auto: '自动验收', me: '人工验收' };
// 「待验收」分区是后加的：旧台账里没有就在「进行中」后面补一个（daily-focus 也认这个标题）。
const REVIEW_HEADING = '## 待验收（review）';
const ARCHIVED_PROJECTS_HEADING = '## 已归档项目';
const DROPPED_HEADING = '## 未完成即归档';
const EMPTY_NOTE = '暂无归档。';
const HISTORY_HEADER = [
  '# 站点变更记录',
  '',
  '> 在线路图上右键改状态 / 归档项目时自动追加，最新的在最上面。',
  '> 格式：`- 日期 时间 #编号 项目｜原状态 → 新状态｜备注`。AI 会话开始时会读这里，了解你手动改了什么。',
  '',
];

const pad2 = (n) => String(n).padStart(2, '0');
const todayIso = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const nowHm = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function splitLines(text) {
  return { lines: text.split(/\r?\n/), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

function parseTaskLine(line) {
  const m = line.match(TASK_LINE_RE);
  if (!m) return null;
  const [, box, id, body, , status, priority, tail] = m;
  const pipe = body.indexOf('｜');
  const fields = {};
  for (const f of tail.matchAll(/(\w+):(\S+)/g)) fields[f[1]] = f[2];
  return {
    id, status, priority, fields,
    checked: box !== ' ',
    project: pipe >= 0 ? body.slice(0, pipe).trim() : '未分类',
  };
}

// 台账状态 → 线路图上的站点状态。归档且带完成日期 = 到站；归档但没完成 = 停运。
function stationState(task) {
  if (task.status === 'done') return 'done';
  if (task.status === 'archived') return task.fields.done ? 'done' : 'dropped';
  if (task.status === 'doing' || task.status === 'review' || task.status === 'paused') return task.status;
  return 'todo';
}

// 逐行遍历任务行，跳过 ``` 围栏里的格式示例。
function eachTask(lines, fn) {
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const t = parseTaskLine(line);
    if (t) fn(t, i);
  });
}

function findSection(lines, headingPrefix) {
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function setLastUpdated(lines, today) {
  const i = lines.findIndex((l) => /^>\s*last_updated:/.test(l));
  if (i >= 0) lines[i] = `> last_updated: ${today}`;
}

// 只给工具自己维护的文件用（ARCHIVE.md / HISTORY.md）：连续空行并成一行，文件以单个换行结尾。
function tidyBlankLines(lines) {
  const out = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) inFence = !inFence;
    if (!inFence && l.trim() === '' && out.length && out[out.length - 1].trim() === '') continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  out.push('');
  return out;
}

// TODO.md 只做局部处理：删掉一行后若留下两个连续空行，并掉一个。不碰文件其余部分。
function removeLineAt(lines, index) {
  lines.splice(index, 1);
  if (index > 0 && index < lines.length && lines[index - 1].trim() === '' && lines[index].trim() === '') {
    lines.splice(index, 1);
  }
}

// 旧台账没有「待验收」分区时补一个：插在「未开始」前面（没有「未开始」就放在「进行中」之后）。
function ensureReviewSection(lines) {
  if (findSection(lines, SECTION_BY_STATUS.review)) return;
  const todoSec = findSection(lines, SECTION_BY_STATUS.todo);
  const doingSec = findSection(lines, SECTION_BY_STATUS.doing);
  const at = todoSec ? todoSec.start : doingSec ? doingSec.end : -1;
  if (at < 0) throw new Error('TODO.md 里找不到「进行中」或「未开始」分区，没法补「待验收」分区');
  lines.splice(at, 0, REVIEW_HEADING, '', '');
}

// 在 TODO.md 的一个分区里插入任务行：排在同优先级及更高优先级之后，保持「P1 在前」。
function insertIntoSection(lines, headingPrefix, taskLine) {
  if (headingPrefix === SECTION_BY_STATUS.review) ensureReviewSection(lines);
  const sec = findSection(lines, headingPrefix);
  if (!sec) throw new Error(`TODO.md 里找不到分区「${headingPrefix}」`);
  const prio = parseTaskLine(taskLine).priority;
  let at = -1;
  let firstTask = -1;
  for (let i = sec.start + 1; i < sec.end; i++) {
    const t = parseTaskLine(lines[i]);
    if (!t) continue;
    if (firstTask < 0) firstTask = i;
    if (t.priority <= prio) at = i + 1;
  }
  if (at >= 0) { lines.splice(at, 0, taskLine); return; }
  if (firstTask >= 0) { lines.splice(firstTask, 0, taskLine); return; }
  // 分区里还没有任务：放在标题和说明文字之后，前后各留一个空行。
  let end = sec.end;
  while (end > sec.start + 1 && lines[end - 1].trim() === '') end--;
  const block = ['', taskLine];
  if (sec.end < lines.length) block.push('');
  lines.splice(end, sec.end - end, ...block);
}

/* ---------- ARCHIVE.md ---------- */

const isMonthHeading = (l) => /^## \d{4}-\d{2}\s*$/.test(l);

function archiveInsertIndex(lines, heading) {
  // 顺序固定：已归档项目 → 各月份（升序）→ 未完成即归档
  if (heading === ARCHIVED_PROJECTS_HEADING) {
    return lines.findIndex((l) => isMonthHeading(l) || l.startsWith(DROPPED_HEADING));
  }
  if (heading === DROPPED_HEADING) return -1;
  const month = heading.slice(3).trim();
  return lines.findIndex((l) => (isMonthHeading(l) && l.slice(3).trim() > month) || l.startsWith(DROPPED_HEADING));
}

function appendToArchiveSection(lines, heading, entry) {
  if (!findSection(lines, heading)) {
    const at = archiveInsertIndex(lines, heading);
    const block = ['', heading, '', ''];
    if (at < 0) lines.push(...block); else lines.splice(at, 0, ...block);
  }
  let sec = findSection(lines, heading);
  for (let i = sec.end - 1; i > sec.start; i--) if (lines[i].trim() === EMPTY_NOTE) lines.splice(i, 1);
  sec = findSection(lines, heading);
  let at = sec.end;
  while (at > sec.start + 1 && lines[at - 1].trim() === '') at--;
  if (at === sec.start + 1) { lines.splice(at, 0, ''); at += 1; }
  lines.splice(at, 0, entry, '');
}

function removeEmptyArchiveSections(lines) {
  const headings = lines.filter((l) => isMonthHeading(l) || l.startsWith(DROPPED_HEADING) || l.startsWith(ARCHIVED_PROJECTS_HEADING));
  for (const h of headings) {
    const sec = findSection(lines, h);
    if (!sec) continue;
    const hasContent = lines.slice(sec.start + 1, sec.end).some((l) => l.trim() !== '' && l.trim() !== EMPTY_NOTE);
    if (!hasContent) lines.splice(sec.start, sec.end - sec.start);
  }
}

function updateProjectList(lines, name, { add }) {
  const sec = findSection(lines, '## 项目清单');
  if (!sec) return;
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (lines[i].startsWith('>') || !lines[i].includes(' · ')) continue;
    const names = lines[i].split(' · ').map((s) => s.trim()).filter(Boolean);
    const has = names.includes(name);
    if (add && !has) names.push(name);
    if (!add && has) names.splice(names.indexOf(name), 1);
    lines[i] = names.join(' · ');
    return;
  }
}

function listArchivedProjects(archiveMd) {
  const { lines } = splitLines(archiveMd);
  const sec = findSection(lines, ARCHIVED_PROJECTS_HEADING);
  if (!sec) return [];
  const out = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = lines[i].match(/^- (.+?)\s+archived:(\S+)/);
    if (m) out.push({ name: m[1].trim(), archived: m[2] });
  }
  return out;
}

// 今日规划只做软提醒，从不拦操作：daily-focus 找不到 MIT 对应的任务时会显示成「任务 #T0xx」，
// 规划日期不是今天时还会自动重排，所以留一个悬空引用是无害的。
// 只认「### 主目标」下真正的 MIT 行，且规划日期必须是今天——说明文字里提到的编号、过期的规划都不算。
function todayPlanWarnings(todoLines, ids, today, action) {
  const plan = findSection(todoLines, '## 今日规划');
  if (!plan) return [];
  const date = (todoLines[plan.start].match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
  if (date !== today) return [];
  const mits = new Set();
  for (let i = plan.start + 1; i < plan.end; i++) {
    const m = todoLines[i].match(/^- (?:必达|次要)：#(T\d+)\b/);
    if (m) mits.add(m[1]);
  }
  const hit = ids.filter((id) => mits.has(id)).map((id) => `#${id}`);
  return hit.length ? [`${hit.join('、')} 是今天的主目标，已照常${action}；想换目标，在每日焦点里点「重新规划」`] : [];
}

/* ---------- HISTORY.md ---------- */

function cleanNote(note) {
  return String(note || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function prependHistory(historyMd, entries) {
  const { lines, eol } = splitLines(historyMd && historyMd.trim() ? historyMd : HISTORY_HEADER.join('\n'));
  let at = lines.findIndex((l) => l.startsWith('- '));
  if (at < 0) { while (lines.length && lines[lines.length - 1].trim() === '') lines.pop(); lines.push(''); at = lines.length; }
  lines.splice(at, 0, ...entries);
  return tidyBlankLines(lines).join(eol);
}

// 到站时注明谁验收的：「待验收 → 已到站（自动验收）」
const historyEntry = ({ date, time, id, project, from, to, note, accept = '' }) =>
  `- ${date} ${time} #${id} ${project}｜${from === to ? '备注' : `${STATE_LABEL[from]} → ${STATE_LABEL[to]}${ACCEPT_LABEL[accept] ? `（${ACCEPT_LABEL[accept]}）` : ''}`}${note ? `｜${note}` : ''}`;

/* ---------- 操作：改单个站点 ---------- */

/**
 * 改一个站点的状态并记一条备注。status: done | review（待验收）| doing | todo | paused | dropped（放弃不做）。
 * dropped 的任务行移入 ARCHIVE.md「未完成即归档」；从那里改回其他状态会移回 TODO.md 对应分区。
 */
function setTaskStatus({ todoMd, archiveMd, historyMd = '', id, status, note = '', accept = '', today = todayIso(), time = nowHm(), now = new Date() }) {
  if (!STATE_LABEL[status]) throw new Error(`不认识的状态「${status}」`);
  if (accept && !ACCEPT_LABEL[accept]) throw new Error(`不认识的验收方式「${accept}」（auto = 自动验收，me = 人工验收）`);
  if (status !== 'done') accept = '';
  const todo = splitLines(todoMd);
  const arch = splitLines(archiveMd);
  note = cleanNote(note);

  let found = null;
  eachTask(todo.lines, (t, i) => { if (t.id === id) found = { ...t, index: i, raw: todo.lines[i], where: 'todo' }; });
  if (!found) eachTask(arch.lines, (t, i) => { if (t.id === id) found = { ...t, index: i, raw: arch.lines[i], where: 'archive' }; });
  if (!found) throw new Error(`找不到 #${id}`);

  const from = stationState(found);
  // 已到站的站只改验收方式（例：你把「自动验收」的站亲手验了一遍 → 人工验收）
  const acceptChange = from === 'done' && status === 'done' && accept && accept !== found.fields.accept;
  if (from === status && !note && !acceptChange) throw new Error('状态没变，也没写备注，没有可提交的内容');

  if (found.where === 'archive' && listArchivedProjects(archiveMd).some((p) => p.name === found.project)) {
    if (from !== status) throw new Error(`「${found.project}」整条线已归档，先恢复项目再改它的站点`);
  }

  let warnings = [];
  if (from !== status) {
    if (status === 'dropped') warnings = todayPlanWarnings(todo.lines, [id], today, '标为停运');

    let line = found.raw.replace(/\s(archived|was|dropped|accept):\S+/g, '');
    const strip = (k) => { line = line.replace(new RegExp(`\\s${k}:\\S+`, 'g'), ''); };
    const box = (on) => { line = line.replace(/^- \[[ xX]\]/, on ? '- [x]' : '- [ ]'); };
    const setStatus = (s) => { line = line.replace(/\sstatus:\S+/, ` status:${s}`); };

    if (status === 'done') {
      box(true); setStatus('done'); strip('paused');
      if (!found.fields.done) line += ` done:${today}`;
      if (accept) line += ` accept:${accept}`;
    } else if (status === 'dropped') {
      box(false); setStatus('archived'); strip('done');
      line += ` archived:${today} dropped:${today}`;
    } else {
      box(false); setStatus(status); strip('done');
      if (status === 'paused') { if (!found.fields.paused) line += ` paused:${today}`; } else strip('paused');
    }

    // 传送带计时（2026-09-29 用户定：按小时算，验收期两天）
    const clock = startClock(line, status, found, now, today);
    line = clock.line;
    if (clock.note) note = note ? `${note}；${clock.note}` : clock.note;

    if (found.where === 'todo') removeLineAt(todo.lines, found.index); else arch.lines.splice(found.index, 1);
    if (status === 'dropped') appendToArchiveSection(arch.lines, DROPPED_HEADING, line);
    else insertIntoSection(todo.lines, SECTION_BY_STATUS[status], line);

    removeEmptyArchiveSections(arch.lines);
    setLastUpdated(todo.lines, today);
    setLastUpdated(arch.lines, today);
  } else if (acceptChange) {
    const line = found.raw.replace(/\saccept:\S+/g, '') + ` accept:${accept}`;
    (found.where === 'todo' ? todo.lines : arch.lines)[found.index] = line;
    setLastUpdated(todo.lines, today);
  }

  const old = ACCEPT_LABEL[found.fields.accept] || '已到站';
  const entry = acceptChange
    ? `- ${today} ${time} #${id} ${found.project}｜${old} → ${ACCEPT_LABEL[accept]}${note ? `｜${note}` : ''}`
    : historyEntry({ date: today, time, id, project: found.project, from, to: status, note, accept: from !== status ? accept : '' });
  return {
    todoMd: todo.lines.join(todo.eol),
    archiveMd: from !== status || (acceptChange && found.where === 'archive') ? tidyBlankLines(arch.lines).join(arch.eol) : archiveMd,
    historyMd: prependHistory(historyMd, [entry]),
    summary: { id, project: found.project, from, to: status, accept, note, warnings },
  };
}

/* ---------- 传送带计时：预算 / 到点 / 审定期限（2026-09-29 用户定：按小时算，验收期两天） ---------- */
// budget：这一站最多花多久（30m / 1h / 1.5h），排站时给；开工（转进行中）那一刻，到点自动定成「现在 + 预算」。
// due：到点。只写日期（2026-10-01）= 算到那天结束；带钟点写成 2026-10-01T15:00。转待验收时自动定成两天后（验收期）。
// ask：等用户审定到哪天（或几点）。过了还没回，AI 按站上写好的默认方案开工；none = 删掉这个字段。
// 变更记录：到点第一次定写「定到点 …」，往后挪写「延期 旧 → 新」（进度卡靠它数延过几次，每站只许延一次），往前挪写「提前 …」。
const REVIEW_DAYS = 2;
const DUE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const localStamp = (d) => `${todayIso(d)}T${nowHm(d)}`;
const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return todayIso(new Date(y, m - 1, d + n)); };
// 到点换成毫秒：只写日期的算到那天 24:00
function dueMs(v) {
  const m = DUE_RE.exec(v || '');
  if (!m) return NaN;
  return m[4] ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime();
}
const prettyDue = (v) => (DUE_RE.test(v || '') ? v.slice(5).replace('T', ' ') : v);
// 时长：30m / 45分钟 / 1h / 1.5小时 / 2d → 分钟
function spanMin(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|分|分钟|h|小时|d|天)$/i.exec(String(s || '').trim());
  if (!m) return NaN;
  const k = m[2].toLowerCase();
  const per = k === 'h' || k === '小时' ? 60 : k === 'd' || k === '天' ? 1440 : 1;
  return Math.round(parseFloat(m[1]) * per);
}
const fmtBudget = (min) => (min % 60 === 0 ? `${min / 60}h` : min > 60 && (min * 2) % 60 === 0 ? `${min / 60}h` : `${min}m`);

// set-due 认的写法：none / 2026-10-01 / 2026-10-01T15:00 / 15:00（今天）/ +1h / +30m / +2d（两天后那天结束）
function resolveDue(value, now) {
  const v = String(value || '').trim();
  if (v === 'none' || DUE_RE.test(v)) return v;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (hm) return `${todayIso(now)}T${pad2(+hm[1])}:${hm[2]}`;
  if (v.startsWith('+')) {
    const min = spanMin(v.slice(1));
    if (Number.isNaN(min)) throw new Error('「+」后面写时长，例如 +1h、+30m、+2d');
    return /d|天/i.test(v) ? addDays(todayIso(now), Math.round(min / 1440)) : localStamp(new Date(now.getTime() + min * 60000));
  }
  throw new Error('到点写成 2026-10-01、2026-10-01T15:00、15:00、+1h 这样，或者 none');
}

const DATE_FIELDS = { due: '到点', ask: '审定期限', budget: '预算' };
function setTaskDate({ todoMd, archiveMd, historyMd = '', id, key, value, note = '', today = todayIso(), time = nowHm(), now = new Date() }) {
  if (!DATE_FIELDS[key]) throw new Error(`不认识的字段「${key}」`);
  const raw = String(value || '').trim();
  if (key === 'budget') {
    if (raw !== 'none' && Number.isNaN(spanMin(raw))) throw new Error('预算写成 30m、1h、1.5h 这样，或者 none');
    value = raw === 'none' ? 'none' : fmtBudget(spanMin(raw));
  } else {
    value = resolveDue(raw, now);
  }
  const todo = splitLines(todoMd);
  note = cleanNote(note);
  let found = null;
  eachTask(todo.lines, (t, i) => { if (t.id === id) found = { ...t, index: i, raw: todo.lines[i] }; });
  if (!found) throw new Error(`TODO.md 里找不到 #${id}（已归档的站不能改）`);
  const old = key === 'due' ? found.raw.match(TASK_LINE_RE)[4] : (found.fields[key] || 'none');
  if (old === value) throw new Error(`#${id} 的${DATE_FIELDS[key]}已经是 ${value}`);

  let line = found.raw;
  if (key === 'due') {
    line = line.replace(/\sdue:\S+/, ` due:${value}`);
  } else {
    line = line.replace(new RegExp(`\\s${key}:\\S+`, 'g'), '');
    if (value !== 'none') line += ` ${key}:${value}`;
  }
  todo.lines[found.index] = line;
  setLastUpdated(todo.lines, today);

  let change;
  if (key === 'due') {
    change = old === 'none' ? `定到点 ${prettyDue(value)}`
      : value === 'none' ? `取消到点（原 ${prettyDue(old)}）`
        : dueMs(value) > dueMs(old) ? `延期 ${prettyDue(old)} → ${prettyDue(value)}` : `提前 ${prettyDue(old)} → ${prettyDue(value)}`;
  } else if (key === 'ask') {
    change = value === 'none' ? `审定期限撤掉（原 ${prettyDue(old)}）` : `审定期限 ${prettyDue(value)}`;
  } else {
    change = value === 'none' ? `预算撤掉（原 ${old}）` : `预算 ${value}`;
  }
  return {
    todoMd: todo.lines.join(todo.eol),
    archiveMd,
    historyMd: prependHistory(historyMd, [`- ${today} ${time} #${id} ${found.project}｜${change}${note ? `｜${note}` : ''}`]),
    summary: { id, project: found.project, key, from: old, to: value, note },
  };
}

// 改状态时顺手计时：转进行中且有预算 → 到点 = 现在 + 预算；转待验收 → 到点 = 两天后（验收期）。
function startClock(line, status, found, now, today) {
  // 开工 = 审定这一步用掉了：撤掉 ask，免得过期的审定期限一直挂在行上（2026-10-10）
  if (status === 'doing' && found.fields.ask) line = line.replace(/\sask:\S+/g, '');
  if (status === 'doing' && found.fields.budget) {
    const min = spanMin(found.fields.budget);
    if (!Number.isNaN(min)) {
      const d = localStamp(new Date(now.getTime() + min * 60000));
      return { line: line.replace(/\sdue:\S+/, ` due:${d}`), note: `开工计时，${prettyDue(d)} 到点` };
    }
  }
  if (status === 'review' && found.status !== 'review') {
    const d = addDays(today, REVIEW_DAYS);
    return { line: line.replace(/\sdue:\S+/, ` due:${d}`), note: `验收期到 ${prettyDue(d)}` };
  }
  return { line, note: '' };
}

/* ---------- 传送带巡检：哪些站到点了、该收尾 / 该开工 / 落验收筐（2026-10-10） ---------- */
// 只读，不改文件。每次会话开头跑一次，按结果当场处理，画进度卡也用它分组。
//   overdue  进行中且已过到点 → 当场收尾（做完转待验收 / 到站，做不完说明原因后 set-due 延一次）
//   askDue   审定期限已过、还没开工 → 按站上写好的默认方案开工（set-status doing，会自动计时、撤掉 ask）
//   bin      待验收且验收期已过 → 落「验收筐」：不再占带子、不挡后面的站，等用户有空一起验
//   running  进行中、还没到点；reviewing 待验收、还在验收期；queued 没开工但排了预算
//   untimed  进行中但没到点（长期站 / 计时前的老站），不在带上，只报个数
function beltReport({ todoMd, now = new Date() }) {
  const { lines } = splitLines(todoMd);
  const t0 = now.getTime();
  const out = { overdue: [], askDue: [], bin: [], running: [], reviewing: [], queued: [], untimed: [] };
  eachTask(lines, (t, i) => {
    if (!['doing', 'review', 'todo'].includes(t.status)) return;
    const due = lines[i].match(TASK_LINE_RE)[4];
    const dMs = dueMs(due);
    const aMs = dueMs(t.fields.ask);
    const text = lines[i].match(TASK_LINE_RE)[3];
    const item = {
      id: t.id, project: t.project, title: text.slice(text.indexOf('｜') + 1).split(/——|：/)[0].trim(),
      status: t.status, exec: t.fields.exec || '', due, ask: t.fields.ask || '', budget: t.fields.budget || '',
    };
    if (!Number.isNaN(dMs)) item.leftMin = Math.round((dMs - t0) / 60000);
    if (t.status === 'doing') (item.leftMin === undefined ? out.untimed : item.leftMin < 0 ? out.overdue : out.running).push(item);
    else if (t.status === 'review') {
      if (item.leftMin < 0) out.bin.push(item);
      else if (item.leftMin !== undefined) out.reviewing.push(item);
    } else if (!Number.isNaN(aMs) && aMs < t0) out.askDue.push(item);
    else if (item.budget) out.queued.push(item);
  });
  const byLeft = (a, b) => (a.leftMin ?? 1e12) - (b.leftMin ?? 1e12);
  for (const k of Object.keys(out)) out[k].sort(byLeft);
  return out;
}

function fmtLeft(min) {
  const a = Math.abs(min);
  const s = a < 60 ? `${a} 分钟` : a < 1440 ? `${Math.round(a / 6) / 10} 小时`.replace('.0 ', ' ') : `${Math.floor(a / 1440)} 天`;
  return min < 0 ? `过点 ${s}` : `还剩 ${s}`;
}

function beltText(r) {
  const row = (x, extra) => `  #${x.id} ${x.project}｜${x.title}（${extra}）`;
  const parts = [];
  const sec = (name, list, fn, hint) => {
    if (!list.length) return;
    parts.push(`${name} ${list.length} 站${hint ? `——${hint}` : ''}`);
    for (const x of list) parts.push(row(x, fn(x)));
  };
  sec('到点没收尾', r.overdue, (x) => `${fmtLeft(x.leftMin)}，到点 ${prettyDue(x.due)}`, '当场收尾：做完转待验收 / 到站；做不完写原因后 set-due 延一次');
  sec('审定过期', r.askDue, (x) => `审定期限 ${prettyDue(x.ask)}${x.budget ? `，预算 ${x.budget}` : ''}`, '按站上写好的默认方案开工：set-status <T编号> doing');
  sec('验收筐', r.bin, (x) => `验收期到 ${prettyDue(x.due)}，${fmtLeft(x.leftMin)}`, '不占带子、不挡后面的站；进度卡上收进「验收筐」');
  sec('在带上 · 干活', r.running, (x) => `${fmtLeft(x.leftMin)}，到点 ${prettyDue(x.due)}`);
  sec('在带上 · 等你验', r.reviewing, (x) => `验收期到 ${prettyDue(x.due)}，${fmtLeft(x.leftMin)}`);
  sec('排队', r.queued, (x) => `预算 ${x.budget}${x.ask ? `，审定期限 ${prettyDue(x.ask)}` : ''}`);
  if (r.untimed.length) parts.push(`另有 ${r.untimed.length} 站进行中但没计时（不在带上）：${r.untimed.map((x) => `#${x.id}`).join(' ')}`);
  return parts.length ? parts.join('\n') : '传送带上没有站。';
}

/* ---------- 操作：归档 / 恢复整个项目 ---------- */

/**
 * 归档整个项目：它在 TODO.md 里的所有任务行移入 ARCHIVE.md。
 * 做完的 → 按完成月份归入「## YYYY-MM」；没做完的 → 「## 未完成即归档」（线路图上是「停运」，不会变绿）。
 * 每行追加 archived:日期 was:原状态，恢复时靠 was: 原路放回。
 */
// undoneAs：归档时还没标完成的站怎么算。'dropped' = 停运（默认）；'done' = 其实做完了，按今天到站。
function archiveProject({ todoMd, archiveMd, historyMd = '', name, note = '', undoneAs = 'dropped', today = todayIso(), time = nowHm() }) {
  if (undoneAs !== 'dropped' && undoneAs !== 'done') throw new Error('没做完的站只能选「停运」或「算到站」');
  const todo = splitLines(todoMd);
  const arch = splitLines(archiveMd);

  const hits = [];
  eachTask(todo.lines, (t, i) => { if (t.project === name) hits.push({ ...t, index: i, raw: todo.lines[i] }); });
  if (!hits.length) {
    const already = listArchivedProjects(archiveMd).some((p) => p.name === name);
    throw new Error(already ? `「${name}」已经是归档状态` : `TODO.md 里找不到项目「${name}」的任务`);
  }
  // 只提醒「还没做完」的今日主目标；做完的任务被归档是再正常不过的事。
  const warnings = todayPlanWarnings(todo.lines, hits.filter((h) => h.status !== 'done').map((h) => h.id), today, '归档');

  for (const h of [...hits].sort((a, b) => b.index - a.index)) removeLineAt(todo.lines, h.index);
  updateProjectList(todo.lines, name, { add: false });
  setLastUpdated(todo.lines, today);

  const reg = findSection(arch.lines, ARCHIVED_PROJECTS_HEADING);
  if (reg) {
    for (let i = reg.end - 1; i > reg.start; i--) {
      if (new RegExp(`^- ${escapeRe(name)}\\s+archived:`).test(arch.lines[i])) arch.lines.splice(i, 1);
    }
  }
  const countsAsDone = (h) => h.status === 'done' || undoneAs === 'done';
  const doneCount = hits.filter(countsAsDone).length;
  appendToArchiveSection(arch.lines, ARCHIVED_PROJECTS_HEADING,
    `- ${name} archived:${today} 到站:${doneCount} 停运:${hits.length - doneCount}`);

  for (const h of hits) {
    const isDone = countsAsDone(h);
    let line = h.raw
      .replace(/^- \[[ xX]\]/, isDone ? '- [x]' : '- [ ]')
      .replace(/\sstatus:\S+/, ' status:archived')
      .replace(/\s(archived|was):\S+/g, '');
    // 归档时才认定做完的站：补上今天的到站日期（was: 仍记原状态，恢复项目时会连这个日期一起撤掉）
    if (isDone && !h.fields.done) line += ` done:${today}`;
    line += ` archived:${today} was:${h.status}`;
    const doneDate = h.fields.done || today;
    appendToArchiveSection(arch.lines, isDone ? `## ${doneDate.slice(0, 7)}` : DROPPED_HEADING, line);
  }
  setLastUpdated(arch.lines, today);

  const cleaned = cleanNote(note);
  const entry = `- ${today} ${time} 项目「${name}」｜归档（到站 ${doneCount} 站，停运 ${hits.length - doneCount} 站）${cleaned ? `｜${cleaned}` : ''}`;
  return {
    todoMd: todo.lines.join(todo.eol),
    archiveMd: tidyBlankLines(arch.lines).join(arch.eol),
    historyMd: prependHistory(historyMd, [entry]),
    summary: { project: name, moved: hits.length, done: doneCount, dropped: hits.length - doneCount, ids: hits.map((h) => h.id), warnings },
  };
}

/** 恢复项目：把带 was: 的任务行按原状态放回 TODO.md 对应分区，撤销「已归档项目」登记。 */
function restoreProject({ todoMd, archiveMd, historyMd = '', name, note = '', today = todayIso(), time = nowHm() }) {
  const todo = splitLines(todoMd);
  const arch = splitLines(archiveMd);

  if (!listArchivedProjects(archiveMd).some((p) => p.name === name)) throw new Error(`「${name}」不在已归档项目里`);

  const hits = [];
  eachTask(arch.lines, (t, i) => { if (t.project === name && t.fields.was) hits.push({ ...t, index: i, raw: arch.lines[i] }); });
  for (const h of [...hits].sort((a, b) => b.index - a.index)) arch.lines.splice(h.index, 1);

  const reg = findSection(arch.lines, ARCHIVED_PROJECTS_HEADING);
  for (let i = reg.end - 1; i > reg.start; i--) {
    const m = arch.lines[i].match(/^- (.+?)\s+archived:/);
    if (m && m[1].trim() === name) arch.lines.splice(i, 1);
  }
  removeEmptyArchiveSections(arch.lines);
  setLastUpdated(arch.lines, today);

  for (const h of hits) {
    const was = SECTION_BY_STATUS[h.fields.was] ? h.fields.was : 'paused';
    let line = h.raw
      .replace(/^- \[[ xX]\]/, was === 'done' ? '- [x]' : '- [ ]')
      .replace(/\sstatus:\S+/, ` status:${was}`)
      .replace(/\s(archived|was):\S+/g, '');
    // 原来没做完、归档时才「算到站」的：恢复 = 撤销，到站日期一并去掉
    if (was !== 'done') line = line.replace(/\sdone:\S+/g, '');
    insertIntoSection(todo.lines, SECTION_BY_STATUS[was], line);
  }
  updateProjectList(todo.lines, name, { add: true });
  setLastUpdated(todo.lines, today);

  const cleaned = cleanNote(note);
  const entry = `- ${today} ${time} 项目「${name}」｜恢复（放回 ${hits.length} 站）${cleaned ? `｜${cleaned}` : ''}`;
  return {
    todoMd: todo.lines.join(todo.eol),
    archiveMd: tidyBlankLines(arch.lines).join(arch.eol),
    historyMd: prependHistory(historyMd, [entry]),
    summary: { project: name, restored: hits.length, ids: hits.map((h) => h.id) },
  };
}

/* ---------- 验收台同步（2026-10-10 用户定：验收台和台账要一致，点完不用再问） ---------- */
// 验收台是 claude.ai 上的卡片页（链接见 CLAUDE.md），数据在页面自己的库里：cards/<T编号> 一张卡，reviews/<T编号> 你点的结果。
// 本机脚本读不到那个库，所以分三步：AI 用 ArtifactData 把 cards、reviews 导出到一个目录（<目录>/cards/T0xx.json、<目录>/reviews/T0xx.json），
// 版本号写进 <目录>/versions.json（{"reviews/T050":2,"cards/T050":3}）→ 跑 desk-sync 改台账 → AI 把 <目录>/writes.json 批量写回库。
// 页面 → 台账：通过 → 已到站（人工验收）；批注返工 → 进行中；归档 → 停运；稍后再看、撤回不动台账。
//   每次点击在变更记录里带「验收台 MM-DD HH:MM」（点的时间），再跑看到就跳过：库没写回也不会记两遍。
// 台账 → 页面：待验收里没卡的站补一张底稿卡（AI 再配截图和验法）；定过之后又交回待验收的站，卡回到「还没看」；
//   离开待验收、你还没定的卡收起来（hidden），回到待验收再放出来；卡上的验收期、交来日期跟着台账走。
const DESK_TARGET = { done: 'done', rework: 'doing', archive: 'dropped' };
const DESK_VERB = { done: '通过', rework: '返工', archive: '归档' };
const deskStamp = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

// 最近一次交来验收的时间：变更记录最新的在最上面，第一条「→ 待验收」就是。
function lastSubmitted(historyMd, id) {
  const re = new RegExp(`^- (\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}) #${id} [^｜]*｜[^｜]*→ 待验收`);
  for (const l of historyMd.split(/\r?\n/)) { const m = re.exec(l); if (m) return `${m[1]}T${m[2]}`; }
  return '';
}

function deskSync({ todoMd, archiveMd, historyMd = '', cards = {}, reviews = {}, versions = {}, now = new Date() }) {
  let cur = { todoMd, archiveMd, historyMd };
  const report = { applied: [], already: [], reset: [], hidden: [], shown: [], created: [], dated: [], errors: [], unpinned: [] };
  const W = new Map();
  const put = (collection, id, w) => {
    const key = `${collection}/${id}`; const exists = collection === 'cards' ? !!cards[id] : !!reviews[id];
    const entry = { ...w, collection, doc_id: id };
    if (exists) { if (versions[key]) entry.if_version = versions[key]; else report.unpinned.push(key); }
    W.set(key, entry);
  };
  const nowIso = now.toISOString();
  const marked = (id, stamp) => cur.historyMd.split(/\r?\n/).some((l) => l.includes(`#${id} `) && l.includes(`验收台 ${stamp}`));

  // 页面 → 台账
  const failed = new Set();
  for (const id of Object.keys(reviews).sort()) {
    const r = reviews[id] || {}; const target = DESK_TARGET[r.state];
    if (!target) continue;
    const stamp = deskStamp(r.at);
    const markApplied = () => { if (r.applied !== true) put('reviews', id, { op: 'update', data: { applied: true, appliedAt: nowIso } }); };
    if (r.applied === true) continue;
    if (marked(id, stamp)) { report.already.push(id); markApplied(); continue; }
    const note = `验收台 ${stamp} ${DESK_VERB[r.state]}${r.note ? `：${r.note}` : ''}`;
    try {
      const res = setTaskStatus({ ...cur, id, status: target, note, accept: target === 'done' ? 'me' : '', now });
      cur = { todoMd: res.todoMd, archiveMd: res.archiveMd, historyMd: res.historyMd };
      report.applied.push({ id, project: res.summary.project, from: res.summary.from, to: target, verb: DESK_VERB[r.state], note: r.note || '' });
      markApplied();
    } catch (e) { failed.add(id); report.errors.push(`#${id}：${e.message}`); }
  }

  // 台账 → 页面
  const all = {}; const lineOf = {};
  for (const md of [cur.todoMd, cur.archiveMd]) {
    const { lines } = splitLines(md);
    eachTask(lines, (t, i) => { if (!all[t.id]) { all[t.id] = t; lineOf[t.id] = lines[i]; } });
  }
  const inReview = (id) => !!all[id] && stationState(all[id]) === 'review';
  for (const id of Object.keys(all)) {
    if (!inReview(id)) continue;
    const t = all[id]; const card = cards[id]; const r = reviews[id];
    const due = (/\sdue:(\S+)/.exec(lineOf[id]) || [])[1] || '';
    const submitted = lastSubmitted(cur.historyMd, id); const created = t.fields.created || '';
    if (r && DESK_TARGET[r.state] && !failed.has(id)) {
      put('reviews', id, { op: 'set', data: { state: '', note: '', checks: [], at: nowIso, history: [...(r.history || []), { state: 'resubmit', note: '', at: nowIso }], applied: false, appliedAt: '' } });
      report.reset.push(id);
    }
    if (!card) {
      const body = (TASK_LINE_RE.exec(lineOf[id]) || [])[3] || '';
      const text = body.slice(body.indexOf('｜') + 1); const cut = text.indexOf('——');
      put('cards', id, { op: 'set', data: {
        project: t.project, title: cut >= 0 ? text.slice(0, cut) : text, summary: cut >= 0 ? text.slice(cut + 2) : '',
        open: '', checks: [], decide: [], checked: '', due, exec: t.fields.exec || '', images: [], sort: 0, created, submitted,
        noShot: '这张卡是台账自动补的底稿，AI 还没配截图和验法。要看画面就在批注里写「截图」或「录屏」。',
      } });
      report.created.push(id);
      continue;
    }
    const patch = {};
    if (card.hidden) patch.hidden = false;
    if (due && card.due !== due) patch.due = due;
    if (submitted && card.submitted !== submitted) patch.submitted = submitted;
    if (created && !card.created) patch.created = created;
    if (Object.keys(patch).length) {
      put('cards', id, { op: 'update', data: patch });
      if (card.hidden) report.shown.push(id); else report.dated.push(id);
    }
  }
  for (const id of Object.keys(cards).sort()) {
    if (inReview(id) || cards[id].hidden) continue;
    const r = reviews[id];
    if (!r || !DESK_TARGET[r.state]) { put('cards', id, { op: 'update', data: { hidden: true } }); report.hidden.push(id); }
  }

  return { ...cur, summary: { report, writes: [...W.values()] } };
}

function deskText({ report: r, writes }, writesFile) {
  const lab = (s) => STATE_LABEL[s] || s;
  const out = ['验收台同步：'];
  out.push(r.applied.length ? `  记进台账 ${r.applied.length} 条：` : '  没有新点的结果要记。');
  for (const a of r.applied) out.push(`    #${a.id} ${a.project}｜${a.verb}（${lab(a.from)} → ${lab(a.to)}）${a.note ? '｜' + a.note : ''}`);
  if (r.already.length) out.push(`  以前记过、只补「已记进台账」标记：${r.already.map((x) => '#' + x).join(' ')}`);
  if (r.reset.length) out.push(`  定过又交回来，卡回到「还没看」：${r.reset.map((x) => '#' + x).join(' ')}`);
  if (r.created.length) out.push(`  补底稿卡（还要配截图和验法）：${r.created.map((x) => '#' + x).join(' ')}`);
  if (r.hidden.length) out.push(`  已不在待验收、收起来：${r.hidden.map((x) => '#' + x).join(' ')}`);
  if (r.shown.length) out.push(`  回到待验收、放出来：${r.shown.map((x) => '#' + x).join(' ')}`);
  if (r.dated.length) out.push(`  卡上日期跟台账对齐：${r.dated.map((x) => '#' + x).join(' ')}`);
  if (r.errors.length) out.push('  没记上：', ...r.errors.map((e) => '    ' + e));
  if (r.unpinned.length) out.push(`  versions.json 里缺版本号（写回会被拒）：${r.unpinned.join(' ')}`);
  out.push(writes.length ? `  要写回验收台的改动 ${writes.length} 条 → ${writesFile}（ArtifactData batch，每批最多 50 条）` : '  验收台不用改。');
  return out.join('\n');
}

/* ---------- 落盘 ---------- */

function backup(root, files) {
  const dir = path.join(root, '.backup');
  const d = new Date();
  const stamp = `${todayIso(d).replace(/-/g, '')}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  let dest = path.join(dir, `ledger-${stamp}`);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `ledger-${stamp}-${n}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(dest, f));
  const old = fs.readdirSync(dir).filter((n) => n.startsWith('ledger-')).sort();
  for (const n of old.slice(0, Math.max(0, old.length - 30))) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  return dest;
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

const OPS = {
  'set-status': setTaskStatus, 'archive-project': archiveProject, 'restore-project': restoreProject,
  'set-due': (a) => setTaskDate({ ...a, key: 'due' }), 'set-ask': (a) => setTaskDate({ ...a, key: 'ask' }),
  'set-budget': (a) => setTaskDate({ ...a, key: 'budget' }),
  'desk-sync': deskSync,
};

/** 在磁盘上执行一次操作：重新读取 → 计算 → 备份 → 写回。计算出错时不会动任何文件。 */
function applyToDisk(op, args, root = DEFAULT_ROOT) {
  if (!OPS[op]) throw new Error(`不认识的操作「${op}」`);
  const files = { todoMd: 'TODO.md', archiveMd: 'ARCHIVE.md', historyMd: 'HISTORY.md' };
  const read = (f, fallback) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : fallback);
  const input = {
    todoMd: read(files.todoMd, null),
    archiveMd: read(files.archiveMd, '# Todo 归档\n\n> last_updated: \n'),
    historyMd: read(files.historyMd, ''),
    ...args,
  };
  if (input.todoMd === null) throw new Error('找不到 TODO.md');
  const result = OPS[op](input);
  const backupDir = backup(root, Object.values(files));
  for (const [key, file] of Object.entries(files)) {
    if (result[key] !== undefined && result[key] !== input[key]) writeAtomic(path.join(root, file), result[key]);
  }
  return { ...result.summary, backupDir };
}

/* ---------- 置顶 ---------- */
// 置顶是「我现在最关心这些」的标记，存在 pins.json（不进任务行，免得和别的工具改台账互相打扰）。
// 不记 HISTORY、不备份：随手点的开关，丢了重点一下就行。

const PINS_FILE = 'pins.json';

function readPins(root = DEFAULT_ROOT) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, PINS_FILE), 'utf8'));
    const list = (v) => (Array.isArray(v) ? [...new Set(v.map(String))] : []);
    return { projects: list(j.projects), tasks: list(j.tasks) };
  } catch (e) {
    return { projects: [], tasks: [] };
  }
}

function setPin({ kind, key, pinned }, root = DEFAULT_ROOT) {
  if (kind !== 'project' && kind !== 'task') throw new Error('置顶对象只能是项目或站点');
  key = String(key || '').trim().replace(/^#/, '');
  if (!key) throw new Error('没说要置顶哪一个');
  const pins = readPins(root);
  const list = kind === 'project' ? pins.projects : pins.tasks;
  const at = list.indexOf(key);
  if (pinned && at < 0) list.push(key);
  if (!pinned && at >= 0) list.splice(at, 1);
  writeAtomic(path.join(root, PINS_FILE), JSON.stringify(pins, null, 2) + '\n');
  return { kind, key, pinned: !!pinned };
}

module.exports = {
  readPins, setPin,
  setTaskStatus, setTaskDate, archiveProject, restoreProject, applyToDisk, dueMs, spanMin,
  beltReport, beltText, deskSync, deskText,
  listArchivedProjects, parseTaskLine, stationState, eachTask, splitLines, STATE_LABEL, ACCEPT_LABEL,
};

if (require.main === module) {
  const [op, ...rest] = process.argv.slice(2);
  try {
    if (op === 'list-projects') {
      const { lines } = splitLines(fs.readFileSync(path.join(DEFAULT_ROOT, 'TODO.md'), 'utf8'));
      const counts = {};
      eachTask(lines, (t) => { counts[t.project] = (counts[t.project] || 0) + 1; });
      for (const [k, v] of Object.entries(counts)) console.log(`${k}\t${v} 条`);
    // 变更记录里标明「命令行」，好和用户自己在线路图上点的区分开。
    // 命令行到站默认算「自动验收」（AI 自己判的）；用户亲口说「完成 T0xx」时加 --me 记成「人工验收」。
    } else if (op === 'set-status' && rest.length >= 2) {
      const flags = rest.filter((a) => a === '--auto' || a === '--me');
      const words = rest.filter((a) => !flags.includes(a));
      const accept = flags.includes('--me') ? 'me' : 'auto';
      const note = `[命令行] ${words.slice(2).join(' ')}`.trim();
      console.log(JSON.stringify(applyToDisk(op, { id: words[0].replace(/^#/, ''), status: words[1], note, accept }), null, 2));
    } else if ((op === 'set-due' || op === 'set-ask' || op === 'set-budget') && rest.length >= 2) {
      const note = `[命令行] ${rest.slice(2).join(' ')}`.trim();
      console.log(JSON.stringify(applyToDisk(op, { id: rest[0].replace(/^#/, ''), value: rest[1], note }), null, 2));
    } else if ((op === 'archive-project' || op === 'restore-project') && rest.length) {
      console.log(JSON.stringify(applyToDisk(op, { name: rest.join(' ').trim(), note: '[命令行]' }), null, 2));
    } else if ((op === 'pin' || op === 'unpin') && rest.length >= 2 && ['project', 'task'].includes(rest[0])) {
      console.log(JSON.stringify(setPin({ kind: rest[0], key: rest.slice(1).join(' '), pinned: op === 'pin' }), null, 2));
    } else if (op === 'belt') {
      const r = beltReport({ todoMd: fs.readFileSync(path.join(DEFAULT_ROOT, 'TODO.md'), 'utf8') });
      console.log(rest.includes('--json') ? JSON.stringify(r, null, 2) : beltText(r));
    } else if (op === 'desk-sync' && rest.some((a) => !a.startsWith('--'))) {
      const dir = path.resolve(rest.find((a) => !a.startsWith('--')));
      const readDir = (sub) => {
        const d = path.join(dir, sub); const m = {};
        if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) m[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        return m;
      };
      const vf = path.join(dir, 'versions.json');
      const args = { cards: readDir('cards'), reviews: readDir('reviews'), versions: fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf, 'utf8')) : {} };
      // --dry：只算不写台账，看看会改什么
      const out = rest.includes('--dry')
        ? deskSync({ todoMd: fs.readFileSync(path.join(DEFAULT_ROOT, 'TODO.md'), 'utf8'), archiveMd: fs.readFileSync(path.join(DEFAULT_ROOT, 'ARCHIVE.md'), 'utf8'), historyMd: fs.readFileSync(path.join(DEFAULT_ROOT, 'HISTORY.md'), 'utf8'), ...args }).summary
        : applyToDisk('desk-sync', args);
      const wf = path.join(dir, 'writes.json');
      fs.writeFileSync(wf, JSON.stringify(out.writes, null, 2) + '\n', 'utf8');
      console.log(rest.includes('--json') ? JSON.stringify(out.report, null, 2) : deskText(out, wf));
    } else if (op === 'pins') {
      console.log(JSON.stringify(readPins(), null, 2));
    } else {
      console.log('用法：\n  node tools/ledger.js set-status <T编号> <done|review|doing|todo|paused|dropped> [--me] [备注]（review = 待验收；done 默认记自动验收，用户说「完成」加 --me 记人工验收）\n  node tools/ledger.js set-budget <T编号> <30m|1h|none> [备注]（预算，开工自动计时）\n  node tools/ledger.js set-due <T编号> <2026-10-01|2026-10-01T15:00|15:00|+1h|none> [备注]（到点）\n  node tools/ledger.js set-ask <T编号> <YYYY-MM-DD|none> [备注]（审定期限）\n  node tools/ledger.js belt [--json]（传送带巡检：到点没收尾 / 审定过期 / 验收筐）\n  node tools/ledger.js desk-sync <导出目录> [--dry]（验收台同步：你点的结果进台账，待验收的站上卡）\n  node tools/ledger.js archive-project <项目名>\n  node tools/ledger.js restore-project <项目名>\n  node tools/ledger.js pin|unpin project <项目名>\n  node tools/ledger.js pin|unpin task <T编号>\n  node tools/ledger.js pins\n  node tools/ledger.js list-projects');
      process.exit(1);
    }
  } catch (e) {
    console.error('失败：' + e.message);
    process.exit(1);
  }
}
