import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_TOKENS,
  makeHttpLlmClient,
  type HttpLlmClientSpec,
} from "./http-client.js";

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => "",
  } as unknown as Response;
}

/** A stand-in provider so the shared scaffolding is tested independently of any real backend. */
const spec: HttpLlmClientSpec = {
  provider: "fake",
  label: "Fake",
  defaultModel: "m-default",
  defaultBaseUrl: "https://base.test",
  resolveApiKey: (explicit) => {
    const key = explicit ?? process.env.FAKE_KEY;
    if (!key) throw new Error("fake requires FAKE_KEY");
    return key;
  },
  buildRequest: ({ prompt, options, model, baseUrl, apiKey }) => ({
    url: `${baseUrl}/gen/${model}`,
    headers: { authorization: apiKey },
    body: { prompt, system: options.system, max: options.maxTokens ?? DEFAULT_MAX_TOKENS },
  }),
  parseResponse: (json) => (json as { text?: string }).text ?? "",
};

describe("makeHttpLlmClient", () => {
  beforeEach(() => delete process.env.FAKE_KEY);
  afterEach(() => vi.unstubAllGlobals());

  it("derives the id from the provider and the resolved model", () => {
    expect(makeHttpLlmClient(spec, { apiKey: "k" }).id).toBe("fake:m-default");
    expect(makeHttpLlmClient(spec, { apiKey: "k", model: "x" }).id).toBe("fake:x");
  });

  it("resolves the key eagerly, throwing at construction when it is missing", () => {
    expect(() => makeHttpLlmClient(spec)).toThrow(/FAKE_KEY/);
  });

  it("posts the spec's request and returns the trimmed parsed text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ text: "  hi  " }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await makeHttpLlmClient(spec, { apiKey: "sekret", model: "m1" }).complete(
      "do it",
      { system: "sys", maxTokens: 7 },
    );

    expect(out).toBe("hi"); // helper owns the trailing trim
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://base.test/gen/m1");
    expect(init.headers).toEqual({ authorization: "sekret" });
    expect(JSON.parse(init.body)).toEqual({ prompt: "do it", system: "sys", max: 7 });
  });

  it("defaults maxTokens via DEFAULT_MAX_TOKENS when the caller omits it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ text: "x" }));
    vi.stubGlobal("fetch", fetchMock);

    await makeHttpLlmClient(spec, { apiKey: "k" }).complete("q");

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).max).toBe(DEFAULT_MAX_TOKENS);
  });
});
