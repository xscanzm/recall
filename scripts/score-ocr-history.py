import json
import os
import sys


DEFAULT_RESULTS = os.path.join(
    os.environ.get("TEMP", r"C:\Windows\Temp"),
    "recall-ocr-eval-20260716",
    "results.json",
)


GROUND_TRUTH = {
    "chrome_toknex": [
        "一个 Key，按 Token 用量调用主流大模型",
        "Toknex 是面向开发者和团队的 AI API 网关。用一套 OpenAI-compatible 接口整合 Claude、GPT、Gemini、DeepSeek、GLM 等模型，统一鉴权、统一计量、统一账单。",
        "gateway.toknex.ai / live routing",
        "POST /v1/chat/completions",
        "claude-sonnet-4.5",
    ],
    "codex_dense": [
        "VLM 同时看到彩色压缩截图，因此仍然能理解布局、状态和用户意图，但不必反复读取六份完全相同的 OCR 原文。",
        "先不换 OCR 引擎，也不急着引进完整 Accessibility Tree。优先做：",
        "从 Windows OCR 提取逐词或逐行 bounding box。",
        "给每个文字区域生成像素签名。",
        "按活动窗口维护上一份已成功入库的 OCR 结果。",
        "相同文字区域直接复用。",
        "对新增、变化和消失的文字块做帧间 diff。",
        "L0 保存完整 blocks，VLM 只接收稳定上下文一次和逐帧变化。",
        "建立真实截图测试集，再决定是否加入灰度、放大、反转和锐化。",
    ],
    "weixin_chat": [
        "Model: deepseek-v4-flash Provider: custom: 皮皮ai Context: 1.0M tokens (config)",
        "哎哟，第一笔回款到账了！",
        "2.5万，耀石锂电首月咨询费，齐活。6个月合同开了个好头，接下来剩下5个月按节奏走就行。",
        "对了，按之前说的，这个月的对账提醒我帮你停了——收钱到位，不用追。",
    ],
    "trae_dense": [
        "L-1 Capture Ledger 采集账本（不进 UI）",
        "L0 Moment 瞬间观察（弱语义、强证据）",
        "L1 Episode 活动片段（前台时间线主体）",
        "L2 Memory Atom 可沉淀主张",
        "L3 Memory Object 项目/任务/人物/决策",
        "Edges 关系层",
        "不把截图 OCR 全文直接塞进长期记忆",
        "不让视觉模型直接生成日报",
        "模型输出 schema 必须 zod preprocess 兜底",
        "所有时间字段 UTC ISO 8601 with Z",
        "只活动窗口（不采全屏）",
        "stable 30s / content 60s / long session 2-5min / idle 120s",
        "1-6 帧 + 可选 stitched image（3-6 帧拼图）",
    ],
    "zcode_document": [
        "管理照片、视频、消息、位置、联系人和健康数据",
        "建立统一人生时间线",
        "图库、地图、对话和仪表盘",
        "人物、组织、地点和活动关系",
        "SQLite 本地索引",
        "使用开放目录保存原始数据",
        "Timelinize 关注长期“数字人生档案”，Recall 当前聚焦知识工作上下文。",
        "跨数据源记忆",
        "人物与实体合并",
        "长期开放数据格式",
        "可重建索引",
        "跨设备人生时间线",
    ],
    "terminal_dark": [
        "Local: http://localhost:5173/",
        "Network: use --host to expose",
        "PS D:\\回声Recall> npm run devprocesses..",
        "npm run dev:main exited with code 1",
        "recall@0.2.1 dev",
        "recall@0.2.1 dev:main",
        "tsc -p tsconfig.node.json && wait-on tcp:5173 && cross-env NODE_ENV=development VITE_DEV_SERVER_URL=http://localhost:5173 electron .",
        "recall@0.2.1 dev:renderer",
        "The CJS build of Vite's Node API is deprecated.",
        "VITE v5.4.21 ready in 670 ms",
    ],
    "tabbit_github": [
        "https://github.com/ayushh0110/ScreenMind",
        "ayushh0110 / ScreenMind",
        "AI-powered screen memory — captures, analyzes, and lets you search/chat your screen history. Powered by Gemma 4. 100% local, 100% private.",
        "79 Commits",
        "188 stars",
        "12 forks",
        "ScreenMind v0.1.2",
    ],
    "hubstudio_modal": [
        "领取成功",
        "兑换码已复制到剪贴板。",
        "站点: Toknex",
        "兑换码额度(RMB): ¥15",
        "当前积分: 10积分",
        "a3cc424744ecc822d80c7a2a8b47d2b9",
    ],
}


def normalize(value):
    return "".join(character.lower() for character in value if character.isalnum())


def substring_edit_distance(pattern, text):
    if not pattern:
        return 0
    if not text:
        return len(pattern)
    previous = [0] * (len(text) + 1)
    for pattern_index, pattern_character in enumerate(pattern, start=1):
        current = [pattern_index] + [0] * len(text)
        for text_index, text_character in enumerate(text, start=1):
            substitution_cost = 0 if pattern_character == text_character else 1
            current[text_index] = min(
                previous[text_index] + 1,
                current[text_index - 1] + 1,
                previous[text_index - 1] + substitution_cost,
            )
        previous = current
    return min(previous)


def main():
    results_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_RESULTS
    with open(results_path, encoding="utf-8") as file:
        results = json.load(file)

    scores = {}
    for variant_id, output in results["ocrByVariant"].items():
        variant = {"samples": {}}
        total_characters = 0
        total_errors = 0
        for frame in output["frames"]:
            sample_id = frame["sampleId"]
            normalized_ocr = normalize(frame["text"])
            snippet_scores = []
            sample_characters = 0
            sample_errors = 0
            for source_text in GROUND_TRUTH[sample_id]:
                normalized_source = normalize(source_text)
                distance = substring_edit_distance(normalized_source, normalized_ocr)
                accuracy = max(0.0, 1.0 - distance / len(normalized_source))
                snippet_scores.append({
                    "sourceText": source_text,
                    "normalizedLength": len(normalized_source),
                    "editDistance": distance,
                    "accuracy": round(accuracy, 4),
                })
                sample_characters += len(normalized_source)
                sample_errors += distance
            sample_accuracy = max(0.0, 1.0 - sample_errors / sample_characters)
            variant["samples"][sample_id] = {
                "characters": sample_characters,
                "errors": sample_errors,
                "accuracy": round(sample_accuracy, 4),
                "snippets": snippet_scores,
            }
            total_characters += sample_characters
            total_errors += sample_errors
        variant["characters"] = total_characters
        variant["errors"] = total_errors
        variant["accuracy"] = round(max(0.0, 1.0 - total_errors / total_characters), 4)
        scores[variant_id] = variant

    output_path = os.path.join(os.path.dirname(results_path), "manual-ground-truth-scores.json")
    with open(output_path, "w", encoding="utf-8") as file:
        json.dump(scores, file, ensure_ascii=False, indent=2)

    print("variant\toverall\tchrome\tcodex\tweixin\ttrae\tzcode\tterminal\ttabbit\thubstudio")
    sample_order = [
        "chrome_toknex",
        "codex_dense",
        "weixin_chat",
        "trae_dense",
        "zcode_document",
        "terminal_dark",
        "tabbit_github",
        "hubstudio_modal",
    ]
    for variant_id, variant in scores.items():
        values = [variant_id, f"{variant['accuracy']:.1%}"]
        values.extend(f"{variant['samples'][sample_id]['accuracy']:.1%}" for sample_id in sample_order)
        print("\t".join(values))
    print(output_path)


if __name__ == "__main__":
    main()
