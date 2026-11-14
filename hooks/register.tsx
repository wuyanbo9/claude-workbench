import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TodoItem } from '../types'

const PANE = 'owner-todo'
const TITLE = '工作台'
const STORE_KEY = 'items-1'
const items = atom({ plugin: 'owner-todo', key: 'items' } as const, [] as TodoItem[], { shape: 'items-1' })

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
    return next(e)
  })

  // Automatic 「正在运行」 rows: while a session with this plugin runs a turn, its own row (title + what it was asked)
  // sits in the shared list; the row goes when the turn stops. Rows left by a session that died go after 6 hours.
  const autoId = (sid: string) => `auto-${sid}`
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id) return r
    const title = (e as unknown as { session_title?: string }).session_title || (await $.session.cwd()).split('/').pop() || '—'
    // a message from another session arrives wrapped in a tag: show what it says, not the wrapper
    const raw = String((e as unknown as { prompt?: string }).prompt ?? '')
    const text =
      raw
        .replace(/<[^>]*>/g, ' ')
        .replace(/^\s*[（(][^）)]{0,20}[）)]/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || '…'
    const id = autoId(e.session_id)
    const cutoff = Date.now() - 6 * 3600 * 1000
    await writeList($, l => [
      ...l.filter(x => x.id !== id && !(x.id.startsWith('auto-') && Date.parse(x.added.replace(' ', 'T')) < cutoff)),
      { id, kind: 'run', text, where: title, added: localStamp() },
    ])
    void $.ui.open({ id: PANE, title: TITLE })
    return r
  })
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (!e.agent_id) await writeList($, l => l.filter(x => x.id !== autoId(e.session_id)))
    return r
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, items)
    const answer = async (x: TodoItem, reply: string) => {
      await writeList($, l => l.filter(y => y.id !== x.id))
      await deliver($, x.from, reply)
    }
    // a session already listed by hand isn't listed again by its own automatic row
    const byHand = new Set(list.filter(x => x.kind === 'run' && !x.id.startsWith('auto-')).map(x => x.where))
    const running = list
      .filter(x => x.kind === 'run' && !(x.id.startsWith('auto-') && byHand.has(x.where)))
      .sort((a, b) => b.added.localeCompare(a.added))
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
        <Box key={`card-${x.id}`} flexDirection="column" borderStyle="round" borderColor="subtle" padding="md" gap="sm">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
            <Box backgroundColor={decide ? '#d9a4002e' : '#2f9e5a2e'} paddingX="xs" alignSelf="flex-start" flexShrink={0}>
              <Text size="caption" weight="semibold" color={decide ? 'warning' : 'success'}>
                {decide ? '决定' : '执行'}
              </Text>
            </Box>
            {x.where && (
              <Box flexShrink={1} minWidth={0}>
                <Text size="caption" color="inactive" wrap="truncate-end">
                  {x.where}
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

    return (
      <Box flexDirection="column" flexGrow={1} height="100%">
        {running.length > 0 && (
          <Box flexDirection="column" backgroundColor="#d977571a" paddingX="md" paddingY="sm" gap="sm">
            {running.map(runRow)}
          </Box>
        )}
        {todos.length > 0 && (
          <Box flexDirection="column" paddingX="md" paddingY="md" gap="sm">
            {todos.map(card)}
          </Box>
        )}
        {running.length === 0 && todos.length === 0 && (
          <Box flexDirection="column" flexGrow={1} height="100%" alignItems="center" justifyContent="center" gap="sm" paddingBottom="xl">
            <Text size="title" weight="semibold" color="success">
              ✓
            </Text>
            <Text size="body" color="inactive">
              都处理完了
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
