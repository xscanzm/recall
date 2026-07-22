// Test-only OpenAI-compatible transport. It deliberately returns real Response
// objects so fixtures exercise ModelGateway's HTTP, JSON, Zod, metrics, and
// persistence paths instead of reimplementing those paths in the test helper.

export interface FixtureScenario {
  rawResponse: unknown;
  httpStatus?: number;
  headers?: Record<string, string>;
  delayMs?: number;
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    cachedPromptTokens?: number;
  };
  shouldTruncate?: boolean;
  shouldCorruptJson?: boolean;
}

export class OfflineFixtureTransport {
  private readonly scenarios = new Map<string, FixtureScenario[]>();
  readonly requests: Array<{ configId: string; url: string; body: unknown }> = [];

  registerScenario(configId: string, scenarioList: FixtureScenario[]): void {
    this.scenarios.set(configId, [...scenarioList]);
  }

  forConfig(configId: string): typeof fetch {
    return async (input, init) => {
      const list = this.scenarios.get(configId);
      if (!list || list.length === 0) {
        throw new Error(`No offline fixture registered for configId ${configId}`);
      }
      const scenario = list.shift()!;
      if (scenario.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
      }

      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      this.requests.push({ configId, url, body });

      const status = scenario.httpStatus ?? 200;
      if (status < 200 || status >= 300) {
        return Response.json(
          { error: { message: `Offline fixture HTTP ${status}` } },
          { status, headers: scenario.headers }
        );
      }

      let content = typeof scenario.rawResponse === "string"
        ? scenario.rawResponse
        : JSON.stringify(scenario.rawResponse);
      if (scenario.shouldCorruptJson) content = content.slice(0, Math.max(1, Math.floor(content.length / 2)));
      const finishReason = scenario.shouldTruncate ? "length" : (scenario.finishReason ?? "stop");
      return Response.json({
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: scenario.usage ? {
          prompt_tokens: scenario.usage.promptTokens,
          completion_tokens: scenario.usage.completionTokens,
          prompt_tokens_details: { cached_tokens: scenario.usage.cachedPromptTokens },
        } : undefined,
      }, { headers: scenario.headers });
    };
  }
}
