import { ApiError } from './errors.js';

export const MAX_ROUTE_CALLS = 10;
export const MAX_COMPOSITE_ROUTE_CALLS = 20;

/** Expanded searches also discover and route verified intermediate transit hubs. */
export const MAX_EXPANDED_ROUTE_CALLS = 32;

/** One instance belongs to one user search; every provider attempt and retry shares it. */
export class CallBudget {
  private calls = 0;
  private reservedCalls = 0;
  readonly limit: number;

  constructor(limit = MAX_ROUTE_CALLS) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPANDED_ROUTE_CALLS) {
      throw new Error(`경로 호출 예산은 1~${MAX_EXPANDED_ROUTE_CALLS}건이어야 합니다.`);
    }

    this.limit = limit;
  }

  get used(): number {
    return this.calls;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.calls - this.reservedCalls);
  }

  /** Protect a later candidate while a speculative branch uses this same search/cache identity. */
  async withReservedCalls<T>(count: number, operation: () => Promise<T> | T): Promise<T> {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('예약 호출 수는 0 이상의 안전한 정수여야 합니다.');
    }

    const held = Math.min(count, this.remaining);

    this.reservedCalls += held;

    try {
      return await operation();
    } finally {
      this.reservedCalls -= held;
    }
  }

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    // Reserve before awaiting: concurrent candidates cannot spend the same slot.
    if (this.remaining <= 0) {
      throw new ApiError(
        'CALL_BUDGET_EXCEEDED',
        '이번 검색의 경로 호출 예산을 모두 사용했어요. 확인된 경로만 표시해요.',
        429,
      );
    }

    this.calls += 1;

    // A failed HTTP attempt still spends the slot. Retrying must call run again.
    return operation();
  }
}
