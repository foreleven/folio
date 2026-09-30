import { SystemOneGoal } from '@folio/agent/config/schema'
import { Schema } from 'effect'
import contentTemplate from './knowledge-templates/content.md?raw'
import ideaTemplate from './knowledge-templates/idea.md?raw'
import questionTemplate from './knowledge-templates/question.md?raw'

export const KnowledgeGoal = SystemOneGoal
export type KnowledgeGoal = typeof KnowledgeGoal.Type
export const VaultConfig = Schema.Struct({
  knowledgeGoals: Schema.Array(KnowledgeGoal).check(Schema.makeFilter(goals => new Set(goals.map(goal => goal.id)).size === goals.length,
    { expected: 'unique Knowledge goal IDs' }))
})
export type VaultConfig = typeof VaultConfig.Type

export const defaultKnowledgeGoals: readonly KnowledgeGoal[] = [
  { id: 'content', description: '将原始资料整理成主题明确、结构清晰、可独立阅读的笔记、文章、研究文档或方案，并保留来源依据。' },
  { id: 'idea', description: '捕捉原始资料中尚未成型的想法、灵感、假设、观点或方向，用简短内容保留其原意、来源和未确定之处。' },
  { id: 'question', description: '从原始资料中识别尚未解决的问题，简要记录问题本身、相关背景和已有线索，并保留来源。' }
]
export const defaultVaultConfig: VaultConfig = { knowledgeGoals: [...defaultKnowledgeGoals] }
export const KNOWLEDGE_TODO_FILE = '_intake-todo.md'

/** Markdown defaults are bundled for both the main process and the renderer. */
export const knowledgeTemplates: Readonly<Record<string, string>> = {
  content: contentTemplate.trim(),
  idea: ideaTemplate.trim(),
  question: questionTemplate.trim()
}
