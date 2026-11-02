import type {
  SubwayLineArrival,
  SubwayLinePath,
  SubwayLineTrain,
  SubwayLineView,
} from '../../shared/domain/subwayLine.js';
import { fetchFeedJson, FeedError, type FeedOptions } from './http.js';
import { stationBaseName, subwayLineId } from './names.js';

/** Lines with a live position feed: the station master's name, the feed's name and the short transfer label. */
const LINES = [
  { id: '1001', name: '1호선', master: '01호선', short: '1' },
  { id: '1002', name: '2호선', master: '02호선', short: '2' },
  { id: '1003', name: '3호선', master: '03호선', short: '3' },
  { id: '1004', name: '4호선', master: '04호선', short: '4' },
  { id: '1005', name: '5호선', master: '05호선', short: '5' },
  { id: '1006', name: '6호선', master: '06호선', short: '6' },
  { id: '1007', name: '7호선', master: '07호선', short: '7' },
  { id: '1008', name: '8호선', master: '08호선', short: '8' },
  { id: '1009', name: '9호선', master: '09호선', short: '9' },
  { id: '1063', name: '경의중앙선', master: '경의선', short: '경의중앙' },
  { id: '1065', name: '공항철도', master: '공항철도', short: '공항' },
  { id: '1067', name: '경춘선', master: '경춘선', short: '경춘' },
  { id: '1075', name: '수인분당선', master: '수인분당선', short: '수인분당' },
  { id: '1077', name: '신분당선', master: '신분당선', short: '신분당' },
  { id: '1081', name: '경강선', master: '경강선', short: '경강' },
  { id: '1092', name: '우이신설선', master: '우이신설경전철', short: '우이신설' },
  { id: '1093', name: '서해선', master: '서해선', short: '서해' },
  { id: '1094', name: '신림선', master: '신림선', short: '신림' },
  { id: '1032', name: 'GTX-A', master: 'GTX-A', short: 'GTX-A' },
] as const;
const OTHER_MASTER_LABELS: Record<string, string> = {
  인천선: '인천1',
  인천2호선: '인천2',
  용인경전철: '에버라인',
  의정부경전철: '의정부',
  김포도시철도: '김포골드',
};
const CIRCULAR = new Set(['1002']);
/** Junctions that station codes cannot express, by station name. */
const JUNCTIONS: Record<string, { add?: [string, string][]; remove?: [string, string][] }> = {
  경의선: {
    add: [
      ['공덕', '효창공원앞'],
      ['효창공원앞', '용산'],
      ['가좌', '신촌'],
    ],
  },
  경춘선: { add: [['광운대', '상봉']], remove: [['광운대', '청량리']] },
};

interface StationRow {
  code: string;
  name: string;
}
interface Node {
  code: string;
  name: string;
  series: string;
  value: number;
  branch: number;
}

/** "P157-1" → series P1, value 157, branch 1; "A042" (inserted between A04 and A05) → value 4.2. */
function parseCodes(rows: readonly StationRow[]): Node[] {
  const parsed = rows.flatMap((row) => {
    const match = /^([A-Z]*)(\d+)(?:-(\d+))?$/.exec(row.code.trim());
    return match
      ? [{ row, prefix: match[1], digits: match[2], branch: match[3] ? Number(match[3]) : 0 }]
      : [];
  });
  const lengths = new Map<string, Map<number, number>>();
  for (const item of parsed) {
    const counts = lengths.get(item.prefix) ?? new Map<number, number>();
    counts.set(item.digits.length, (counts.get(item.digits.length) ?? 0) + 1);
    lengths.set(item.prefix, counts);
  }
  const standard = (prefix: string) =>
    [...lengths.get(prefix)!].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  return parsed.map(({ row, prefix, digits, branch }) => {
    const length = standard(prefix);
    const value =
      digits.length > length
        ? Number(digits.slice(0, length)) +
          Number(digits.slice(length)) / 10 ** (digits.length - length)
        : Number(digits);
    return {
      code: row.code.trim(),
      name: row.name.trim(),
      series: prefix + (Math.min(length, digits.length) >= 3 ? digits[0] : ''),
      value,
      branch,
    };
  });
}

/**
 * Every terminus-to-terminus path of a line, built from station code order: a "-n" code branches
 * from its base station, and a lettered series (1호선 P142…) continues from the station one
 * number below its first code. A circular line is one loop plus its branches.
 */
export function buildLinePaths(
  rows: readonly StationRow[],
  circular = false,
  junctions: { add?: [string, string][]; remove?: [string, string][] } = {},
): { name: string; code: string }[][] {
  const nodes = parseCodes(rows);
  const byCode = new Map(nodes.map((node) => [node.code, node]));
  const edges = new Map<string, Set<string>>();
  const link = (a: Node, b: Node) => {
    edges.set(a.code, (edges.get(a.code) ?? new Set()).add(b.code));
    edges.set(b.code, (edges.get(b.code) ?? new Set()).add(a.code));
  };
  const series = new Map<string, Node[]>();
  for (const node of nodes.filter((item) => !item.branch))
    series.set(node.series, [...(series.get(node.series) ?? []), node]);
  for (const chain of series.values()) chain.sort((a, b) => a.value - b.value);
  const main = (seriesKey: string, value: number) =>
    series.get(seriesKey)?.find((node) => Math.abs(node.value - value) < 1e-9);
  const branchChains = new Map<string, Node[]>();
  for (const node of nodes.filter((item) => item.branch)) {
    const key = `${node.series}:${node.value}`;
    branchChains.set(
      key,
      [...(branchChains.get(key) ?? []), node].sort((a, b) => a.branch - b.branch),
    );
  }
  const loops: Node[][] = [];
  const rootSeries = [...series.keys()].sort(
    (a, b) => Number(/^[A-Z]/.test(a)) - Number(/^[A-Z]/.test(b)) || a.localeCompare(b),
  )[0];
  for (const [key, chain] of series) {
    chain.forEach((node, index) => {
      if (index) link(chain[index - 1], node);
    });
    if (circular && key === rootSeries && chain.length > 2) {
      link(chain.at(-1)!, chain[0]);
      loops.push(chain);
    } else if (key !== rootSeries) {
      const anchor = [...series.entries()]
        .filter(([other]) => other !== key)
        .map(([other]) => main(other, chain[0].value - 1))
        .find(Boolean);
      if (anchor) link(anchor, chain[0]);
    }
  }
  for (const [key, chain] of branchChains) {
    const [seriesKey, value] = [
      key.slice(0, key.lastIndexOf(':')),
      Number(key.slice(key.lastIndexOf(':') + 1)),
    ];
    const base = main(seriesKey, value);
    if (!base) continue;
    link(base, chain[0]);
    chain.forEach((node, index) => {
      if (index) link(chain[index - 1], node);
    });
  }
  const named = (name: string) => nodes.find((node) => node.name === name);
  for (const [a, b] of junctions.remove ?? []) {
    const [left, right] = [named(a), named(b)];
    if (left && right) {
      edges.get(left.code)?.delete(right.code);
      edges.get(right.code)?.delete(left.code);
    }
  }
  for (const [a, b] of junctions.add ?? []) {
    const [left, right] = [named(a), named(b)];
    if (left && right) link(left, right);
  }
  const pathBetween = (from: string, to: string, blocked: Set<string> = new Set()) => {
    const previous = new Map<string, string | null>([[from, null]]),
      queue = [from];
    while (queue.length) {
      const current = queue.shift()!;
      if (current === to) break;
      for (const next of edges.get(current) ?? [])
        if (!previous.has(next) && !blocked.has(next)) {
          previous.set(next, current);
          queue.push(next);
        }
    }
    if (!previous.has(to)) return null;
    const path: string[] = [];
    for (let at: string | null = to; at !== null; at = previous.get(at)!) path.unshift(at);
    return path;
  };
  const toStations = (codes: string[]) =>
    codes.map((code) => ({ name: byCode.get(code)!.name, code }));
  const paths: { name: string; code: string }[][] = [];
  if (loops.length) {
    const loop = loops[0],
      inLoop = new Set(loop.map((node) => node.code));
    paths.push(toStations(loop.map((node) => node.code)));
    for (const node of loop)
      for (const next of edges.get(node.code) ?? []) {
        if (inLoop.has(next)) continue;
        const leaves = [...edges.keys()].filter(
          (code) => !inLoop.has(code) && (edges.get(code)?.size ?? 0) === 1,
        );
        for (const leaf of leaves) {
          const path = pathBetween(
            node.code,
            leaf,
            new Set([...inLoop].filter((code) => code !== node.code)),
          );
          if (path && path[1] === next) paths.push(toStations(path));
        }
      }
    return paths;
  }
  const order = new Map(
    [...nodes]
      .sort((a, b) => a.series.localeCompare(b.series) || a.value - b.value || a.branch - b.branch)
      .map((node, index) => [node.code, index]),
  );
  const farthest = (from: string) => {
    const distance = new Map([[from, 0]]);
    for (const queue = [from]; queue.length;) {
      const at = queue.shift()!;
      for (const next of edges.get(at) ?? [])
        if (!distance.has(next)) {
          distance.set(next, distance.get(at)! + 1);
          queue.push(next);
        }
    }
    return [...distance].sort((a, b) => b[1] - a[1] || order.get(a[0])! - order.get(b[0])!)[0][0];
  };
  const visited = new Set<string>();
  for (const start of [...(series.get(rootSeries) ?? []), ...nodes]) {
    if (visited.has(start.code)) continue;
    const component = new Set<string>([start.code]);
    for (const queue = [start.code]; queue.length;)
      for (const next of edges.get(queue.shift()!) ?? [])
        if (!component.has(next)) {
          component.add(next);
          queue.push(next);
        }
    component.forEach((code) => visited.add(code));
    if (component.size === 1) {
      paths.push(toStations([start.code]));
      continue;
    }
    // Paths start at one end of the line's longest run (연천 for 1호선, 방화 for 5호선).
    const end = farthest(start.code),
      other = farthest(end);
    const root = order.get(end)! <= order.get(other)! ? end : other;
    const leaves = [...component]
      .filter((code) => code !== root && (edges.get(code)?.size ?? 0) <= 1)
      .sort((a, b) => order.get(a)! - order.get(b)!);
    for (const leaf of leaves) {
      const path = pathBetween(root, leaf);
      if (path) paths.push(toStations(path));
    }
  }
  return paths;
}

interface PositionRow {
  statnNm?: unknown;
  trainNo?: unknown;
  updnLine?: unknown;
  statnTnm?: unknown;
  trainSttus?: unknown;
  directAt?: unknown;
  lstcarAt?: unknown;
  recptnDt?: unknown;
}
const kst = (value: unknown) => {
  const match =
    typeof value === 'string'
      ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim())
      : null;
  return match
    ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4] - 9, +match[5], +match[6])
    : null;
};
const terminalName = (value: string) => stationBaseName(value.replace(/(종착|행)$/, ''));
const STATUS = { '0': 'approach', '1': 'arrive', '2': 'depart', '3': 'previous' } as const;
/** Where a train sits relative to its station, in station steps along its own travel. */
const OFFSET = { previous: -0.6, approach: -0.3, arrive: 0, depart: 0.4 } as const;

export interface SubwayLineOptions extends FeedOptions {
  seoulKey?: string;
  realtimeKey?: string;
  now?: () => number;
}

/** Live train positions on a line, laid out on its station paths, with arrivals at one station. */
export class SubwayLineService {
  private master: {
    at: number;
    value: Promise<{ line: string; code: string; name: string }[]>;
  } | null = null;
  private readonly positions = new Map<string, { at: number; value: Promise<PositionRow[]> }>();
  private readonly arrivals = new Map<
    string,
    { at: number; value: Promise<Record<string, unknown>[]> }
  >();
  private readonly now: () => number;

  constructor(private readonly options: SubwayLineOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.options.seoulKey?.trim() && !!this.options.realtimeKey?.trim();
  }

  static lineFor(name: string) {
    const id =
      subwayLineId(name) ??
      LINES.find((line) => line.name === name.trim() || line.master === name.trim())?.id;
    return LINES.find((line) => line.id === id) ?? null;
  }

  private stations() {
    if (!this.master || this.now() - this.master.at > 86_400_000) {
      const value = (async () => {
        const url = new URL(
          `http://openapi.seoul.go.kr:8088/${encodeURIComponent(this.options.seoulKey!.trim())}/json/SearchSTNBySubwayLineInfo/1/1000/`,
        );
        const body = (await fetchFeedJson(url, {
          ...this.options,
          timeoutMs: this.options.timeoutMs ?? 6_000,
        })) as { SearchSTNBySubwayLineInfo?: { row?: Record<string, unknown>[] } };
        const rows = body.SearchSTNBySubwayLineInfo?.row ?? [];
        if (!rows.length) throw new FeedError('format');
        return rows
          .map((row) => ({
            line: String(row.LINE_NUM ?? '').trim(),
            code: String(row.FR_CODE ?? '').trim(),
            name: String(row.STATION_NM ?? '').trim(),
          }))
          .filter((row) => row.line && row.code && row.name);
      })();
      this.master = { at: this.now(), value };
      value.catch(() => {
        if (this.master?.value === value) this.master = null;
      });
    }
    return this.master.value;
  }

  private trains(line: string) {
    const cached = this.positions.get(line);
    if (cached && this.now() - cached.at < 10_000) return cached.value;
    const value = (async () => {
      const url = new URL(
        `http://swopenapi.seoul.go.kr/api/subway/${encodeURIComponent(this.options.realtimeKey!.trim())}/json/realtimePosition/0/300/${encodeURIComponent(line)}`,
      );
      const body = (await fetchFeedJson(url, {
        ...this.options,
        timeoutMs: this.options.timeoutMs ?? 4_000,
      })) as { realtimePositionList?: PositionRow[]; errorMessage?: { code?: string } };
      if (
        body.errorMessage?.code &&
        !body.errorMessage.code.startsWith('INFO-000') &&
        body.errorMessage.code !== 'INFO-200'
      )
        throw new FeedError(body.errorMessage.code === 'INFO-100' ? 'auth' : 'format');
      return body.realtimePositionList ?? [];
    })();
    this.positions.set(line, { at: this.now(), value });
    value.catch(() => {
      if (this.positions.get(line)?.value === value) this.positions.delete(line);
    });
    return value;
  }

  private stationArrivals(station: string) {
    const cached = this.arrivals.get(station);
    if (cached && this.now() - cached.at < 10_000) return cached.value;
    const value = (async () => {
      for (const name of [...new Set([stationBaseName(station), station.replace(/\s+/g, '')])]) {
        const url = new URL(
          `http://swopenapi.seoul.go.kr/api/subway/${encodeURIComponent(this.options.realtimeKey!.trim())}/json/realtimeStationArrival/0/60/${encodeURIComponent(name)}`,
        );
        const body = (await fetchFeedJson(url, {
          ...this.options,
          timeoutMs: this.options.timeoutMs ?? 4_000,
        })) as { realtimeArrivalList?: Record<string, unknown>[] };
        if (body.realtimeArrivalList?.length) return body.realtimeArrivalList;
      }
      return [];
    })();
    this.arrivals.set(station, { at: this.now(), value });
    value.catch(() => {
      if (this.arrivals.get(station)?.value === value) this.arrivals.delete(station);
    });
    if (this.arrivals.size > 200) this.arrivals.delete(this.arrivals.keys().next().value!);
    return value;
  }

  async view(lineName: string, stationName?: string): Promise<SubwayLineView | null> {
    const line = SubwayLineService.lineFor(lineName);
    if (!line) return null;
    const [master, rows] = await Promise.all([this.stations(), this.trains(line.name)]);
    const own = master.filter((row) => row.line === line.master);
    if (!own.length) return null;
    const transfers = new Map<string, string[]>();
    for (const row of master)
      if (row.line !== line.master) {
        const label =
          LINES.find((item) => item.master === row.line)?.short ?? OTHER_MASTER_LABELS[row.line];
        if (label)
          transfers.set(stationBaseName(row.name), [
            ...new Set([...(transfers.get(stationBaseName(row.name)) ?? []), label]),
          ]);
      }
    const rawPaths = buildLinePaths(own, CIRCULAR.has(line.id), JUNCTIONS[line.master]);
    const circular = CIRCULAR.has(line.id);
    // Undirected adjacency for direction: a train heads toward its terminus.
    const neighbours = new Map<string, Set<string>>();
    rawPaths.forEach((path, index) =>
      path.forEach((station, at) => {
        const around = [
          path[at - 1],
          path[at + 1],
          ...(circular && index === 0
            ? [at === 0 ? path.at(-1) : undefined, at === path.length - 1 ? path[0] : undefined]
            : []),
        ];
        for (const next of around)
          if (next)
            neighbours.set(
              station.code,
              (neighbours.get(station.code) ?? new Set()).add(next.code),
            );
      }),
    );
    const codesByName = new Map<string, string[]>();
    for (const row of own)
      codesByName.set(stationBaseName(row.name), [
        ...(codesByName.get(stationBaseName(row.name)) ?? []),
        row.code,
      ]);
    const distances = new Map<string, Map<string, number>>();
    const distanceFrom = (start: string) => {
      const cached = distances.get(start);
      if (cached) return cached;
      const distance = new Map([[start, 0]]);
      for (const queue = [start]; queue.length;) {
        const at = queue.shift()!;
        for (const next of neighbours.get(at) ?? [])
          if (!distance.has(next)) {
            distance.set(next, distance.get(at)! + 1);
            queue.push(next);
          }
      }
      distances.set(start, distance);
      return distance;
    };
    const reports = rows.flatMap((row) => {
      const station = codesByName.get(stationBaseName(String(row.statnNm ?? '')))?.[0],
        status = STATUS[String(row.trainSttus ?? '') as keyof typeof STATUS];
      const receivedAt = kst(row.recptnDt);
      if (!station || !status || receivedAt === null || this.now() - receivedAt > 180_000)
        return [];
      const terminal = terminalName(String(row.statnTnm ?? ''));
      return [
        {
          station,
          status,
          receivedAt,
          trainNo: String(row.trainNo ?? '').trim(),
          updn: String(row.updnLine ?? ''),
          terminal,
          terminalCode: codesByName.get(terminal)?.[0],
          express: String(row.directAt ?? '') === '1' || String(row.directAt ?? '') === '7',
          last: String(row.lstcarAt ?? '') === '1',
        },
      ];
    });
    // The feed can repeat a train with an older report; keep its newest position.
    const newest = new Map<string, (typeof reports)[number]>();
    for (const report of reports) {
      const key = report.trainNo
          ? `${report.trainNo}:${report.updn}`
          : `${report.station}:${report.terminal}:${report.receivedAt}`,
        kept = newest.get(key);
      if (
        !kept ||
        report.receivedAt > kept.receivedAt ||
        (report.receivedAt === kept.receivedAt && OFFSET[report.status] > OFFSET[kept.status])
      )
        newest.set(key, report);
    }
    const observed = [...newest.values()];
    /** Away from a path's first station when the terminus lies ahead; null when this path cannot tell. */
    const headsForward = (
      path: StationRow[],
      at: number,
      train: (typeof observed)[number],
    ): boolean | null => {
      if (!train.terminalCode || train.terminalCode === train.station) return null;
      const distance = distanceFrom(train.terminalCode);
      const ahead = path[at + 1] ? distance.get(path[at + 1].code) : undefined,
        behind = path[at - 1] ? distance.get(path[at - 1].code) : undefined;
      if (ahead !== undefined && (behind === undefined || ahead < behind)) return true;
      if (behind !== undefined && (ahead === undefined || behind < ahead)) return false;
      // At a junction the terminus is on another branch: farther from the path's start means onward.
      const fromStart = distanceFrom(path[0].code),
        terminal = fromStart.get(train.terminalCode),
        here = fromStart.get(train.station);
      return terminal === undefined || here === undefined || terminal === here
        ? null
        : terminal > here;
    };
    // The up/down flag is per line; learn which way it points from trains whose terminus decides.
    const votes = new Map<string, number>();
    for (const train of observed)
      for (const path of rawPaths.slice(circular ? 1 : 0)) {
        const at = path.findIndex((station) => station.code === train.station),
          forward = at < 0 ? null : headsForward(path, at, train);
        if (forward !== null) {
          votes.set(train.updn, (votes.get(train.updn) ?? 0) + (forward ? 1 : -1));
          break;
        }
      }
    const view: SubwayLineView = {
      line: line.name,
      lineId: line.id,
      generatedAt: this.now(),
      observedAt: observed.length ? Math.max(...observed.map((train) => train.receivedAt)) : null,
      paths: [],
      selected: null,
      arrivals: [],
    };
    view.paths = rawPaths.map((path, index): SubwayLinePath => {
      const position = new Map(path.map((station, at) => [station.code, at]));
      const loop = circular && index === 0;
      const trains = observed.flatMap((train): SubwayLineTrain[] => {
        const at = position.get(train.station);
        if (at === undefined) return [];
        // 2호선 내선(0) runs in station-code order around the loop.
        const forward = loop
          ? train.updn === '0'
          : (headsForward(path, at, train) ??
            (votes.get(train.updn) ?? (train.updn === '0' ? -1 : 1)) > 0);
        const raw = at + (forward ? 1 : -1) * OFFSET[train.status];
        const value = loop
          ? (raw + path.length) % path.length
          : Math.max(0, Math.min(path.length - 1, raw));
        return [
          {
            trainNo: train.trainNo,
            terminal: train.terminal,
            express: train.express,
            last: train.last,
            status: train.status,
            station: path[at].name,
            position: value,
            forward,
          },
        ];
      });
      return {
        label: loop ? `${line.name} 순환` : `${path[0].name}–${path.at(-1)!.name}`,
        circular: loop,
        stations: path.map((station) => ({
          name: station.name,
          code: station.code,
          transfers: transfers.get(stationBaseName(station.name)) ?? [],
        })),
        trains,
      };
    });
    if (stationName) {
      const base = stationBaseName(stationName);
      const candidates = view.paths.flatMap((path, pathIndex) =>
        path.stations.flatMap((station, stationIndex) =>
          stationBaseName(station.name) === base ? [{ pathIndex, stationIndex }] : [],
        ),
      );
      // The path with the most trains through this station is the one people ride.
      const best = candidates.sort(
        (a, b) =>
          view.paths[b.pathIndex].trains.length - view.paths[a.pathIndex].trains.length ||
          a.pathIndex - b.pathIndex,
      )[0];
      if (best) {
        view.selected = { path: best.pathIndex, station: best.stationIndex };
        const path = view.paths[best.pathIndex],
          next =
            path.stations[best.stationIndex + 1] ?? (path.circular ? path.stations[0] : undefined);
        const previous =
          path.stations[best.stationIndex - 1] ??
          (path.circular ? path.stations.at(-1) : undefined);
        const rowsAtStation = await this.stationArrivals(
          path.stations[best.stationIndex].name,
        ).catch(() => []);
        const seen = new Set<string>();
        view.arrivals = rowsAtStation
          .filter((row) => String(row.subwayId ?? '') === line.id)
          .flatMap((row): SubwayLineArrival[] => {
            const code = String(row.arvlCd ?? ''),
              message = String(row.arvlMsg2 ?? '').trim(),
              trainNo = String(row.btrainNo ?? '').trim();
            if (code === '2' || (trainNo && seen.has(trainNo))) return [];
            const observedAt = kst(row.recptnDt) ?? this.now(),
              countdown = Number(row.barvlDt) > 0 ? Number(row.barvlDt) : null;
            // Korail-run lines report "[3]번째 전역" without a countdown; a stop takes about two minutes.
            const stops = /\[(\d+)\]번째 전역/.exec(message)?.[1];
            const stopsAway = stops
              ? Number(stops)
              : ['0', '1'].includes(code)
                ? 0
                : ['3', '4', '5'].includes(code)
                  ? 1
                  : null;
            const arrivesAt =
              countdown !== null
                ? observedAt + countdown * 1000
                : stopsAway !== null
                  ? observedAt + stopsAway * 120_000
                  : null;
            const towards = stationBaseName(
              /-\s*(.+?)방면/.exec(String(row.trainLineNm ?? ''))?.[1] ?? '',
            );
            // A train ending here names this station as its heading; it arrives from the only neighbour.
            const here = stationBaseName(path.stations[best.stationIndex].name) === towards;
            const forward =
              (next && stationBaseName(next.name) === towards) || (here && !next)
                ? true
                : (previous && stationBaseName(previous.name) === towards) || (here && !previous)
                  ? false
                  : null;
            if (arrivesAt === null || forward === null || arrivesAt < this.now() - 30_000)
              return [];
            if (trainNo) seen.add(trainNo);
            return [
              {
                forward,
                terminal: String(row.bstatnNm ?? '').trim(),
                arrivesAt,
                message,
                express: /급행|특급|직통/.test(String(row.btrainSttus ?? '')),
                stopsAway,
                estimated: countdown === null,
              },
            ];
          })
          .sort((a, b) => a.arrivesAt - b.arrivesAt);
      }
    }
    return view;
  }
}
