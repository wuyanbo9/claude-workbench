export type TodoItem = { id: string; kind: 'decide' | 'do' | 'run'; text: string; where?: string; say?: string; options?: string[]; from?: string; project?: string; added: string }

export type FooterIssue = { number: number; title: string; url: string; createdAt: string }
// What the pane's footer draws; a missing field is simply not drawn.
export type Footer = {
  lines?: number
  commits?: number
  issuesTotal?: number
  openCount?: number
  open?: FooterIssue[]
  repoUrl?: string
}

declare module 'claude-code' {
  interface PluginState {
    'owner-todo': { items: Shaped<TodoItem[]>; footer: Shaped<Footer | null>; issuesExpanded: Shaped<boolean> }
  }
}
