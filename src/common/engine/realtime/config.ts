/** One server-only portal credential; each upstream service still requires approval. */
export function publicDataConfigFromEnvironment(environment: Record<string, string | undefined>) {
  return {
    dataGoKrServiceKey: environment.DATA_GO_KR_SERVICE_KEY?.trim() || undefined,
  };
}
