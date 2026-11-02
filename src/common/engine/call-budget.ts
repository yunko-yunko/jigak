import { ApiError } from './errors.js';

export const MAX_ROUTE_CALLS = 10;
export const MAX_COMPOSITE_ROUTE_CALLS = 20;
/** Full searches route every transit candidate's first and last walk (one fast Kakao call
 * each, plus an OpenStreetMap check when Kakao detours) before rental and taxi combinations. */
export const FULL_ROUTE_CALLS = 72;
/** Expanded searches also discover and route verified intermediate transit hubs. */
export const MAX_EXPANDED_ROUTE_CALLS = 96;

/** One instance belongs to one user search; every provider attempt and retry shares it. */
export class CallBudget {
  private calls = 0;
  private reservedCalls = 0;
  private closesAt = Infinity;
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
    return Date.now() >= this.closesAt
      ? 0
      : Math.max(0, this.limit - this.calls - this.reservedCalls);
  }
  /** The optional-stage window has closed: no new supplier call may start until a stage extends it. */
  get closed(): boolean {
    return Date.now() >= this.closesAt;
  }

  /** Optional stages stop starting supplier calls after this many milliseconds; a late rider needs an answer. */
  closeAfter(milliseconds: number): void {
    this.closesAt = Math.min(this.closesAt, Date.now() + milliseconds);
  }

  /** A measured saving buys one more short window for the calls that realise it; an open budget stays open.
   * The returned function puts the previous deadline back when the extra time turned out to be unneeded. */
  extendWindow(milliseconds: number): () => void {
    const previous = this.closesAt;
    if (Number.isFinite(previous)) this.closesAt = Math.max(previous, Date.now() + milliseconds);
    return () => {
      this.closesAt = Math.min(this.closesAt, previous);
    };
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
