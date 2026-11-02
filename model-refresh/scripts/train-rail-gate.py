#!/usr/bin/env python3
"""Subway gate-to-gate (rail-gate-elapsed) envelope candidate, seoul-rail-gate-v1.

The app plans a subway run as half-headway or live wait + Kakao ride time and has no
station-interior time. T-DATA gate tags cover entry gate -> platform -> wait -> ride
-> transfers -> exit gate. This model predicts that elapsed time and an upper bound
that may widen (never shorten) the app's subway run.

Features: station coordinates (official T-DATA GEOM), Seoul hour/day type (reviewed
holidays read as Sunday), and out-of-day target encodings of the station pair and of
each station. Training rows only see encodings computed from other training days.
Calibration is one-sided CQR in log space per day type x day part.

Phases: dev-a / dev-b use days <= 10/11 that earlier rail experiments already
inspected. `final` evaluates the unseen 10/12, 10/14-10/16 once; a different protocol
on those days is refused through data/rail-gate-evaluations.json. `refresh` takes the same
rules on a later window: --window FIRST,TUNE_THROUGH,TRAIN_THROUGH,CALIBRATION_THROUGH,EVAL[+EVAL...].
"""
from __future__ import annotations
import argparse, collections, csv, datetime as dt, hashlib, importlib.util, json, math, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from private_files import open_private, restrict_private_path
spec = importlib.util.spec_from_file_location('spatial_bicycle_training', Path(__file__).with_name('train-spatial-bicycle.py'))
shared = importlib.util.module_from_spec(spec); spec.loader.exec_module(shared)

VERSION = 'seoul-rail-gate-v1'
KST = dt.timezone(dt.timedelta(hours=9))
FEATURES = ['log1pEndpointMeters', 'originLatitude', 'originLongitude', 'destinationLatitude', 'destinationLongitude',
            'northMeters', 'eastMeters', 'seoulHourSin', 'seoulHourCos', 'seoulWeekdaySin', 'seoulWeekdayCos', 'weekend',
            'odLogMedian', 'odLogCount', 'originLogEffect', 'originLogCount', 'destinationLogEffect', 'destinationLogCount']
DAY_PARTS = [('overnight', 0, 6), ('morning', 6, 10), ('daytime', 10, 17), ('evening', 17, 21), ('night', 21, 24)]
GROUPS = [f'{kind}:{name}' for kind in ['weekday', 'weekend'] for name, _, _ in DAY_PARTS]
PHASES = {
    # Weekday-free calibration windows cannot calibrate weekday rides, so every window spans both day types.
    'dev-a': {'first': '2026-09-28', 'tuneThrough': '2026-10-02', 'trainThrough': '2026-10-05', 'calibrationThrough': '2026-10-10', 'evaluation': ['2026-10-11']},
    'dev-b': {'first': '2026-09-28', 'tuneThrough': '2026-09-30', 'trainThrough': '2026-10-01', 'calibrationThrough': '2026-10-06', 'evaluation': ['2026-10-07', '2026-10-08']},
    'final': {'first': '2026-09-28', 'tuneThrough': '2026-10-03', 'trainThrough': '2026-10-06', 'calibrationThrough': '2026-10-11',
              'evaluation': ['2026-10-12', '2026-10-14', '2026-10-15', '2026-10-16']},
}
HOLIDAY_FILE = Path(__file__).resolve().parents[2] / 'src' / 'common' / 'engine' / 'realtime' / 'data' / 'korea-holidays-2026.json'
REGISTRY = 'rail-gate-evaluations.json'
TOKEN = re.compile(r'^[a-f0-9]{64}$')
PRIOR_ROWS = 5  # encodings shrink toward the citywide value with this many pseudo-rows


def write_new(path, value):
    with open_private(path) as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(',', ':')); stream.write('\n'); stream.flush()


def bare(name):
    return re.sub(r'역$', '', re.sub(r'\(.*?\)', '', str(name)).strip()) if name else ''


def load_stations(path):
    by_id, by_name = collections.defaultdict(set), collections.defaultdict(set)
    with path.open(encoding='utf-8-sig') as source:
        for row in csv.DictReader(source):
            point = (float(row['환승역Y좌표']), float(row['환승역X좌표']))
            if not (36 < point[0] < 39 and 125 < point[1] < 130): raise ValueError('station_region')
            by_id[row['외구간_역_수'].strip()].add(point); by_name[bare(row['역한글명칭'])].add(point)
    def unique(points):
        points = sorted(points)
        if not points or any(meters(a, b) > 100 for a in points for b in points): return None
        return tuple(sum(p[i] for p in points)/len(points) for i in [0, 1])
    return {k: unique(v) for k, v in by_id.items()}, {k: unique(v) for k, v in by_name.items()}


def meters(a, b):
    r = math.pi/180; v = math.sin((b[0]-a[0])*r/2)**2+math.cos(a[0]*r)*math.cos(b[0]*r)*math.sin((b[1]-a[1])*r/2)**2
    return 6371000*2*math.atan2(math.sqrt(v), math.sqrt(max(0, 1-v)))


def day_type(local, holidays):
    weekday = 0 if local.date().isoformat() in holidays else (local.weekday()+1) % 7
    return weekday, weekday in (0, 6)


def base_features(origin, destination, started_at, holidays):
    a, b = origin; c, d = destination
    distance = meters(origin, destination)
    local = dt.datetime.fromtimestamp(started_at/1000, KST)
    hour = (local.hour+local.minute/60+local.second/3600)/24*2*math.pi
    weekday, weekend = day_type(local, holidays)
    return [math.log1p(distance), a, b, c, d, (c-a)*111195.0802335329, (d-b)*111195.0802335329*math.cos((a+c)/2*math.pi/180),
            math.sin(hour), math.cos(hour), math.sin(weekday/7*2*math.pi), math.cos(weekday/7*2*math.pi), float(weekend)]


def quantize(values):
    # Identical to ECMAScript Math.round so libm/V8 ulp differences cannot change a tree branch.
    return [math.floor(v*1e6+.5)/1e6 for v in values]


def group_of(started_at, holidays):
    local = dt.datetime.fromtimestamp(started_at/1000, KST)
    _, weekend = day_type(local, holidays)
    return f"{'weekend' if weekend else 'weekday'}:{next(n for n, a, b in DAY_PARTS if a <= local.hour < b)}"


class Encoder:
    """Shrunken medians of log seconds (pair) and of log(seconds / distance baseline) (stations)."""
    def __init__(self, rows, logs, residuals):
        self.global_log = statistics_median(logs)
        self.pair = collections.defaultdict(list); self.origin = collections.defaultdict(list); self.destination = collections.defaultdict(list)
        for row, value, residual in zip(rows, logs, residuals):
            self.pair[(row['originName'], row['destinationName'])].append(value)
            self.origin[row['originName']].append(residual); self.destination[row['destinationName']].append(residual)
    @staticmethod
    def summary(values, prior):
        if not values: return prior, 0.0
        n = len(values)
        return (statistics_median(values)*n + prior*PRIOR_ROWS)/(n+PRIOR_ROWS), math.log1p(n)
    def encode(self, origin_name, destination_name, spatial_log):
        od = self.summary(self.pair.get((origin_name, destination_name), []), spatial_log)
        o = self.summary(self.origin.get(origin_name, []), 0.0); d = self.summary(self.destination.get(destination_name, []), 0.0)
        return [od[0], od[1], o[0], o[1], d[0], d[1]]
    def tables(self):
        # Unrounded medians: the server must rebuild exactly the encodings the trees were fitted on.
        stat = lambda values: [statistics_median(values), len(values)]
        return {'pairs': [[o, d, *stat(v)] for (o, d), v in sorted(self.pair.items())],
                'origins': [[k, *stat(v)] for k, v in sorted(self.origin.items())], 'destinations': [[k, *stat(v)] for k, v in sorted(self.destination.items())]}


def statistics_median(values):
    ordered = sorted(values); n = len(ordered)
    return ordered[n//2] if n % 2 else (ordered[n//2-1]+ordered[n//2])/2


def validate(row):
    if row.get('version') != 1 or (row.get('source'), row.get('target')) != ('seoul-tdata-rail', 'rail-gate-elapsed') or row.get('uncertaintySeconds') != 60: raise ValueError('target_contract')
    if any(not TOKEN.fullmatch(str(row.get(k, ''))) for k in ['id', 'groupId', 'journeyGroup', 'cardGroup', 'sourceArchiveSha256']): raise ValueError('missing_group')
    start, end, seconds = row['startedAt'], row['observedAt'], row['actualSeconds']
    if not 180 <= seconds <= 10800 or start % 60000 or end % 60000 or end-start != seconds*1000 or row['modeSequence'] != ['subway']: raise ValueError('label_contract')
    if (dt.datetime.fromtimestamp(start/1000, KST)-dt.timedelta(hours=4)).date().isoformat() != row['sourceDate']: raise ValueError('source_date')


def refresh_window(value):
    parts = value.split(',')
    if len(parts) != 5: raise ValueError('window_format')
    phase = {'first': parts[0], 'tuneThrough': parts[1], 'trainThrough': parts[2], 'calibrationThrough': parts[3], 'evaluation': sorted(parts[4].split('+'))}
    days = [phase['first'], phase['tuneThrough'], phase['trainThrough'], phase['calibrationThrough'], *phase['evaluation']]
    if any(dt.date.fromisoformat(d).isoformat() != d for d in days) or not (phase['first'] <= phase['tuneThrough'] < phase['trainThrough'] < phase['calibrationThrough'] < phase['evaluation'][0]):
        raise ValueError('window_order')
    return phase


def station_point(row, side, by_id, by_name):
    """Official GEOM by station id, else the bare name's unique cluster; (point or None, 'id' | 'name' | 'missing')."""
    point = by_id.get(str(row[f'{side}StationId']).strip())
    if point is not None: return point, 'id'
    point = by_name.get(bare(row[f'{side}Name']))
    return point, 'name' if point else 'missing'


def day_end(day):
    """04:00 KST after the service day: a ride ending later belongs to the next day."""
    return int(dt.datetime.combine(dt.date.fromisoformat(day)+dt.timedelta(days=1), dt.time(4), KST).timestamp()*1000)


def training_mask(day, ended, known, phase):
    return (day <= phase['trainThrough']) & (ended < day_end(phase['trainThrough'])) & known


def supported_rows(x, known, domain):
    """Rows with coordinates whose distance and endpoints lie in the training domain (with the serving tolerance)."""
    supported = known.copy()
    for f in [0, 1, 2, 3, 4]:
        tolerance = .15*(domain['maximum'][f]-domain['minimum'][f]) if f == 0 else .015
        supported &= (x[:, f] >= domain['minimum'][f]-tolerance) & (x[:, f] <= domain['maximum'][f]+tolerance)
    return supported


# The ridge baseline and the quality gate below are also what model-refresh/incumbent-gate.py applies to the model in service.
RIDGE_COLUMNS = [0, 7, 8, 9, 10, 11]


def ridge_design(design_raw, center, scale):
    import numpy as np
    return np.column_stack((np.ones(len(design_raw)), np.clip((design_raw-center)/scale, -4, 4)))


def ridge_fit(design_raw, train, target):
    """Penalised fit of log(seconds / distance baseline) on distance, hour and day type, from the training rows of the full design."""
    import numpy as np
    center = np.median(design_raw[train], axis=0); scale = np.quantile(design_raw[train], .75, axis=0)-np.quantile(design_raw[train], .25, axis=0); scale = np.where(scale > 0, scale, 1)
    design = ridge_design(design_raw, center, scale); penalty = np.eye(design.shape[1]); penalty[0, 0] = 1e-8
    return center, scale, np.linalg.solve(design[train].T@design[train]+penalty, design[train].T@target)


def ridge_predict(design_raw, baseline, center, scale, coefficient):
    import numpy as np
    return baseline*np.exp(ridge_design(design_raw, center, scale)@coefficient)


def quality_evaluation(mask, y, supported, median, lo, hi, baseline, ridge, hybrid):
    import numpy as np
    def mae(values, rows): return float(np.mean(np.abs(values[rows]-y[rows]))) if rows.any() else None
    n = int(mask.sum()); accepted = mask & supported; k = int(accepted.sum())
    if not n: return None
    return {'rows': n, 'supported': k, 'unsupported': n-k, 'modelMaeSeconds': mae(median, accepted) if k == n else None, 'supportedModelMaeSeconds': mae(median, accepted),
            'distanceMaeSeconds': mae(baseline, accepted), 'ridgeMaeSeconds': mae(ridge, accepted), 'pairElseDistanceMaeSeconds': mae(hybrid, accepted),
            'medianSignedErrorSeconds': float(np.mean(median[accepted]-y[accepted])) if k else None,
            'robustIntervalCoverage': float(np.sum(accepted & (lo <= y-60) & (hi >= y+60))/n), 'robustUpperCoverage': float(np.sum(accepted & (hi >= y+60))/n),
            'meanRelativeWidth': float(np.mean((hi[accepted]-lo[accepted])/y[accepted])) if k else None, 'meanUpperSeconds': float(np.mean(hi[accepted])) if k else None}


def quality_passed(e):
    return bool(e and e['rows'] >= 100 and e['unsupported'] == 0 and e['modelMaeSeconds'] < min(e['distanceMaeSeconds'], e['ridgeMaeSeconds'], e['pairElseDistanceMaeSeconds'])
                and e['robustIntervalCoverage'] >= .8 and e['robustUpperCoverage'] >= .9 and e['meanRelativeWidth'] <= 1.5)


def quality_groups(m, seen, hours, day, evaluation_days):
    groups = {'all': m, 'seenOd': m & seen, 'unseenOd': m & ~seen}
    groups.update({f'dayPart:{n}': m & (hours >= a) & (hours < b) for n, a, b in DAY_PARTS})
    groups.update({f'day:{d}': m & (day == d) for d in evaluation_days})
    return groups


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=sorted(PHASES) + ['refresh'], required=True)
    parser.add_argument('--window', help='refresh only: FIRST,TUNE_THROUGH,TRAIN_THROUGH,CALIBRATION_THROUGH,EVAL[+EVAL...]')
    parser.add_argument('--input', action='append', required=True, help='Rail gate JSONL; repeat. Later files win for the dates they cover.')
    parser.add_argument('--stations', required=True); parser.add_argument('--output-directory', required=True)
    parser.add_argument('--upper-coverage', type=float, default=.93); parser.add_argument('--lower-coverage', type=float, default=.9)
    parser.add_argument('--holidays', nargs='+', help='Reviewed korea-holidays-YYYY.json for every year in the window (default: JIGAK_HOLIDAY_DIR, else the 2026 file).')
    parser.add_argument('--execute', action='store_true'); args = parser.parse_args()
    if (args.phase == 'refresh') != bool(args.window): raise ValueError('window_only_with_refresh')
    if args.phase == 'refresh':
        phase = refresh_window(args.window)
    else:
        phase = PHASES[args.phase]
    last_day = phase['evaluation'][-1]
    inputs = [shared.data_path(v) for v in args.input]; stations_path = shared.data_path(args.stations); output = shared.data_path(args.output_directory)
    if output.exists() or len(set(inputs)) != len(inputs) or any(not p.is_file() or p.stat().st_size > 384*1024**2 for p in inputs+[stations_path]): raise ValueError('paths_or_size')
    if not .9 <= args.upper_coverage < 1 or not .8 <= args.lower_coverage < 1 or args.upper_coverage+args.lower_coverage < 1.8: raise ValueError('coverage')
    holidays, holiday_sha = shared.holiday_calendars(args.holidays, HOLIDAY_FILE, phase['first'], last_day)
    protocol = {'version': VERSION, 'phase': args.phase, 'target': 'rail-gate-elapsed', 'deployment': 'candidate', **phase,
        'featureNames': FEATURES, 'dayRule': 'korean-public-holiday-as-sunday', 'holidays': sorted(h for h in holidays if phase['first'] <= h <= last_day),
        'holidayFileSha256': holiday_sha, 'encodings': {'pair': 'shrunken median log seconds by T-DATA station names', 'stations': 'shrunken median log(seconds / distance baseline)',
        'priorRows': PRIOR_ROWS, 'trainingRows': 'computed from other training service days only'},
        'coordinates': 'official GEOM by OUT_STN_NUM; else same bare name, unique <=100m cluster', 'featureQuantizationDecimals': 6,
        'selectionMetric': 'inner future median MAE', 'candidateLeaves': [15, 31, 63], 'maxIterations': 200, 'learningRate': .07, 'minimumLeafRows': 60,
        'l2Regularization': 10, 'earlyStopping': False, 'seed': 61016, 'threads': 4, 'quantiles': [.05, .5, .95],
        'calibration': {'method': 'one-sided-cqr-by-day-type-and-part-log-ratio', 'upperCoverage': args.upper_coverage, 'lowerCoverage': args.lower_coverage, 'groups': GROUPS, 'labelUncertaintySeconds': 60},
        'qualityGate': {'minimumRows': 100, 'maximumUnsupported': 0, 'intervalCoverage': .8, 'upperCoverage': .9, 'maximumMeanRelativeWidth': 1.5,
                        'maeImprovesBaselines': ['distance', 'ridge', 'pair-median-else-distance'], 'groups': 'all, seenOd, unseenOd, every day-part and every evaluation day'},
        'inputs': [{'file': p.name, 'sha256': shared.sha(p)} for p in inputs], 'stations': {'file': stations_path.name, 'sha256': shared.sha(stations_path)},
        'trainerSha256': shared.sha(Path(__file__))}
    protocol_sha = hashlib.sha256(json.dumps(protocol, sort_keys=True).encode()).hexdigest()
    if not args.execute: print(json.dumps(protocol)); return
    registry_path = shared.evaluation_registry(REGISTRY)
    if args.phase in ('final', 'refresh'):
        registry = json.loads(registry_path.read_text(encoding='utf-8')) if registry_path.exists() else {}
        for day in phase['evaluation']:
            if registry.get(day, protocol_sha) != protocol_sha: raise ValueError('evaluation_day_already_used_by_another_protocol')
    output.mkdir(parents=True, mode=0o700); restrict_private_path(output); write_new(output/'protocol.json', protocol)
    import numpy as np
    import sklearn
    from sklearn.ensemble import HistGradientBoostingRegressor
    from threadpoolctl import threadpool_limits
    begun = time.monotonic()
    by_id, by_name = load_stations(stations_path)
    by_day = {}
    for index, path in enumerate(inputs):
        days = collections.defaultdict(list)
        with path.open(encoding='utf-8') as stream:
            for line in stream:
                if line.strip():
                    row = json.loads(line)
                    if phase['first'] <= row['sourceDate'] <= last_day: days[row['sourceDate']].append(row)
        if shared.sha(path) != protocol['inputs'][index]['sha256']: raise ValueError('input_changed')
        by_day.update(days)
    rows, points, ids, counts = [], [], set(), collections.Counter()
    for d in sorted(by_day):
        for row in by_day[d]:
            validate(row)
            if row['id'] in ids: raise ValueError('duplicate_observation')
            ids.add(row['id'])
            pair = []
            for side in ['origin', 'destination']:
                point, how = station_point(row, side, by_id, by_name)
                if how != 'id': counts[f'nameCoordinate:{bare(row[side+"Name"])}' if point else 'missingCoordinate'] += 1
                pair.append(point)
            rows.append(row); points.append(pair if all(pair) else None)
    y = np.asarray([r['actualSeconds'] for r in rows], dtype=float); day = np.asarray([r['sourceDate'] for r in rows])
    ended = np.asarray([r['observedAt'] for r in rows]); known = np.asarray([p is not None for p in points])
    boundary = day_end
    evaluation = np.isin(day, phase['evaluation'])
    cal_all = (day > phase['trainThrough']) & (day <= phase['calibrationThrough']) & (ended < boundary(phase['calibrationThrough']))
    base = [base_features(p[0], p[1], r['startedAt'], holidays) if p else None for r, p in zip(rows, points)]
    distance = np.asarray([max(50.0, math.expm1(b[0])) if b else np.nan for b in base])
    train_known = training_mask(day, ended, known, phase)
    ratio = float(np.median(y[train_known]/distance[train_known]))
    spatial_log = np.log(np.where(known, distance*ratio, 1.0))
    residual = np.log(y) - spatial_log
    train_index = np.flatnonzero(train_known)
    # Out-of-day encodings for training rows; all training days for every later row.
    full = Encoder([rows[i] for i in train_index], list(np.log(y[train_index])), list(residual[train_index]))
    encoders = {d: Encoder([rows[i] for i in train_index if day[i] != d], [math.log(y[i]) for i in train_index if day[i] != d], [residual[i] for i in train_index if day[i] != d])
                for d in sorted(set(day[train_index]))}
    xs = []
    for i, b in enumerate(base):
        if b is None: xs.append(None); continue
        encoder = encoders[day[i]] if train_known[i] else full
        xs.append(quantize(b + encoder.encode(rows[i]['originName'], rows[i]['destinationName'], float(spatial_log[i]))))
    x = np.asarray([v if v is not None else [0.0]*len(FEATURES) for v in xs])
    train = train_known; cal = cal_all & known
    inner = train & (day <= phase['tuneThrough']) & (ended < boundary(phase['tuneThrough'])); tune = train & (day > phase['tuneThrough'])
    if min(inner.sum(), tune.sum(), train.sum()) < 1000 or min(cal.sum(), evaluation.sum()) < 200: raise ValueError('insufficient_rows')
    # Claim the evaluation day only now: nothing above scored an evaluation label, so a refusal or crash up to here leaves the day unused.
    # A rerun of the identical protocol (same inputs, same trainer) is accepted by the check above.
    if args.phase in ('final', 'refresh'):
        registry.update({day: protocol_sha for day in phase['evaluation']})
        tmp = registry_path.with_suffix('.tmp'); tmp.write_text(json.dumps(registry, indent=2)+'\n', encoding='utf-8'); tmp.replace(registry_path)

    def estimator(leaves, q):
        return HistGradientBoostingRegressor(loss='quantile', quantile=q, max_iter=200, learning_rate=.07, max_leaf_nodes=leaves, min_samples_leaf=60,
                                             l2_regularization=10, early_stopping=False, random_state=61016)
    with threadpool_limits(limits=4):
        trials = []
        # Inner selection re-encodes nothing: tune rows already carry out-of-day encodings, a slight advantage shared by every candidate.
        for leaves in protocol['candidateLeaves']:
            fitted = estimator(leaves, .5).fit(x[inner], y[inner])
            trials.append({'leaves': leaves, 'innerFutureMaeSeconds': float(np.mean(np.abs(fitted.predict(x[tune])-y[tune])))})
        selected = min(trials, key=lambda t: (t['innerFutureMaeSeconds'], t['leaves']))['leaves']
        print(json.dumps({'stage': 'selection', 'trials': trials, 'selected': selected}), flush=True)
        models = {label: estimator(selected, q).fit(x[train], y[train]) for label, q in [('lower', .05), ('median', .5), ('upper', .95)]}
    predictions = {name: model.predict(x) for name, model in models.items()}
    median = np.clip(predictions['median'], 1, 10800)
    base_lo = np.clip(np.minimum(predictions['lower'], median), 1, 10800); base_hi = np.clip(np.maximum(predictions['upper'], median), 1, 10800)
    upper_score = np.log(y+60) - np.log(base_hi); lower_score = np.log(base_lo) - np.log(np.maximum(1, y-60))
    group = np.asarray([group_of(r['startedAt'], holidays) for r in rows])
    level = lambda values, coverage: float(np.quantile(values, min(1, math.ceil((len(values)+1)*coverage)/len(values)), method='inverted_cdf'))
    conformal = {}
    for name in GROUPS:
        mask = cal & (group == name)
        if mask.sum() < 50: raise ValueError(f'calibration_rows_{name}')
        conformal[name] = {'upper': level(upper_score[mask], args.upper_coverage), 'lower': level(lower_score[mask], args.lower_coverage), 'rows': int(mask.sum())}
    lo = base_lo/np.exp([conformal[g]['lower'] for g in group]); hi = np.maximum(lo, base_hi*np.exp([conformal[g]['upper'] for g in group]))
    trees = {name: shared.portable(value) for name, value in models.items()}
    domain = {'minimum': x[train].min(axis=0).tolist(), 'maximum': x[train].max(axis=0).tolist()}
    artifact = {'version': VERSION, 'deployment': 'candidate', 'target': 'rail-gate-elapsed', 'trainedAt': int(time.time()*1000), 'trainingThrough': phase['trainThrough'],
        'featureNames': FEATURES, 'featureQuantizationDecimals': 6, 'models': trees, 'secondsPerMeter': ratio, 'priorRows': PRIOR_ROWS,
        'encodings': full.tables(), 'calendar': {'rule': 'korean-public-holiday-as-sunday', 'from': phase['first'], 'holidays': protocol['holidays']},
        'dayParts': [{'name': n, 'fromHour': a, 'toHour': b} for n, a, b in DAY_PARTS],
        'conformal': [{'group': g, 'logLower': conformal[g]['lower'], 'logUpper': conformal[g]['upper']} for g in GROUPS], 'labelUncertaintySeconds': 60, 'domain': domain,
        'limitations': ['gate-to-gate-not-app-plan', 'includes-in-station-dwell-and-leisure', 'coordinate-snapshot-historical-vintage-unverified', 'card-sample-1-in-64',
                        'holiday-designated-after-training-read-as-weekday']}
    checks = np.flatnonzero(train | cal)[::max(1, int((train | cal).sum()/128))][:128]
    parity = {name: float(np.max(np.abs(shared.portable_predict(trees[name], x[checks])-predictions[name][checks]))) for name in models}
    if max(parity.values()) > 1e-8: raise ValueError('portable_prediction_mismatch')
    write_new(output/'model.json', artifact)
    sample = np.flatnonzero(evaluation & known)[::max(1, int((evaluation & known).sum()/512))][:512]
    write_new(output/'parity.json', {'toleranceSeconds': 1e-8, 'cases': [{'input': {'originName': rows[i]['originName'], 'destinationName': rows[i]['destinationName'],
        'origin': list(points[i][0]), 'destination': list(points[i][1]), 'startedAt': rows[i]['startedAt']}, 'features': xs[i],
        'predictions': {n: float(v[i]) for n, v in predictions.items()}, 'lowerSeconds': float(lo[i]), 'upperSeconds': float(hi[i])} for i in sample]})
    # No fitting, selection or calibration happens after this point.
    supported = supported_rows(x, known, domain)
    baseline = np.where(known, distance*ratio, np.nan)
    design_raw = x[:, RIDGE_COLUMNS]
    ridge = ridge_predict(design_raw, baseline, *ridge_fit(design_raw, train, np.log(y[train]/baseline[train])))
    pair_median = {key: math.exp(statistics_median(values)) for key, values in full.pair.items()}
    seen = np.asarray([(r['originName'], r['destinationName']) in pair_median for r in rows])
    hybrid = np.asarray([pair_median.get((r['originName'], r['destinationName']), b) for r, b in zip(rows, baseline)])
    hours = np.asarray([dt.datetime.fromtimestamp(r['startedAt']/1000, KST).hour for r in rows])

    def evaluate(mask): return quality_evaluation(mask, y, supported, median, lo, hi, baseline, ridge, hybrid)
    m = evaluation
    checked = {name: evaluate(mask) for name, mask in quality_groups(m, seen, hours, day, phase['evaluation']).items()}
    checked['calibration'] = evaluate(cal_all)
    failures = [name for name, value in checked.items() if name != 'calibration' and not quality_passed(value)]
    split = lambda mask: {'rows': int(mask.sum()), 'dates': sorted(set(day[mask]))}
    report = {'version': VERSION, 'phase': args.phase, 'qualityPassed': not failures, 'qualityFailedGroups': failures,
        'counts': {'input': len(rows), 'coordinates': dict(counts)},
        'split': {'train': split(train), 'calibration': split(cal), 'innerTrain': split(inner), 'innerFuture': split(tune), 'evaluation': split(m)},
        'selection': {'trials': trials, 'selectedLeaves': selected, 'evaluationUsedForSelection': False},
        'calibration': {'logConformalByGroup': conformal, 'upperCoverage': args.upper_coverage, 'lowerCoverage': args.lower_coverage},
        'evaluations': checked, 'portableParity': parity,
        'reproducibility': {'protocolSha256': protocol_sha, 'modelSha256': shared.sha(output/'model.json'), 'python': sys.version.split()[0], 'numpy': np.__version__, 'sklearn': sklearn.__version__},
        'elapsedSeconds': round(time.monotonic()-begun, 3)}
    write_new(output/'report.json', report); print(json.dumps(report), flush=True)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        # 'refused': a protocol rule said no (ValueError with a short code). 'crash': anything else, named with its message
        # (KeyError: 'x') so it can be diagnosed; the caller retries a crash and treats a refusal as final.
        refused = isinstance(error, ValueError) and len(str(error)) < 100
        print(json.dumps({'error': 'rail_gate_training_refused', 'kind': 'refused' if refused else 'crash',
                          'reason': str(error) if refused else f'{type(error).__name__}: {error}'[:160]}), file=sys.stderr)
        sys.exit(1)
