/** One server-only portal credential; each upstream service still requires approval. */
export function publicDataConfigFromEnvironment(environment: Record<string, string | undefined>) {
  return {
    dataGoKrServiceKey: environment.DATA_GO_KR_SERVICE_KEY?.trim() || undefined,
  };
}

/** The bus feeds' optional spare: a key of another data.go.kr account, used per operation once the first key's daily
 * quota is spent, and the daily calls per bus operation and key (blank = 1,000, the development-account limit; 0 =
 * unguarded). */
export function busQuotaConfigFromEnvironment(environment: Record<string, string | undefined>) {
  const limit = environment.DATA_GO_KR_DAILY_LIMIT?.trim(),
    parsed = Number(limit);
  return {
    dataGoKrServiceKeyFallback: environment.DATA_GO_KR_SERVICE_KEY_FALLBACK?.trim() || undefined,
    dataGoKrDailyLimit: limit && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined,
  };
}
