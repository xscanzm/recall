import { describe, expect, it } from "vitest";
import {
  BATCH_OBSERVER_EXTRACTOR_PROMPT_TEMPLATE,
  BATCH_OBSERVER_PROMPT_TEMPLATE,
  EPISODE_FACT_EXTRACTOR_PROMPT_TEMPLATE,
  LINKER_SCENE_JUDGE_PROMPT_TEMPLATE,
} from "./prompts";

interface PromptCase {
  name: string;
  template: string;
  dynamicTokens: string[];
  stableSchemaMarker: string;
}

const promptCases: PromptCase[] = [
  {
    name: "observer batch",
    template: BATCH_OBSERVER_PROMPT_TEMPLATE,
    dynamicTokens: [
      "{{frames_count}}",
      "{{batch_start_at}}",
      "{{batch_end_at}}",
      "{{batch_timezone}}",
      "{{frames_metadata_array}}",
      "{{frames_ocr_json}}",
      "{{recent_observations_json}}",
    ],
    stableSchemaMarker: "【输出 schema】",
  },
  {
    name: "observer extractor batch",
    template: BATCH_OBSERVER_EXTRACTOR_PROMPT_TEMPLATE,
    dynamicTokens: [
      "{{frames_count}}",
      "{{batch_start_at}}",
      "{{batch_end_at}}",
      "{{batch_timezone}}",
      "{{frames_metadata_array}}",
      "{{frames_ocr_json}}",
      "{{extractor_input_json}}",
      "{{known_aliases_block}}",
    ],
    stableSchemaMarker: "【输出 schema】",
  },
  {
    name: "episode fact extractor",
    template: EPISODE_FACT_EXTRACTOR_PROMPT_TEMPLATE,
    dynamicTokens: [
      "{{episode_extractor_input_json}}",
      "{{known_aliases_block}}",
    ],
    stableSchemaMarker: "【facts 输出 schema】",
  },
  {
    name: "linker scene judge",
    template: LINKER_SCENE_JUDGE_PROMPT_TEMPLATE,
    dynamicTokens: [
      "{{should_trigger_scene_builder}}",
      "{{known_aliases_block}}",
      "{{linker_input_json}}",
    ],
    stableSchemaMarker: "【合并输出要求】",
  },
];

describe("prompt cache prefix layout", () => {
  it.each(promptCases)("keeps $name rules and schema before dynamic data", ({
    template,
    dynamicTokens,
    stableSchemaMarker,
  }) => {
    const dynamicBoundary = template.indexOf("【本次动态输入】");
    expect(dynamicBoundary).toBeGreaterThan(0);
    expect(template.indexOf(stableSchemaMarker)).toBeGreaterThan(0);
    expect(template.indexOf(stableSchemaMarker)).toBeLessThan(dynamicBoundary);
    for (const token of dynamicTokens) {
      expect(template.indexOf(token)).toBeGreaterThan(dynamicBoundary);
      expect(template.indexOf(token)).toBe(template.lastIndexOf(token));
    }

    const first = render(template, dynamicTokens, "FIRST_DYNAMIC_VALUE");
    const second = render(template, dynamicTokens, "SECOND_DYNAMIC_VALUE");
    expect(first).not.toContain("{{");
    expect(second).not.toContain("{{");
    expect(commonPrefixLength(first, second)).toBeGreaterThan(dynamicBoundary);
  });
});

function render(template: string, tokens: string[], suffix: string): string {
  return tokens.reduce(
    (prompt, token, index) => prompt.replace(token, `${suffix}_${index}`),
    template
  );
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}
