import type { Place } from '../../../common/shared/domain/types.js';

export function placeSearchResult(places: Place[], hasCenter: boolean, now: number) {
  return {
    places,
    generatedAt: now,
    provenance: {
      mode: 'live',
      provider: 'kakao',
      label: '카카오 장소 검색',
      sourceTimestamp: null,
      receivedAt: now,
      isRealtime: false,
    },
    scope: hasCenter ? '검색 중심 20km 범위' : '서울 실증 범위',
  };
}
