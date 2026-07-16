## v0.3.1 — OCR + 大模型双管线（Beta · 稳定性更新）

本次版本为 v0.3.0 的稳定性更新，延续 OCR + 大模型双管线架构，并对 OCR 证据传输与 observation 归一化做了可靠性优化。

### 稳定性更新（v0.3.1）

- 优化 OCR 证据传输格式：blocks 改用紧凑 tuple `[id, text, confidence?]`，减少模型 token 消耗
- 新增 `full_text` 模式：对未被 delta/exact_reuse 引用的帧，自动选择更小的 `full_text` 替代完整 `full` blocks
- `ObservationNormalizer` 在 visibleContent 附加本地 OCR 证据，便于后续追溯
- `OcrFrameProcessor` commit 时清理 batchFrameIndex，避免跨批次上下文污染
- block id 前缀缩短为 `b`，进一步压缩传输体积
- prompt 规则同步更新，说明新增 `full_text` 模式与紧凑 tuple 格式

---

以下为 v0.3.0 的原始发布说明：

## v0.3.0 — OCR + 大模型双管线（Beta）

本次版本为**重大架构升级**，引入 Windows OCR 与多模态大模型并行的双管线识别机制，显著提升屏幕文字内容的识别保真度。

### 新增

- **Windows OCR 双管线架构**：在多模态模型识别之外，新增 Windows.Media.Ocr 引擎对未压缩原图进行文字识别，将 OCR 文本证据与压缩图像一并送入大模型
  - 解决了 800px JPEG 压缩后小字无法读取的问题（关键文字保真度从压缩图的 26.4% 提升至原图 OCR 的 90.8%）
  - OCR 读取原始未压缩截图，模型图像仍使用 800px 彩色 JPEG q45 压缩，兼顾识别精度与传输成本
- 新增 `WindowsOcrService`：通过 PowerShell 调用 Windows.Media.Ocr 引擎，批量识别图片文字，支持超时与错误兜底
- 新增 `BatchOcrEvidence`：将 OCR 结果按模型可见的连续帧顺序重映射，生成结构化 JSON 证据输入
- 新增 OCR 历史截图评估文档与评分脚本，量化不同预处理策略的文字保真度

### 改进

- `CaptureBatcher` 在批次 flush 时先对原始截图执行 Windows OCR，再将 OCR 结果随压缩图一并传入模型
- `ObserverExtractorWorker` 批次与单帧管线均在 prompt 中注入 `framesOcrJson` 证据，模型可同时参考视觉与文字
- OCR 不可用时自动降级为纯视觉管线，不影响主流程稳定性
- 彩色 4:2:0 JPEG 压缩策略经实测验证优于灰度方案，保留终端状态色、选中态与页面层级信息

### 已知限制

- 本版本为 Beta，双管线架构仍在持续优化跨帧 OCR 去重与文字区域 block diff
- Windows OCR 仅支持 win32 平台，其他平台自动降级为纯视觉识别
- 跨帧重复 OCR 结果暂未复用，后续将基于文字区域像素签名进行 block 级别去重

### 验证

- TypeScript 主进程与渲染进程类型检查通过
- WindowsOcrService / BatchOcrEvidence / CaptureBatcher 单元测试通过
- 本地构建与 NSIS 安装包打包通过
