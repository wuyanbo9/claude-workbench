export type TodoItem = { id: string; kind: 'decide' | 'do' | 'run'; text: string; where?: string; say?: string; options?: string[]; from?: string; added: string }

declare module 'claude-code' {
  interface PluginState {
    'owner-todo': { items: Shaped<TodoItem[]> }
  }
}
