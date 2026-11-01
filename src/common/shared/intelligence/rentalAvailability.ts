import { z } from 'zod';

export const RENTAL_MODES = ['bicycle', 'ebike', 'scooter'] as const;

export type RentalMode = (typeof RENTAL_MODES)[number];

/** Inclusion means a route candidate exists, never that a vehicle is reserved or guaranteed. */
export const rentalAvailabilityEntrySchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('included'),
      reason: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal('excluded'),
      reason: z.enum(['walking-only', 'disabled', 'bicycle-not-ready']),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: z.enum([
        'unconfigured-feed',
        'unconfigured-router',
        'unconfigured-rental-policy',
        'provider-failure',
        'supply-unavailable',
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal('not-found'),
      reason: z.enum(['no-route', 'search-limited', 'license-unconfirmed', 'no-legal-return']),
    })
    .strict(),
]);

export const rentalAvailabilitySchema = z
  .object({
    bicycle: rentalAvailabilityEntrySchema,
    /** Optional so a response from a backend older than the e-bike tab still validates. */
    ebike: rentalAvailabilityEntrySchema.optional(),
    scooter: rentalAvailabilityEntrySchema,
  })
  .strict();

export type RentalAvailabilityEntry = z.infer<typeof rentalAvailabilityEntrySchema>;

export type RentalAvailability = z.infer<typeof rentalAvailabilitySchema>;

const RENTAL_NAMES: Record<RentalMode, string> = {
  bicycle: '따릉이',
  ebike: '전기자전거',
  scooter: '킥보드',
};

/** Plain user-facing explanations share the same meaning on web, native and API clients. */
export function rentalAvailabilityText(
  mode: RentalMode,
  entry: RentalAvailabilityEntry,
): string | null {
  const name = RENTAL_NAMES[mode];

  switch (entry.reason) {
    case null:
      return null;
    case 'walking-only':
      return '걷기만 비교 설정';
    case 'disabled':
      return '이용 설정에서 제외';
    case 'bicycle-not-ready':
      return '따릉이 이용 준비 확인 필요';
    case 'unconfigured-feed':
      return `${name} 위치·재고 연동 준비 중`;
    case 'unconfigured-router':
      return mode === 'bicycle'
        ? '따릉이 전용 경로 연동 준비 중'
        : `${name} 경로·대여/반납 연동 준비 중`;
    case 'unconfigured-rental-policy':
      return `${name} 대여·반납 연동 준비 중`;
    case 'provider-failure':
      return `${name} 경로 공급원 조회 실패`;
    case 'supply-unavailable':
      return `${name} 대여 가능 위치·재고 미확인`;
    case 'search-limited':
      return `${name} 조합 탐색 일부 미완료`;
    case 'no-route':
      return `이번 조회에서 이용 가능한 ${name} 조합 없음`;
    case 'license-unconfirmed':
      return `${name} 면허 확인 필요`;
    case 'no-legal-return':
      return `도착지 근처 ${name} 반납 가능 구역 없음`;
  }
}
