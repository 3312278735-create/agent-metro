# Todo 台账

> last_updated: 2026-10-12
> next_task_id: T013

## 使用方式

这是**示例台账**：两个演示项目（「示例游戏」「个人网站」）+ 一个已归档项目。双击 `打开地铁图.bat` 就能看到它画成的线路图。换成你自己的项目时，删掉下面各分区里的任务行、改 `projects/` 里的项目页即可（分区标题别删）。

你可以直接用自然语言让 AI 更新，例如：

- 新增：项目名，任务内容，截止日，优先级。
- 完成 T001。 / T001 改成进行中。 / T001 延期到 2026-06-20。
- 把已完成的归档。
- 总览 / 现在都到哪了。
- 推进 T005。（AI 到对应项目目录里开工，干完回写本台账）
- 去验收 T004。（AI 帮你准备验收：对照图 + 验收标准）

**需求线路图**：每个项目一条线，每个需求一站。绿 = 已到站，橙 = 等你验收，蓝 = 在做，灰 = 还没开工。点一站（或右键）可以改状态、写备注；线路左侧可以归档 / 恢复整个项目；图钉 = 置顶（记在 `pins.json`）。每次改动记进 `HISTORY.md`，操作前台账自动备份到 `.backup/`。

## 任务格式

标准记录格式：

```markdown
- [ ] #T001 项目名｜任务内容 due:2026-06-20 status:todo priority:P2 exec:mixed created:2026-06-15
```

字段规则：

- `#T001`：任务编号，新增任务时用文件头的 `next_task_id`，再把它加 1。
- `项目名`：一个项目一条线，和 `projects/<项目名>.md` 对应。
- `due`：到点（截止）；没有写 `due:none`。也可以带时刻：`due:2026-10-12T18:00`。
- `status`：`todo`、`doing`、`review`、`done`、`paused`。`review` = 待验收：AI 能做的已做完，等你验收 / 拍板，你说「完成」才变 `done`。
- `priority`：`P1` 重要，`P2` 普通，`P3` 低优先级。
- `exec`：谁来做。`ai` = AI 可端到端完成并用命令自证；`mixed` = AI 做完后由你验收；`me` = 只能你自己做。没写按 `mixed` 处理。
- `budget`：AI 最多花多久（`30m`、`1h`、`2h`）。转进行中时自动计时：到点 = 开工时刻 + 预算。
- `ask`：等你拍板的期限；过期 AI 按站上写好的默认方案开工。
- `accept`：谁验收的。`auto` = AI 自查后到站（自动验收），`me` = 你亲手验收。
- `created` 创建日期；完成后追加 `done:YYYY-MM-DD`。
- 字段顺序：`due` → `status` → `priority` 必须按这个顺序紧挨着写，其后的字段顺序随意。
- 任务行只写一句话，开头半句要能单独看懂（线路图上的站名取「——」或「：」之前那段）；过程、验收步骤写进 `projects/<项目名>.md`。

## 进行中（doing）

- [ ] #T005 示例游戏｜存档功能——关卡进度、金币写进本地存档，重开游戏接着玩 due:2026-10-12T18:00 status:doing priority:P1 exec:mixed created:2026-10-10 budget:2h
- [ ] #T010 个人网站｜手机版排版——导航收成汉堡菜单，文章页字号放大 due:none status:doing priority:P2 exec:ai created:2026-10-11

## 待验收（review）

> AI 能做的部分已做完，球在你这边：照项目页「待你验收」验完说「完成 T0xx」；有问题告诉 AI，改回进行中。

- [ ] #T004 示例游戏｜主菜单——开始 / 继续 / 设置三个按钮，背景音乐可关 due:2026-10-14 status:review priority:P2 exec:mixed created:2026-10-08 budget:1h
- [ ] #T009 个人网站｜深色模式——跟随系统，右上角可手动切换 due:2026-10-13 status:review priority:P2 exec:mixed created:2026-10-09 budget:1h

## 未开始（todo）

- [ ] #T006 示例游戏｜第二关：加移动平台和收集品 due:none status:todo priority:P2 exec:mixed created:2026-10-10 budget:3h
- [ ] #T007 示例游戏｜音效：跳跃、拾取、受伤三种音效 due:none status:todo priority:P3 exec:ai created:2026-10-10 budget:30m
- [ ] #T011 个人网站｜评论区：选一个评论服务接进文章页——等你定用哪家，不回就按默认（不用登录的那家） due:none status:todo priority:P2 exec:mixed created:2026-10-11 budget:1h ask:2026-10-13

## 每日任务（repeat:daily）

暂无。

## 暂停 / 搁置（paused）

- [ ] #T008 示例游戏｜联机对战——等单机版做完再说 due:none status:paused priority:P3 exec:mixed created:2026-10-10 paused:2026-10-10

## 已完成 · 待归档（done）

> 你说「把已完成的归档」时，这里会整体移入 ARCHIVE.md。

- [x] #T001 示例游戏｜跑通第一个关卡——角色能走、能跳、能过关 due:none status:done priority:P1 exec:mixed created:2026-10-01 done:2026-10-05 accept:me
- [x] #T002 示例游戏｜关卡选择界面 due:none status:done priority:P2 exec:mixed created:2026-10-03 done:2026-10-07 accept:me
- [x] #T003 示例游戏｜修复跳跃卡墙——贴墙跳不再卡住 due:none status:done priority:P2 exec:ai created:2026-10-06 budget:30m done:2026-10-07 accept:auto
- [x] #T012 个人网站｜首页和文章列表 due:none status:done priority:P2 exec:mixed created:2026-10-02 done:2026-10-06 accept:me

## 归档

已归档任务统一保存在 [ARCHIVE.md](ARCHIVE.md)，按月份分组，这里不重复罗列。

## 项目清单

> 记录出现过的项目名，方便新增任务时对齐叫法。

示例游戏 · 个人网站
