export type ApiErrorCode =
  | 'INVALID_INPUT'
  | 'LIVE_NOT_CONFIGURED'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_FORBIDDEN'
  | 'PROVIDER_LIMIT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RESPONSE'
  | 'NO_ROUTES'
  | 'TOO_MANY_REQUESTS'
  | 'CALL_BUDGET_EXCEEDED'
  | 'AUTH_REQUIRED'
  | 'AUTH_CSRF'
  | 'AUTH_FLOW_EXPIRED'
  | 'AUTH_REAUTH_REQUIRED'
  | 'CONSENT_REQUIRED'
  | 'SOCIAL_NOT_CONFIGURED'
  | 'SOCIAL_AUTH_FAILED'
  | 'SOCIAL_UNAVAILABLE'
  | 'SOCIAL_CANCELLED'
  | 'INTERNAL_ERROR';

/** Only these deliberately written messages cross the API boundary. */
export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status = 502,
  ) {
    super(message);

    this.name = 'ApiError';
  }
}

export function safeApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(
        'INTERNAL_ERROR',
        '경로 서버에서 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
        500,
      );
}
