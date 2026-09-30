# 知识内容模板

内置模板以独立 Markdown 文件维护：

- [Content](../apps/desktop/src/shared/knowledge-templates/content.md)
- [Idea](../apps/desktop/src/shared/knowledge-templates/idea.md)
- [Question](../apps/desktop/src/shared/knowledge-templates/question.md)

`shared/knowledge.ts` 加载模板，构建时将 Markdown 内容打包到应用中。新 Vault 初始化时写入 `wiki/_types.json` 的对应 ObjectType 的 `template` 字段；已有 Vault 的模板仍由对象类型编辑器管理，不会自动覆盖。

模板指导写作，不要求填满固定栏目。按 Content、Idea、Question 选择写作方式，再按聊天、邮件、文档保留来源身份和上下文。示例中的人名与方案仅示意句式，不得直接写入生成内容。

[知识质量修复样例](knowledge-quality-examples.md)提供具体处理示例。

## 已确认的类型调整（待实现）

删除 `page` 和 `content` 两个 ObjectType，统一使用现有的 `note`，保留其 tags 属性。Page 仅作为所有 Wiki 页面的通称。默认 Content Goal 改为 Note Goal，Content 模板对应改为 Note 模板；Idea 和 Question 保留独立类型。

本节记录已确认的设计结论，当前代码和上述模板路径尚未调整。Note Goal 已确认：“从原始资料中提取值得复用的事实、经验和方法，整理成主题明确、可独立理解的笔记，并保留人物、背景和来源。”
