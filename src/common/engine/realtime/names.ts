/** Name and line matching between Kakao route steps and public transit feeds. */

const SUBWAY_LINES: {
  id: string;
  name: string;
  aliases: string[];
}[] = [
  {
    id: '1001',
    name: '1호선',
    aliases: ['1호선', '수도권1호선', '경부선', '경인선', '경원선', '장항선'],
  },
  {
    id: '1002',
    name: '2호선',
    aliases: ['2호선'],
  },
  {
    id: '1003',
    name: '3호선',
    aliases: ['3호선'],
  },
  {
    id: '1004',
    name: '4호선',
    aliases: ['4호선', '진접선', '안산선', '과천선'],
  },
  {
    id: '1005',
    name: '5호선',
    aliases: ['5호선'],
  },
  {
    id: '1006',
    name: '6호선',
    aliases: ['6호선'],
  },
  {
    id: '1007',
    name: '7호선',
    aliases: ['7호선'],
  },
  {
    id: '1008',
    name: '8호선',
    aliases: ['8호선', '별내선'],
  },
  {
    id: '1009',
    name: '9호선',
    aliases: ['9호선'],
  },
  {
    id: '1061',
    name: '중앙선',
    aliases: ['중앙선'],
  },
  {
    id: '1063',
    name: '경의중앙선',
    aliases: ['경의중앙선', '경의선'],
  },
  {
    id: '1065',
    name: '공항철도',
    aliases: ['공항철도', '인천공항철도', 'arex'],
  },
  {
    id: '1067',
    name: '경춘선',
    aliases: ['경춘선'],
  },
  {
    id: '1075',
    name: '수인분당선',
    aliases: ['수인분당선', '분당선', '수인선'],
  },
  {
    id: '1077',
    name: '신분당선',
    aliases: ['신분당선'],
  },
  {
    id: '1081',
    name: '경강선',
    aliases: ['경강선'],
  },
  {
    id: '1092',
    name: '우이신설선',
    aliases: ['우이신설선', '우이신설경전철'],
  },
  {
    id: '1093',
    name: '서해선',
    aliases: ['서해선'],
  },
  {
    id: '1032',
    name: 'GTX-A',
    aliases: ['gtx-a', 'gtxa'],
  },
];

function compact(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s·.,\-_/]/g, '');
}

/** Seoul subway feed id for a Kakao vehicle name such as "4호선" or "수도권 1호선". */
export function subwayLineId(name: string): string | null {
  const key = compact(name)
    .replace(/^(서울|수도권|지하철)/, '')
    .replace(/(급행|일반|특급|직통)$/, '');

  for (const line of SUBWAY_LINES) {
    if (line.aliases.some((alias) => compact(alias) === key || compact(alias) === compact(name))) {
      return line.id;
    }
  }

  return null;
}

export function subwayLineName(id: string): string | null {
  return SUBWAY_LINES.find((line) => line.id === id)?.name ?? null;
}

/** "숙대입구(서울시교육청)" → "숙대입구", "서울역" → "서울". */
export function stationBaseName(name: string): string {
  const withoutParentheses = name
    .normalize('NFC')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, '')
    .trim();

  return withoutParentheses.length > 2 && withoutParentheses.endsWith('역')
    ? withoutParentheses.slice(0, -1)
    : withoutParentheses === '서울역'
      ? '서울'
      : withoutParentheses;
}

/** Stable bus route key: "N75(심야)" → "N75", " 402 " → "402", "마을 종로12" → "종로12". */
export function busRouteKey(name: string): string {
  return compact(
    name
      .replace(/\((심야|급행|직행|좌석|맞춤)\)/g, '')
      .replace(/^(간선|지선|광역|순환|마을|직행|좌석|공항|심야)\s+/, ''),
  ).toUpperCase();
}

/** Similarity of two stop names after removing punctuation and parenthetical platform labels. */
export function stopNamesMatch(a: string, b: string): boolean {
  const left = compact(a),
    right = compact(b);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const baseLeft = compact(a.replace(/\([^)]*\)/g, '')),
    baseRight = compact(b.replace(/\([^)]*\)/g, ''));

  return (
    !!baseLeft &&
    !!baseRight &&
    (baseLeft === baseRight || baseLeft.startsWith(baseRight) || baseRight.startsWith(baseLeft))
  );
}

/** Seoul night buses ("N13(심야)", "N75") run only overnight. */
export function isNightOnlyLine(name: string): boolean {
  return /\(심야\)/.test(name) || /^N\d{1,3}$/i.test(busRouteKey(name));
}

/** Seoul night bus window, 23:00–04:30 KST with a small margin for the last run. */
export function isNightServiceHour(now: number): boolean {
  const kst = new Date(now + 9 * 3_600_000);
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();

  return minutes >= 23 * 60 || minutes < 4 * 60 + 30;
}

const RADIUS = 6_371_008.8;

export function metersBetween(
  a: {
    latitude: number;
    longitude: number;
  },
  b: {
    latitude: number;
    longitude: number;
  },
): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;

  const dLat = toRadians(b.latitude - a.latitude),
    dLon = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;

  return 2 * RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Parse Korean arrival phrases: "3분 12초 후", "5분후[2번째 전]", "곧 도착". */
export function parseArrivalPhrase(message: string): {
  seconds: number | null;
  stopsAway: number | null;
} {
  const value = message.replace(/\s+/g, '');
  const stops = value.match(/\[?(\d+)\]?번째(?:전역|전)/);
  const stopsAway = stops ? Number(stops[1]) : null;
  let seconds: number | null = null;
  const minuteSecond = value.match(/(\d+)분(\d+)초/);
  const minute = value.match(/(\d+)분/);
  const second = value.match(/(\d+)초/);

  if (minuteSecond) {
    seconds = Number(minuteSecond[1]) * 60 + Number(minuteSecond[2]);
  } else if (minute) {
    seconds = Number(minute[1]) * 60;
  } else if (second) {
    seconds = Number(second[1]);
  } else if (/곧도착|도착임박|진입|잠시후/.test(value)) {
    seconds = 30;
  }

  return {
    seconds,
    stopsAway,
  };
}
