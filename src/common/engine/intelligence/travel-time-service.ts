import { z } from 'zod';
import {
  travelTimeRequestSchema,
  travelTimeResponseSchema,
  timeEstimatesSchema,
  travelTimeScenarios,
  TIME_MODES,
  type TravelTimeRequest,
  type TravelTimeResponse,
} from '../../shared/intelligence/travelTime.js';

const TTL = 300_000;
const outputSchema = z.object({ estimates: timeEstimatesSchema }).strict();
type FallbackReason = NonNullable<TravelTimeResponse['fallbackReason']>;
type CacheEntry = { expiresAt: number; response: Promise<TravelTimeResponse> };

/** GPT computes six hypothetical mode durations from numeric inputs only. */
export class TravelTimeService {
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();
  private inFlight = 0;
  private budget = { until: 0, used: 0 };
  constructor(
    private readonly options: {
      apiKey?: string;
      model?: string;
      now?: () => number;
      fetcher?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
  }
  get configured() {
    return !!this.options.apiKey?.trim();
  }
  status() {
    return {
      configured: this.configured,
      model: this.options.model?.trim() || 'gpt-5.4-mini',
      role: 'travel-time-estimation',
      liveVerified: false,
    };
  }
  estimate(body: TravelTimeRequest): Promise<TravelTimeResponse> {
    const input = travelTimeRequestSchema.parse(body),
      now = this.now();
    for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
    const key = JSON.stringify([input, Math.floor(now / TTL)]);
    const cached = this.cache.get(key);
    if (cached) return cached.response;
    while (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    const entry = { expiresAt: now + TTL, response: this.generate(input, now) };
    this.cache.set(key, entry);
    void entry.response.then((result) => {
      if (result.source !== 'gpt' && this.cache.get(key) === entry)
        entry.expiresAt = Math.min(entry.expiresAt, this.now() + 10_000);
    });
    return entry.response;
  }
  private async generate(
    input: TravelTimeRequest,
    generatedAt: number,
  ): Promise<TravelTimeResponse> {
    const scenarios = travelTimeScenarios(input);
    const base = {
      generatedAt,
      expiresAt: generatedAt + TTL,
      distanceMeters: input.distanceMeters,
      preparationSeconds: input.preparationSeconds,
    };
    const fallback = (reason: FallbackReason): TravelTimeResponse => ({
      ...base,
      source: 'distance-rule',
      fallbackReason: reason,
      estimates: scenarios.map((s) => ({
        mode: s.mode,
        seconds: s.baselineSeconds,
        minSeconds: Math.max(1, Math.floor(s.baselineSeconds * 0.75)),
        maxSeconds: Math.ceil(s.baselineSeconds * 1.5),
      })),
      notice:
        reason === 'not-configured'
          ? 'GPT 키가 없어 거리와 기본 속도로 계산했어요.'
          : 'AI 시간 계산을 완료하지 못해 거리와 기본 속도로 계산했어요. 잠시 후 다시 계산할 수 있어요.',
    });
    if (!this.configured) return fallback('not-configured');
    if (this.budget.until <= this.now()) this.budget = { until: this.now() + 60_000, used: 0 };
    if (this.inFlight >= 2 || this.budget.used >= 10) return fallback('busy');
    this.inFlight++;
    this.budget.used++;
    try {
      const model = this.status().model;
      const local = new Date(generatedAt + 9 * 3600_000);
      const response = await this.fetcher('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey!.trim()}`,
        },
        body: JSON.stringify({
          model,
          store: false,
          max_output_tokens: 1600,
          ...(model.startsWith('gpt-5.4') ? { reasoning: { effort: 'none' } } : {}),
          instructions:
            '주어진 거리와 가정으로 걷기·달리기·자전거·버스·지하철·택시 소요시간을 초 단위 정수로 계산하세요. 여섯 mode를 각각 한 번 반환하세요. 실제 경로·운행·재고·날씨·교통량 자료는 없습니다. assumedDistanceMeters / 1000 / assumedSpeedKmh * 3600 + assumedAccessWaitSeconds로 초를 계산하고 도시 보행 신호와 시간대에 따른 불확실성을 반영하세요. baselineSeconds의 0.5~2배 안에서 대표 seconds를 계산하고 minSeconds < maxSeconds, minSeconds <= seconds <= maxSeconds로 넓은 추정 범위를 제시하세요. 걷기/달리기/자전거 속도를 혼동하지 마세요. 준비 시간은 서버에서 별도 표시하므로 더하지 마세요. 시간 숫자만 출력하고 노선·설명·경로·도착 확률은 만들지 마세요.',
          input: JSON.stringify({
            distanceBasis: 'straight-line-with-assumed-detours',
            koreanHour: local.getUTCHours(),
            koreanWeekday: local.getUTCDay(),
            scenarios,
          }),
          text: {
            format: {
              type: 'json_schema',
              name: 'travel_time_estimates',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['estimates'],
                properties: {
                  estimates: {
                    type: 'array',
                    minItems: 6,
                    maxItems: 6,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['mode', 'seconds', 'minSeconds', 'maxSeconds'],
                      properties: {
                        mode: { type: 'string', enum: [...TIME_MODES] },
                        seconds: { type: 'integer', minimum: 1, maximum: 172800 },
                        minSeconds: { type: 'integer', minimum: 1, maximum: 172800 },
                        maxSeconds: { type: 'integer', minimum: 1, maximum: 172800 },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return fallback('provider-error');
      }
      const body = (await response.json()) as {
        status?: string;
        output?: { type?: string; content?: { type?: string; text?: string }[] }[];
      };
      if (body.status !== 'completed' || !Array.isArray(body.output))
        return fallback('invalid-response');
      const text = body.output
        .filter((o) => o.type === 'message')
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text ?? '')
        .join('');
      if (text.length > 8000) return fallback('invalid-response');
      const parsed = outputSchema.safeParse(JSON.parse(text));
      if (
        !parsed.success ||
        parsed.data.estimates.some((e) => {
          const baseline = scenarios.find((s) => s.mode === e.mode)!.baselineSeconds;
          return (
            e.seconds < baseline * 0.5 ||
            e.seconds > baseline * 2 ||
            e.minSeconds < baseline * 0.25 ||
            e.maxSeconds > baseline * 4
          );
        })
      )
        return fallback('invalid-response');
      return travelTimeResponseSchema.parse({
        ...base,
        source: 'gpt',
        fallbackReason: null,
        estimates: parsed.data.estimates,
        notice:
          'GPT가 거리와 이동수단별 가정으로 계산한 예상 시간이에요. 실제 경로·운행·교통량·자전거 재고는 확인되지 않았어요.',
      });
    } catch (error) {
      return fallback(
        error instanceof Error && /Timeout|Abort/.test(error.name)
          ? 'timeout'
          : error instanceof SyntaxError || error instanceof z.ZodError
            ? 'invalid-response'
            : 'provider-error',
      );
    } finally {
      this.inFlight--;
    }
  }
}
