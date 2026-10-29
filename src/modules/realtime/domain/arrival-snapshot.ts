export function arrivalSnapshot<T>(
  boardings: T[],
  configured: unknown,
  sources: unknown,
  now: number,
) {
  return {
    boardings,
    generatedAt: now,
    configured,
    sources,
  };
}
