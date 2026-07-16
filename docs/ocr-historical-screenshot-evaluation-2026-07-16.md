# OCR 历史截图实测（2026-07-16）

## 结论

当前的“未压缩原图 Windows OCR + 800px 彩色 JPEG 给 VLM”方向确实解决了小字在压缩后无法读取的大部分问题，但没有解决跨帧重复和整窗 OCR 冗余。

- 保留：先识别未压缩原图，再压缩模型图片。
- 保留：彩色 JPEG、quality 45、4:2:0、MozJPEG。
- 不采用：全局灰度、锐化、反色、统一对比度增强。
- 不采用：仅凭整图 pHash/SSIM 相似度跳过近似帧。
- 下一步应验证：Windows OCR bounding box + 文字区域像素签名 + 跨帧 block diff/reuse。

## 方法

从 `recall.db` 的 `observations.screenshot_paths_json` 中找到 300 张仍存在的历史截图，没有使用合成图片。

人工查看并选择 8 个独立场景：Chrome、Codex、微信、TRAE、ZCode、Windows Terminal、Tabbit/GitHub、Hubstudio 弹窗；另选择 4 组连续帧。

对同一批原图运行 Windows OCR：

1. 原图。
2. 最小宽度放大到 1920px。
3. 灰度 + 放大。
4. 灰度 + 放大 + 锐化 + 1.25 对比度。
5. 暗图反色 + 锐化 + 1.5 对比度。
6. 800px 彩色 JPEG q45、4:2:0。
7. 800px 灰度 JPEG q45。

从原图人工转写 1,513 个关键可见字符，忽略空格和标点后，使用最小字符编辑距离评分。该分数衡量选定关键文字的识别保真度，不代表整屏所有文字的绝对准确率。

## OCR 结果

| 输入 | 关键文字保真度 | 相比原图 |
| --- | ---: | ---: |
| 未压缩原图 | 90.8% | 基准 |
| 放大到 1920px | 90.8% | 0.0pp |
| 灰度 + 放大 | 90.8% | 0.0pp |
| 灰度 + 锐化 + 1.25 对比度 | 89.3% | -1.5pp |
| 暗图反色 + 锐化 + 1.5 对比度 | 89.0% | -1.8pp |
| 800px 彩色 JPEG q45 | 26.4% | -64.4pp |
| 800px 灰度 JPEG q45 | 26.5% | -64.3pp |

分场景结果不是一致提升：

- 放大让 Chrome 从 92.9% 到 95.2%，但 Hubstudio 从 95.8% 降到 93.1%。
- 轻度增强让 ZCode 从 80.1% 到 83.0%，但 Codex 从 90.9% 降到 83.5%。
- 暗图反色没有改善 Terminal，反而从 95.1% 降到 92.8%。
- 800px 压缩后，Codex、TRAE、ZCode 的选定小字正文几乎无法被 Windows OCR 读出；微信大字号聊天仍有 89.6%。

因此，OCR 必须继续读取原图；预处理不能作为全局固定策略。

## 彩色与灰度

同样使用 800px、q45、4:2:0、MozJPEG，8 张样本总大小：

- 彩色：127,255 bytes。
- 灰度：119,876 bytes。
- 灰度仅减少 5.8%。

人工查看压缩图后，小字可读性没有明显改善，但灰度丢失了终端状态色、选中态、页面层级和状态提示。对多数按尺寸/瓦片计费的视觉模型，灰度也不会减少图片 token，只减少少量传输字节。

结论：不值得全局改成灰度。彩色 4:2:0 已经是更合理的折中。

## 连续帧与去重

数据库现存 300 张图片中，有 7 组、14 个图片引用是字节级完全重复，占 4.7%。这些重复可以安全地在 OCR 和模型调用之前复用已完成结果。

近似帧不能只看整图相似度：

| 序列 | 低分辨率相似度 | dHash 距离 | 人工查看 |
| --- | ---: | ---: | --- |
| Codex | 99.808% | 3 | 底部输入框新增输入文字和输入法候选，属于真实变化 |
| 微信 | 99.472% | 4 | 肉眼内容相同，只有全图轻微颜色漂移 |
| TRAE | 99.971% | 0 | 正文相同，变化集中在底部输入区/控件状态 |
| Terminal | 99.998% | 0 | 只有 2x32px 光标变化，正文完全相同 |

Codex 是明确反例：如果设置“相似度大于 99% 就跳过”，会漏掉用户正在输入的内容。微信则是相反情况：内容相同，但文件 hash 和整图像素都不同。

因此整图相似度只能作为候选门控，最终应判断变化发生在哪个文字区域，以及该区域的 OCR block 是否改变。

## 冗余问题

当前 Windows OCR 返回整窗扁平文本，没有 bounding box 和置信度；模型每帧都会收到完整 OCR。人工查看输出发现：

- Codex 同时包含正文、左侧项目列表、输入法候选和全局导航。
- 微信同时包含当前聊天、联系人列表、未读数字和历史摘要。
- Chrome 同时包含页面正文、标签页、书签栏、地址栏和自动化提示。
- ZCode/TRAE 同时包含主文档、侧栏任务列表、工具栏和输入区。

这能补足小字，但不能减少冗余。现有 prompt 又要求每帧完整输出 `fullText`，所以相同正文会在 OCR 输入和模型输出两侧重复。

## 下一步验证边界

建议只进入下一层实验，不直接大改模型协议：

1. 从 Windows OCR 返回 word/line bounding box 和置信度。
2. 对每个文字区域保存归一化文本和区域像素签名。
3. 同一活动窗口内区分 unchanged / changed / added / removed blocks。
4. L0 本地仍保存可重建的完整观察文本；模型只减少重复输入，不牺牲完整事实。
5. 对 exact duplicate 直接复用；对 near duplicate 必须检查文字区域变化，不能只看整图阈值。
6. 用本次历史样本继续比较 Windows OCR 与候选引擎，达到明确实测收益后再考虑换引擎。

## 复现

- `node scripts/evaluate-ocr-history.js`
- `python scripts/score-ocr-history.py`

详细 OCR 文本、变体图片和连续帧指标生成在：

`%TEMP%\recall-ocr-eval-20260716`

## 2026-07-16 实施结果

上述下一层已经落地：

- Windows OCR 返回 line/word bounding boxes；Windows API 不提供 confidence，因此没有伪造。
- 坐标只用于本地 block 匹配、区域签名和完整 L0 证据，不提交给模型、不面向用户展示。
- 解码像素完全一致时复用 OCR；同批次精确重复图片不再提交给 VLM，模型返回后克隆源 observation 并恢复每帧对齐。
- 近似帧仍然完整 OCR 和提交图片，只对 OCR 文字做 conservative block diff。
- OCR cache 只有在 `capture_batches.bundle_json` 成功写入 SQLite 后才 commit。
- L0 同时保存模型 `fullText` 和完整本地 `ocrEvidence`，两者互不覆盖。
- 模型 OCR 证据使用 compact `block id + text`；只有后续 delta 真正引用时才保留结构化 baseline，否则使用更小的 full text。delta/full 的选择按实际 UTF-8 序列化字节决定，不使用人为数量阈值。

最终回归运行时，数据库中的历史截图已被生命周期清理为 0 张可访问原图。因此回归使用早先实验保留的历史截图无损/预处理派生 PNG，并额外在 Codex 历史图底部加入一个明确标注的受控小区域文字变化。受控变化不冒充原始历史记录。

| 指标 | 结果 |
| --- | ---: |
| 输入帧 | 9 |
| 实际 Windows OCR 帧 | 7（减少 22.22%） |
| 实际 VLM 图片帧 | 7（减少 22.22%） |
| 旧扁平 OCR evidence | 17,058 bytes |
| 新 evidence | 11,317 bytes（减少 33.66%） |
| 每帧本地完整 OCR text | 9/9 保留 |

Codex 序列结果：第一帧 66 blocks；第二帧精确复用；第三帧受控输入变化保留为 58 unchanged、1 added、8 removed，没有被整图相似度跳过。

验证结果：

- 聚焦 OCR/差分/批处理/Normalizer/Schema：34 tests passed。
- 全量 Vitest：26 files / 112 tests passed。
- main/renderer typecheck passed。
- main/renderer build passed。
- SQLite integration passed。
- memory smoke passed。
- renderer smoke passed；同时补齐了原 smoke mock 缺失的 update `onProgress/onStatusChanged` 测试桩。

新增回归命令：

`node scripts/evaluate-ocr-delta-history.js`
