## v0.2.1 — 设置页更新说明渲染

### 改进

- **设置页「关于」分区支持 Markdown 渲染**：当前版本的更新说明不再以原始 markdown 符号显示，而是渲染为正常的标题、列表、粗体、代码块格式
- 自实现极简 markdown 渲染函数，无外部依赖
- 同步更新 RELEASING.md 发布流程文档

### 修复

- 修正 UpdateService 中 logger status 字段值不符合类型定义的编译错误
