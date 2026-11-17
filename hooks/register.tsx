import { atom, read, update } from 'claude-code'
// footer: stats line + open issues (see refreshFooter)
import type { EngineInterface, Register } from 'claude-code'

import type { Footer, TodoItem } from '../types'
import { age, commitCount, countLines, fmtCount, headSha, issues as fetchIssues, probe, projectKey, projectName, type Probe, type StatsConfig } from './footer'

const PANE = 'owner-todo'
const TITLE = '工作台'
const STORE_KEY = 'items-1'
const items = atom({ plugin: 'owner-todo', key: 'items' } as const, [] as TodoItem[], { shape: 'items-1' })

const footer = atom({ plugin: 'owner-todo', key: 'footer' } as const, null as Footer | null, { shape: 'footer-1' })
const expanded = atom({ plugin: 'owner-todo', key: 'issuesExpanded' } as const, false, { shape: 'expanded-1' })
const EXPANDED_KEY = 'issuesExpanded'
const STATS_KEY = 'stats'
const LINES_KEY = 'lines-1'
const FOOTER_EVERY = 5 * 60 * 1000

// The footer's data, refreshed on session start and every 5 minutes while the pane is up.
// A failed refresh keeps the last numbers; nothing is ever drawn about a failure.
let probed: { cwd: string; p: Probe } | null = null
let linesBusy = false
async function refreshFooter($: EngineInterface) {
  const cwd = await $.session.cwd()
  if (!probed || probed.cwd !== cwd) probed = { cwd, p: await probe($, cwd) }
  const p = probed.p
  if (!p.git) return void (await update($, footer, () => null))
  const [commits, gh] = await Promise.all([commitCount($, cwd), p.owner && p.name ? fetchIssues($, cwd, p.owner, p.name) : Promise.resolve(null)])
  await update($, footer, cur => ({
    ...(cur ?? {}),
    ...(commits !== null ? { commits } : {}),
    ...(gh ?? {}),
    ...(!p.owner ? { issuesTotal: undefined, openCount: undefined, open: undefined, repoUrl: undefined } : {}),
  }))
  // lines: cached by cwd + HEAD + config; one count at a time
  const sha = await headSha($, cwd)
  if (!sha || linesBusy) return
  const cfg = ((await $.store.get(STATS_KEY)) as StatsConfig | undefined) ?? {}
  const key = `${cwd}|${sha}|${JSON.stringify(cfg)}`
  const cached = (await $.store.get(LINES_KEY)) as { key: string; n: number } | undefined
  if (cached?.key === key) return void (await update($, footer, cur => ({ ...(cur ?? {}), lines: cached.n })))
  linesBusy = true
  try {
    const n = await countLines($, cwd, cfg)
    if (n !== null) {
      await $.store.set(LINES_KEY, { key, n })
      await update($, footer, cur => ({ ...(cur ?? {}), lines: n }))
    }
  } catch {
    // keep the last number
  } finally {
    linesBusy = false
  }
}

const TOOL = 'owner_todo'
const DESCRIPTION = [
  "Any session may add cards for the owner; a button press answers the session that added the card. Keeps the owner's side pane (待你决定 / 待你执行) up to date. Call it whenever a reply adds or settles an item.",
  'action "add": kind "decide" (a real choice or approval only the owner can give), "run" (a task now running in some session: text = what, where = that session\'s own title exactly as the sidebar shows it; mark done when it finishes) or "do" (an owner-only action whose',
  'prerequisite is already done, e.g. run a deploy step), text (short Chinese), optional where (which session or page) and say',
  '(the exact words to type); for a choice give options (buttons, recommended first). action "done": id (or "all" with kind). action "list": returns the current items.',
].join(' ')

// 'YYYY-MM-DD HH:MM' in the machine's own time zone (toISOString would be UTC)
const localStamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const REPLY_KEY = 'replies-1'
type Reply = { id: string; to: string; text: string }

// A press answers the session that added the card: here, or queued for that session to pick up.
async function deliver($: EngineInterface, to: string | undefined, text: string) {
  const me = await $.session.id()
  if (!to || to === me) return void (await $.prompt.submit({ text }))
  const q = ((await $.store.get(REPLY_KEY)) as Reply[] | undefined) ?? []
  await $.store.set(REPLY_KEY, [...q, { id: Math.random().toString(36).slice(2, 9), to, text }])
}

async function pickUpReplies($: EngineInterface) {
  const me = await $.session.id()
  const q = ((await $.store.get(REPLY_KEY)) as Reply[] | undefined) ?? []
  const mine = q.filter(r => r.to === me)
  if (!mine.length) return
  await $.store.set(REPLY_KEY, q.filter(r => r.to !== me))
  for (const r of mine) await $.prompt.submit({ text: r.text })
}

const TITLES_KEY = 'titles-1'
async function titleOf($: EngineInterface, sid: string, seen: string | undefined): Promise<string | undefined> {
  const all = ((await $.store.get(TITLES_KEY)) as Record<string, string> | undefined) ?? {}
  const t = seen?.trim()
  if (!t) return all[sid]
  if (all[sid] !== t) {
    // keep the 200 most recent
    const next = Object.fromEntries([...Object.entries(all).filter(([k]) => k !== sid), [sid, t]].slice(-200))
    await $.store.set(TITLES_KEY, next)
  }
  return t
}

async function writeList($: EngineInterface, fn: (l: TodoItem[]) => TodoItem[]) {
  const fresh = ((await $.store.get(STORE_KEY)) as TodoItem[] | undefined) ?? []
  const next = fn(fresh)
  await $.store.set(STORE_KEY, next)
  await update($, items, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get(STORE_KEY)) as TodoItem[] | undefined
    if (Array.isArray(stored)) await update($, items, () => stored)
    await $.tool.register({
      name: TOOL,
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'done', 'list'] },
          kind: { type: 'string', enum: ['decide', 'do', 'run'] },
          text: { type: 'string' },
          where: { type: 'string' },
          say: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: 'decide only: choices shown as buttons (2–4, each ≤ 8 characters); the first is the recommended one' },
          id: { type: 'string' },
        },
        required: ['action'],
      },
    })
    await $.command.register({ name: 'todo', description: '打开工作台面板（正在运行 + 待你处理）' })
    // every session shares the store: open only when something waits, and pick up other sessions' changes
    // the workbench is meant to stay beside the chat: open it at every start
    void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(4000, () => pickUpReplies($))
    $.clock.every(15000, async () => {
      const fresh = (await $.store.get(STORE_KEY)) as TodoItem[] | undefined
      if (!Array.isArray(fresh)) return
      const cur = await read($, items)
      if (JSON.stringify(fresh) === JSON.stringify(cur)) return
      await update($, items, () => fresh)
      if (fresh.some(x => !cur.some(y => y.id === x.id))) void $.ui.open({ id: PANE, title: TITLE })
    })
    const wasExpanded = await $.store.get(EXPANDED_KEY)
    if (typeof wasExpanded === 'boolean') await update($, expanded, () => wasExpanded)
    void refreshFooter($).catch(() => {})
    $.clock.every(FOOTER_EVERY, async () => {
      // nothing is fetched while the pane is closed
      if (!(await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)) return
      await refreshFooter($).catch(() => {})
    })
    return next(e)
  })

  // Automatic 「正在运行」 rows: while a session with this plugin runs a turn, its own row (title + what it was asked)
  // sits in the shared list; the row goes when the turn stops. Rows left by a session that died go after 6 hours.
  const autoId = (sid: string) => `auto-${sid}`
  // The sidebar title reaches a hook only with some events (and a new session gets one after its first prompt):
  // remember the last one seen per session and use it when an event comes without.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    await titleOf($, e.session_id, (e as unknown as { session_title?: string }).session_title)
    return r
  })
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id) return r
    const title = (await titleOf($, e.session_id, (e as unknown as { session_title?: string }).session_title)) || (await $.session.cwd()).split('/').pop() || '—'
    // a message from another session arrives wrapped in a tag: show what it says, not the wrapper
    const raw = String((e as unknown as { prompt?: string }).prompt ?? '')
    const text =
      raw
        // system reminders (link notices, worktree info) ride along with the prompt: drop them whole
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/^\s*Background \(from the session that started this one\):\s*/i, '')
        .replace(/^\s*[（(][^）)]{0,20}[）)]/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || '…'
    const project = await projectKey($, await $.session.cwd())
    const id = autoId(e.session_id)
    const cutoff = Date.now() - 6 * 3600 * 1000
    await writeList($, l => [
      ...l.filter(x => x.id !== id && !(x.id.startsWith('auto-') && Date.parse(x.added.replace(' ', 'T')) < cutoff)),
      { id, kind: 'run', text, where: title, project, added: localStamp() },
    ])
    void $.ui.open({ id: PANE, title: TITLE })
    return r
  })
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (!e.agent_id) await writeList($, l => l.filter(x => x.id !== autoId(e.session_id)))
    return r
  })

  // Every session that has the tool is told to use it, whatever project it is in:
  // a question for the person goes to the pane as a card, not only into the chat.
  const USE_IT = [
    'The owner_todo tool feeds the 工作台 side pane, where this person answers you with buttons.',
    'Whenever a reply asks them to choose or approve something (even a small yes/no), call owner_todo add in that same reply:',
    'kind "decide", short text, 2–4 options of at most 8 characters, recommended first. For an action only they can take, use kind "do".',
    'A press arrives as their next message. Mark an item done as soon as it is settled another way.',
  ].join(' ')
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!e.tools.some(t => t.endsWith('owner_todo'))) return r
    return { sections: [...r.sections, { id: 'owner-todo:use', text: USE_IT, scope: 'session' as const }] }
  })

  on('command.run', { command: 'todo' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '已打开工作台。' }
  })

  on('tool.call', { tool: 'mcp__owner-todo__owner_todo' }, async ($, e) => {
    const input = e as unknown as Record<string, string>
    const action = input.action
    let note = ''
    if (action === 'add') {
      if (!input.text || (input.kind !== 'decide' && input.kind !== 'do' && input.kind !== 'run')) return { deny: 'add needs kind (decide|do|run) and text' }
      const item: TodoItem = {
        id: Math.random().toString(36).slice(2, 7),
        kind: input.kind,
        text: input.text,
        where: input.where || undefined,
        say: input.say || undefined,
        options: Array.isArray((input as unknown as { options?: unknown }).options) ? ((input as unknown as { options: string[] }).options).slice(0, 4) : undefined,
        from: await $.session.id(),
        project: await projectKey($, await $.session.cwd()),
        added: localStamp(),
      }
      await writeList($, list => [...list, item])
      note = `added ${item.id}`
    } else if (action === 'done') {
      if (!input.id) return { deny: 'done needs id (or "all" with kind)' }
      await writeList($, list =>
        list.filter(x => !(input.id === 'all' ? !input.kind || x.kind === input.kind : x.id === input.id)),
      )
      note = `removed ${input.id}`
    } else if (action !== 'list') return { deny: 'action must be add, done or list' }
    const now = await read($, items)
    if (action === 'add') void $.ui.open({ id: PANE, title: TITLE })
    const lines = now.map(x => `${x.id} [${x.kind}] ${x.added} ${x.text}${x.where ? ` @${x.where}` : ''}${x.say ? ` 「${x.say}」` : ''}`)
    return { result: [note, ...lines].filter(Boolean).join('\n') || '(empty)' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, items)
    const f = await read($, footer)
    const isOpen = await read($, expanded)
    const answer = async (x: TodoItem, reply: string) => {
      await writeList($, l => l.filter(y => y.id !== x.id))
      await deliver($, x.from, reply)
    }
    // a session already listed by hand isn't listed again by its own automatic row
    const byHand = new Set(list.filter(x => x.kind === 'run' && !x.id.startsWith('auto-')).map(x => x.where))
    const running = list
      .filter(x => x.kind === 'run' && !(x.id.startsWith('auto-') && byHand.has(x.where)))
      .sort((a, b) => b.added.localeCompare(a.added))
    // running rows grouped by project, this session's project first, then the most recently active
    const here = await projectKey($, await $.session.cwd())
    const groups: { key: string; rows: TodoItem[] }[] = []
    for (const x of running) {
      const key = x.project ?? ''
      const g = groups.find(g => g.key === key)
      if (g) g.rows.push(x)
      else groups.push({ key, rows: [x] })
    }
    groups.sort((a, b) => Number(b.key === here) - Number(a.key === here) || Number(!!b.key) - Number(!!a.key))
    const todos = [...list.filter(x => x.kind === 'decide'), ...list.filter(x => x.kind === 'do')]

    const runRow = (x: TodoItem) => (
      <Box key={`run-${x.id}`} flexDirection="row" alignItems="center" gap="sm">
        <Box flexShrink={0}>
          <Text size="footnote" weight="bold" color="claude">
            {x.where || '—'}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text size="footnote" wrap="truncate-end">
            {x.text}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text size="caption" color="inactive" tabular>
            {x.added.slice(11, 16)}
          </Text>
        </Box>
      </Box>
    )

    const buttons = (x: TodoItem) => {
      if (x.kind === 'do')
        return [<Button key={`done-${x.id}`} label="已完成" variant="primary" onPress={() => answer(x, `已完成：${x.text}`)} />]
      if (x.options?.length)
        return x.options.map((o, n) => (
          <Button key={`opt-${x.id}-${n}`} label={o} variant={n === 0 ? 'primary' : 'secondary'} onPress={() => answer(x, `${x.text}：${o}`)} />
        ))
      return [
        <Button key={`yes-${x.id}`} label="同意" variant="primary" onPress={() => answer(x, x.say ? x.say : `同意：${x.text}`)} />,
        <Button key={`no-${x.id}`} label="不同意" variant="secondary" onPress={() => answer(x, `不同意：${x.text}`)} />,
      ]
    }

    const card = (x: TodoItem) => {
      const decide = x.kind === 'decide'
      return (
        <Box key={`card-${x.id}`} flexDirection="column" backgroundColor={decide ? '#d9a40014' : '#2f9e5a14'} paddingX="md" paddingY="md" gap="sm">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
            <Box backgroundColor={decide ? '#d9a4002e' : '#2f9e5a2e'} paddingX="xs" alignSelf="flex-start" flexShrink={0}>
              <Text size="caption" weight="semibold" color={decide ? 'warning' : 'success'}>
                {decide ? '决定' : '执行'}
              </Text>
            </Box>
            {(x.where || (x.project && x.project !== here)) && (
              <Box flexShrink={1} minWidth={0}>
                <Text size="caption" color="inactive" wrap="truncate-end">
                  {[x.project && x.project !== here ? projectName(x.project) : '', x.where ?? ''].filter(Boolean).join(' · ')}
                </Text>
              </Box>
            )}
          </Box>
          <Text size="body" weight="semibold">
            {x.text}
          </Text>
          {x.say && (
            <Text size="footnote" mono>
              「{x.say}」
            </Text>
          )}
          <Box flexDirection="row" flexWrap="wrap" justifyContent="flex-end" gap="sm" marginTop="xs">
            {buttons(x)}
          </Box>
        </Box>
      )
    }

    // footer (SPEC v5 A): an Issues card after the todo cards, a small stats line at the very bottom.
    // With nothing running and nothing to do there is no empty-state mark: just the Issues card and the stats.
    const openCount = f?.openCount ?? 0
    const toggle = async () => {
      const next = !(await read($, expanded))
      await $.store.set(EXPANDED_KEY, next)
      await update($, expanded, () => next)
    }

    const HOVER = '#80808018'
    const statParts = [
      f?.lines !== undefined && { k: 'lines', value: fmtCount(f.lines), label: ' 行代码' },
      f?.commits !== undefined && { k: 'commits', value: fmtCount(f.commits), label: ' 次提交' },
    ].filter(Boolean) as { k: string; value: string; label: string }[]
    const statsLine = statParts.length > 0 && (
      <Box key="stats" paddingX="md" paddingBottom="md">
        <Text size="caption" color="inactive" tabular>
          {statParts.flatMap((x, i) => [
            i > 0 ? ' · ' : '',
            <Text key={`v-${x.k}`} weight="medium" color="text">
              {x.value}
            </Text>,
            x.label,
          ])}
        </Text>
      </Box>
    )
    const issuesCard = openCount > 0 && (
      <Box key="issues" flexDirection="column" backgroundColor="#80808014" paddingX="md" paddingY="sm" gap="xs">
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap="sm">
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Text size="footnote" weight="semibold">
              Issues
            </Text>
            <Text size="footnote" color="inactive" tabular>
              {openCount}
            </Text>
          </Box>
          <Button key="issues-toggle" plain dimColor label={isOpen ? '收起' : '展开'} onPress={toggle} />
        </Box>
        {isOpen && (
          <Box flexDirection="column">
            {(f?.open ?? []).slice(0, 8).map(i => (
              <Box key={`iss-${i.number}`} flexDirection="row" alignItems="center" gap="sm" paddingY="xs" hover={{ backgroundColor: HOVER }}>
                <Box flexShrink={0}>
                  <Text size="footnote" color="inactive" tabular>
                    #{i.number}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text size="footnote" wrap="truncate-end">
                    {i.title}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Text size="caption" color="inactive" tabular>
                    {age(i.createdAt)}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Link href={i.url}>↗</Link>
                </Box>
              </Box>
            ))}
            {openCount > 8 && f?.repoUrl && (
              <Box key="iss-more" flexDirection="row" alignItems="center" gap="xs" paddingY="xs">
                <Text size="footnote" color="inactive">{`还有 ${openCount - 8} 个`}</Text>
                <Link href={`${f.repoUrl}/issues`}>↗</Link>
              </Box>
            )}
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap="md">
        {running.length > 0 && (
          <Box flexDirection="column" backgroundColor="#d977571a" paddingX="md" paddingY="sm" gap="md">
            {groups.map(g => (
              <Box key={`grp-${g.key || 'none'}`} flexDirection="column" gap="sm">
                {g.key && (
                  <Text size="caption" weight="semibold" color="inactive">
                    {projectName(g.key)}
                  </Text>
                )}
                {g.rows.map(runRow)}
              </Box>
            ))}
          </Box>
        )}
        {todos.length > 0 && (
          <Box flexDirection="column" gap="sm">
            {todos.map(card)}
          </Box>
        )}
        {issuesCard}
        {statsLine}
      </Box>
    )
  })
}
