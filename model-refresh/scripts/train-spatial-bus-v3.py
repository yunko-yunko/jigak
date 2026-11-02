#!/usr/bin/env python3
"""Train the spatial/stop-count bus candidate v3 on this machine.

Changes from v2, all fixed before the final service day is read:
- reviewed public and substitute holidays are read as Sunday (same rule as
  public-bus-duration-v3), so 10/05 and 10/09 no longer teach "light weekdays";
- interval calibration is per day-part and multiplicative (log space), so busy
  mornings get their own width instead of sharing the citywide adjustment.

`--phase development` uses days the spatial family has already inspected
(10/11, 10/12). `--phase final` evaluates 10/16 once; a second, different
protocol on that day is refused. `--phase refresh --window` is the weekly
retrain with the same split shape on a new 14-day window (calibration = the
five days before the single evaluation day), compared with the public bus
model trained on the same window.
"""
from __future__ import annotations
import argparse
import collections
import datetime as dt
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from private_files import open_private, restrict_private_path
spec = importlib.util.spec_from_file_location('spatial_bicycle_training', Path(__file__).with_name('train-spatial-bicycle.py'))
shared = importlib.util.module_from_spec(spec); spec.loader.exec_module(shared)
VERSION = 'seoul-bus-spatial-v3'
KST = dt.timezone(dt.timedelta(hours=9))
FEATURES = ['logRouteDistanceMeters', 'logStopCount', 'logMetersPerStop', 'originLatitude', 'originLongitude',
            'destinationLatitude', 'destinationLongitude', 'logEndpointMeters', 'logCircuity', 'northKilometers',
            'eastKilometers', 'seoulHourSin', 'seoulHourCos', 'seoulWeekdaySin', 'seoulWeekdayCos', 'weekend']
DAY_PARTS = [('overnight', 0, 6), ('morning', 6, 10), ('daytime', 10, 17), ('evening', 17, 21), ('night', 21, 24)]
# Calibration spans five service days so both weekday and weekend/holiday rides are calibrated on later days.
PHASES = {
    'development': {'first': '2026-09-28', 'tuneThrough': '2026-10-02', 'trainThrough': '2026-10-05', 'calibrationThrough': '2026-10-10',
                    'evaluation': ['2026-10-11', '2026-10-12'], 'referenceTrainThrough': '2026-10-08'},
    'final': {'first': '2026-09-28', 'tuneThrough': '2026-10-07', 'trainThrough': '2026-10-10', 'calibrationThrough': '2026-10-15',
              'evaluation': ['2026-10-16'], 'referenceTrainThrough': '2026-10-13'},
}
HOLIDAY_FILE = Path(__file__).resolve().parents[2] / 'src' / 'common' / 'engine' / 'realtime' / 'data' / 'korea-holidays-2026.json'
REGISTRY = 'spatial-bus-evaluations.json'


def refresh_window(value):
    """FIRST:TUNE:TRAIN:CALIBRATION:EVALUATION with the development/final split shape."""
    days = [dt.date.fromisoformat(v) for v in value.split(':')]
    if len(days) != 5: raise ValueError('window_format')
    first, tune, train, calibration, evaluation = days
    if not (first < tune < train < calibration < evaluation) or (calibration - train).days not in (5, 6) or (evaluation - calibration).days != 1 \
            or (train - tune).days != 3 or not 13 <= (evaluation - first).days <= 18: raise ValueError('window_shape')
    # Both day types need later-day calibration rows (weekday:* and weekend:* groups).
    calibration_days = [train + dt.timedelta(days=i) for i in range(1, (calibration - train).days + 1)]
    if all(d.weekday() >= 5 for d in calibration_days) or all(d.weekday() < 5 for d in calibration_days): raise ValueError('calibration_needs_weekday_and_weekend')
    iso = lambda d: d.isoformat()
    return {'first': iso(first), 'tuneThrough': iso(tune), 'trainThrough': iso(train), 'calibrationThrough': iso(calibration),
            'evaluation': [iso(evaluation)], 'referenceTrainThrough': None}


def write_new(path, value):
    with open_private(path) as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        stream.write('\n'); stream.flush()


def day_part(hour):
    return next(name for name, start, end in DAY_PARTS if start <= hour < end)


def calibration_group(started_at, holidays):
    local = dt.datetime.fromtimestamp(started_at/1000, KST)
    weekend = local.weekday() >= 5 or local.date().isoformat() in holidays
    return f"{'weekend' if weekend else 'weekday'}:{day_part(local.hour)}"


GROUPS = [f'{kind}:{name}' for kind in ['weekday', 'weekend'] for name, _, _ in DAY_PARTS]


def public_input(row):
    return {'startedAt': row['startedAt'], 'distanceMeters': row['distanceMeters'], 'stopCount': row['toOrder'] - row['fromOrder'],
            'originLatitude': row['fromLatitude'], 'originLongitude': row['fromLongitude'],
            'destinationLatitude': row['toLatitude'], 'destinationLongitude': row['toLongitude']}


def features(value, holidays):
    distance, stops = value['distanceMeters'], value['stopCount']
    a, b, c, d = [value[key] for key in ['originLatitude', 'originLongitude', 'destinationLatitude', 'destinationLongitude']]
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in [distance, stops, a, b, c, d, value['startedAt']]): raise ValueError('finite_inputs_required')
    if not 100 <= distance <= 50000 or not 1 <= stops <= 500 or int(stops) != stops: raise ValueError('distance_or_stop_count')
    if not all(37.4 <= v <= 37.72 for v in [a, c]) or not all(126.73 <= v <= 127.28 for v in [b, d]): return None
    rad = math.pi / 180
    hav = min(1, max(0, math.sin((c-a)*rad/2)**2 + math.cos(a*rad)*math.cos(c*rad)*math.sin((d-b)*rad/2)**2))
    endpoint = 6371000 * 2 * math.atan2(math.sqrt(hav), math.sqrt(1-hav))
    if endpoint > distance * 1.25 + 100: return None
    local = dt.datetime.fromtimestamp(value['startedAt']/1000, KST)
    hour = (local.hour + local.minute/60 + local.second/3600) / 24 * 2 * math.pi
    # Sunday = 0 as in JavaScript getUTCDay(); a reviewed holiday is read as Sunday.
    weekday_index = 0 if local.date().isoformat() in holidays else (local.weekday()+1) % 7
    weekday = weekday_index / 7 * 2 * math.pi
    raw = [math.log(distance), math.log(stops), math.log(distance/stops), a, b, c, d, math.log(max(10, endpoint)),
           math.log(distance/max(10, endpoint)), (c-a)*111.1950802335329, (d-b)*111.1950802335329*math.cos((a+c)/2*rad),
           math.sin(hour), math.cos(hour), math.sin(weekday), math.cos(weekday), float(weekday_index in (0, 6))]
    # Identical to ECMAScript Math.round so libm/V8 ulp differences cannot create spurious splits.
    return [math.floor(value*1e10+.5)/1e10 for value in raw]


def held_out(value):
    return int.from_bytes(hashlib.sha256(('bus-vehicle-holdout-v1|'+value).encode()).digest()[:4], 'big') % 10 == 0


def validate(row, holidays):
    if (row.get('version'), row.get('source'), row.get('target'), row.get('uncertaintySeconds')) != (2, 'seoul-tdata-card', 'bus-tag-elapsed', 60): raise ValueError('source_contract')
    for name in ['id', 'groupId', 'vehicleGroup', 'odGroup', 'sourceArchiveSha256']:
        if not isinstance(row.get(name), str) or not 1 <= len(row[name]) <= 128: raise ValueError('missing_identity')
    start, end, actual = row['startedAt'], row['observedAt'], row['actualSeconds']
    boundary = int(dt.datetime.combine(dt.date.fromisoformat(row['sourceDate']), dt.time(4), KST).timestamp()*1000)
    if not 180 <= actual <= 10800 or actual % 60 or start % 60000 or end % 60000 or end-start != actual*1000 or not boundary <= start < boundary+86400000: raise ValueError('tag_or_service_day_contract')
    return features(public_input(row), holidays)


def old_features(row, holidays=None):
    local = dt.datetime.fromtimestamp(row['startedAt']/1000, KST)
    # public-bus-duration-v3 reads holidays as Sunday; v2 (holidays=None) keeps calendar weekdays.
    day = 0 if holidays and local.date().isoformat() in holidays else (local.weekday()+1)%7
    hour = (local.hour+local.minute/60+local.second/3600)/24*2*math.pi; weekday = day/7*2*math.pi
    w, p = row.get('weather'), row.get('roadPrior')
    get = lambda key: w.get(key) if w else None
    return [math.log(row['distanceMeters']), math.sin(hour), math.cos(hour), math.sin(weekday), math.cos(weekday),
            get('temperatureC') or 0, float(get('temperatureC') is None), get('windMetersPerSecond') or 0,
            float(get('windMetersPerSecond') is None), math.log1p(get('precipitationMm') or 0), float(get('precipitationMm') is None),
            float(bool(get('precipitationTrace'))), (get('ageSeconds') or 0)/3600, float(w is None), math.log(p['speedKmh']) if p else 0, float(p is None)]


def old_prediction(row, model, holidays=None):
    raw = old_features(row, holidays); values = []
    for i, value in enumerate(raw):
        center, scale = model['normalization']['centers'][i], model['normalization']['scales'][i]
        low, high = model['domain']['minimum'][i], model['domain']['maximum'][i]
        tolerance = 0 if i in [6, 8, 10, 11, 13, 15] else max(.05, (high-low)*.15, scale*.25)
        if value < low-tolerance or value > high+tolerance or abs((value-center)/scale) > 6: return None
        values.append(max(-4, min(4, (value-center)/scale)))
    prediction = math.exp(model['coefficients'][0]+sum(v*c for v,c in zip(values, model['coefficients'][1:])))
    return prediction if 1 <= prediction <= 10800 else None


def day_end(day):
    """04:00 KST after the service day: a ride ending later belongs to the next day."""
    return int(dt.datetime.combine(dt.date.fromisoformat(day)+dt.timedelta(days=1), dt.time(4), KST).timestamp()*1000)


def training_mask(day, ended, hold, phase):
    return (day <= phase['trainThrough']) & (ended < day_end(phase['trainThrough'])) & ~hold


# The quality gate below is also what model-refresh/incumbent-gate.py applies to the model in service on a fresh day.
def quality_evaluation(mask, y, supported, expected, median, lo, hi, baseline, old):
    import numpy as np
    n = int(mask.sum()); accepted = mask & supported; common = accepted & np.isfinite(old); k = int(accepted.sum())
    if not n: return None
    return {'rows': n, 'supported': k, 'unsupported': n-k, 'distanceMaeSeconds': float(np.mean(np.abs(baseline[mask]-y[mask]))),
        'meanMaeSeconds': float(np.mean(np.abs(expected[accepted]-y[accepted]))) if k == n else None,
        'medianMaeSeconds': float(np.mean(np.abs(median[accepted]-y[accepted]))) if k else None,
        'meanSignedErrorSeconds': float(np.mean(expected[accepted]-y[accepted])) if k else None,
        'commonSupported': int(common.sum()),
        'oldModelCommonMaeSeconds': float(np.mean(np.abs(old[common]-y[common]))) if common.any() else None,
        'candidateMeanCommonMaeSeconds': float(np.mean(np.abs(expected[common]-y[common]))) if common.any() else None,
        'robustIntervalCoverage': float(np.sum(accepted & (lo <= y-60) & (hi >= y+60))/n),
        'robustUpperCoverage': float(np.sum(accepted & (hi >= y+60))/n),
        'meanRelativeWidth': float(np.mean((hi[accepted]-lo[accepted])/y[accepted])) if k else None}


def quality_passed(e):
    return bool(e and e['rows'] >= 100 and e['unsupported'] == 0 and e['meanMaeSeconds'] < e['distanceMaeSeconds']
        and e['commonSupported'] >= 100 and e['candidateMeanCommonMaeSeconds'] < e['oldModelCommonMaeSeconds']
        and e['robustIntervalCoverage'] >= .8 and e['robustUpperCoverage'] >= .9 and e['meanRelativeWidth'] <= 1.5)


def quality_groups(m, unseen, part, day, evaluation_days):
    groups = {'all': m, 'newOd': m & unseen, 'seenOd': m & ~unseen}
    groups.update({f'dayPart:{n}': m & (part == n) for n, _, _ in DAY_PARTS})
    groups.update({f'day:{d}': m & (day == d) for d in evaluation_days})
    return groups


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=sorted(PHASES) + ['refresh'], required=True)
    parser.add_argument('--window', help='refresh only: FIRST:TUNE_THROUGH:TRAIN_THROUGH:CALIBRATION_THROUGH:EVALUATION_DAY')
    parser.add_argument('--input', action='append', required=True, help='Context JSONL; repeat. Later files win for the dates they cover.')
    parser.add_argument('--reference-report', required=True, help='Public bus training report: same trainThrough (development/final) or same test day (refresh).')
    parser.add_argument('--fallback-reference', help='refresh only: public bus model JSON (the served one) used as the old-model comparison when the same-window public bus report was refused and so carries no model.')
    parser.add_argument('--output-directory', required=True)
    parser.add_argument('--upper-coverage', type=float, default=.93, help='One-sided: share of rides at or under the upper bound.')
    parser.add_argument('--lower-coverage', type=float, default=.9, help='One-sided: share of rides at or over the lower bound.')
    parser.add_argument('--holidays', nargs='+', help='Reviewed korea-holidays-YYYY.json for every year in the window (default: JIGAK_HOLIDAY_DIR, else the 2026 file).')
    parser.add_argument('--execute', action='store_true'); args = parser.parse_args()
    if (args.phase == 'refresh') != bool(args.window): raise ValueError('window_only_for_refresh')
    phase = PHASES.get(args.phase) or refresh_window(args.window)
    inputs = [shared.data_path(v) for v in args.input]; reference_path = shared.data_path(args.reference_report)
    output = shared.data_path(args.output_directory)
    if output.exists() or len(set(inputs)) != len(inputs) or any(not p.is_file() or p.stat().st_size > 384*1024**2 for p in inputs + [reference_path]): raise ValueError('paths_or_size')
    if not .9 <= args.upper_coverage < 1 or not .8 <= args.lower_coverage < 1 or args.upper_coverage + args.lower_coverage < 1.8: raise ValueError('coverage')
    last_day = phase['evaluation'][-1]
    holidays, holiday_sha = shared.holiday_calendars(args.holidays, HOLIDAY_FILE, phase['first'], last_day)
    reference_report = json.loads(reference_path.read_text(encoding='utf-8'))
    # A refused public bus report (quality gate) has no 'model'. The spatial gate still needs an old model to beat:
    # the public bus model in service. Without it the run is refused by name instead of failing on a missing key.
    fallback_path = shared.data_path(args.fallback_reference) if args.fallback_reference else None
    if 'model' in reference_report: reference_source = 'same-window-public-bus-report'
    elif args.phase == 'refresh' and fallback_path is not None and fallback_path.is_file() and fallback_path.stat().st_size <= 1024**2: reference_source = 'served-public-bus-model'
    else: raise ValueError('reference_report_has_no_model')
    protocol = {'version': VERSION, 'phase': args.phase, 'deployment': 'candidate', 'target': 'bus-tag-elapsed', **phase,
        'featureNames': FEATURES, 'dayRule': 'korean-public-holiday-as-sunday',
        'holidays': sorted(h for h in holidays if phase['first'] <= h <= last_day), 'holidayFileSha256': holiday_sha,
        'featureQuantization': 'nearest-1e-10-ties-to-positive', 'weatherUsed': False,
        'selectionMetric': 'inner future mean prediction RMSE', 'candidateLeaves': [15, 31, 63], 'maxIterations': 220, 'learningRate': .07,
        'minimumLeafRows': 60, 'l2Regularization': 10, 'earlyStopping': False, 'seed': 61016, 'threads': 4,
        'estimators': {'mean': 'squared_error', 'lower': .05, 'median': .5, 'upper': .95},
        'calibration': {'method': 'one-sided-cqr-by-day-type-and-part-log-ratio', 'upperCoverage': args.upper_coverage, 'lowerCoverage': args.lower_coverage,
                        'groups': GROUPS, 'labelUncertaintySeconds': 60},
        'qualityGate': {'minimumRows': 100, 'maximumUnsupported': 0, 'meanMaeImprovesDistanceAndOldModelCommonSupport': True,
                        'robustIntervalCoverage': .8, 'robustUpperCoverage': .9, 'maximumMeanRelativeWidth': 1.5,
                        'groups': 'all, newOd, seenOd, every day-part and every evaluation day'},
        'inputs': [{'file': p.name, 'sha256': shared.sha(p)} for p in inputs],
        'reference': {'file': reference_path.name, 'sha256': shared.sha(reference_path)}, 'trainerSha256': shared.sha(Path(__file__))}
    if reference_source == 'served-public-bus-model': protocol['referenceSource'] = {'kind': reference_source, 'file': fallback_path.name, 'sha256': shared.sha(fallback_path)}
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
    by_day = {}
    for index, path in enumerate(inputs):
        days = collections.defaultdict(list)
        with path.open(encoding='utf-8') as stream:
            for line in stream:
                if not line.strip(): continue
                if len(line) > 100000: raise ValueError('row_bound')
                row = json.loads(line)
                if phase['first'] <= row['sourceDate'] <= last_day: days[row['sourceDate']].append(row)
        if shared.sha(path) != protocol['inputs'][index]['sha256']: raise ValueError('input_changed')
        by_day.update(days)  # different preparation sessions are never mixed within one day
    rows, xs, ids, groups, exclusions = [], [], set(), set(), collections.Counter()
    for day_rows in (by_day[d] for d in sorted(by_day)):
        for row in day_rows:
            x = validate(row, holidays)
            if row['id'] in ids or row['groupId'] in groups: raise ValueError('duplicate_observation_or_run')
            ids.add(row['id']); groups.add(row['groupId'])
            if x is None: exclusions['outside_scope_or_inconsistent_geometry'] += 1; continue
            rows.append(row); xs.append(x)
    reference = reference_report['model'] if reference_source == 'same-window-public-bus-report' else json.loads(fallback_path.read_text(encoding='utf-8'))
    if args.phase == 'refresh':
        if reference['version'] not in ('public-bus-duration-v2', 'public-bus-duration-v3') or reference_source == 'same-window-public-bus-report' and reference['validation']['testDates'] != phase['evaluation']: raise ValueError('reference_contract')
    elif reference['version'] != 'public-bus-duration-v2' or reference['validation']['trainThrough'] != phase['referenceTrainThrough']: raise ValueError('reference_contract')
    reference_holidays = holidays if reference['version'] == 'public-bus-duration-v3' else None
    x = np.asarray(xs); y = np.asarray([r['actualSeconds'] for r in rows], dtype=float); day = np.asarray([r['sourceDate'] for r in rows])
    hold = np.asarray([held_out(r['vehicleGroup']) for r in rows]); ended = np.asarray([r['observedAt'] for r in rows])
    hours = np.asarray([dt.datetime.fromtimestamp(r['startedAt']/1000, KST).hour for r in rows]); part = np.asarray([day_part(h) for h in hours])
    group = np.asarray([calibration_group(r['startedAt'], holidays) for r in rows])
    boundary = day_end
    evaluation_mask = np.isin(day, phase['evaluation'])
    train = training_mask(day, ended, hold, phase)
    calibration = (day > phase['trainThrough']) & (day <= phase['calibrationThrough']) & (ended < boundary(phase['calibrationThrough'])) & ~hold
    inner = train & (day <= phase['tuneThrough']) & (ended < boundary(phase['tuneThrough'])); tune = train & (day > phase['tuneThrough'])
    if min(train.sum(), inner.sum(), tune.sum()) < 1000 or min(calibration.sum(), evaluation_mask.sum()) < 200: raise ValueError('insufficient_rows')
    # Claim the evaluation day only now: everything above is checked without any evaluation label being scored, so a refusal or
    # crash up to here leaves the day unused. A rerun of the identical protocol (same inputs, same trainer) is accepted later.
    if args.phase in ('final', 'refresh'):
        registry.update({day: protocol_sha for day in phase['evaluation']})
        tmp = registry_path.with_suffix('.tmp'); tmp.write_text(json.dumps(registry, indent=2)+'\n', encoding='utf-8'); tmp.replace(registry_path)

    def estimator(leaves, q=None):
        return HistGradientBoostingRegressor(loss='squared_error' if q is None else 'quantile', quantile=q, max_iter=220,
            learning_rate=.07, max_leaf_nodes=leaves, min_samples_leaf=60, l2_regularization=10, early_stopping=False, random_state=61016)
    with threadpool_limits(limits=4):
        trials = []
        for leaves in protocol['candidateLeaves']:
            fitted = estimator(leaves).fit(x[inner], y[inner]); error = fitted.predict(x[tune]) - y[tune]
            trials.append({'leaves': leaves, 'innerFutureRmseSeconds': float(np.sqrt(np.mean(error**2)))})
        selected = min(trials, key=lambda t: (t['innerFutureRmseSeconds'], t['leaves']))['leaves']
        print(json.dumps({'stage': 'selection', 'trials': trials, 'selected': selected}), flush=True)
        models = {label: estimator(selected, q).fit(x[train], y[train]) for label, q in [('mean', None), ('lower', .05), ('median', .5), ('upper', .95)]}
    predictions = {name: model.predict(x) for name, model in models.items()}
    median = np.clip(predictions['median'], 1, 10800)
    base_lo = np.clip(np.minimum(predictions['lower'], median), 1, 10800); base_hi = np.clip(np.maximum(predictions['upper'], median), 1, 10800)
    # Conformalized quantile regression per side: an adjustment may also shrink a too-wide band.
    upper_score = np.log(y+60) - np.log(base_hi); lower_score = np.log(base_lo) - np.log(np.maximum(1, y-60))
    level = lambda values, coverage: float(np.quantile(values, min(1, math.ceil((len(values)+1)*coverage)/len(values)), method='inverted_cdf'))
    conformal = {}
    for name in GROUPS:
        mask = calibration & (group == name)
        if mask.sum() < 50: raise ValueError(f'calibration_rows_{name}')
        conformal[name] = {'upper': level(upper_score[mask], args.upper_coverage), 'lower': level(lower_score[mask], args.lower_coverage), 'rows': int(mask.sum())}
    lo = base_lo / np.exp([conformal[g]['lower'] for g in group]); hi = np.maximum(lo, base_hi * np.exp([conformal[g]['upper'] for g in group]))
    trees = {name: shared.portable(value) for name, value in models.items()}
    domain = {'minimum': x[train].min(axis=0).tolist(), 'maximum': x[train].max(axis=0).tolist()}
    covered_dates = sorted({d for d in by_day} | set(phase['evaluation']))
    artifact = {'version': VERSION, 'deployment': 'candidate', 'target': 'bus-tag-elapsed', 'trainedAt': int(time.time()*1000),
        'trainingThrough': phase['trainThrough'], 'featureNames': FEATURES, 'models': trees, 'featureQuantization': protocol['featureQuantization'],
        'calendar': {'rule': 'korean-public-holiday-as-sunday', 'from': covered_dates[0], 'holidays': protocol['holidays']},
        'dayParts': [{'name': n, 'fromHour': a, 'toHour': b} for n, a, b in DAY_PARTS],
        'conformal': [{'group': g, 'logLower': conformal[g]['lower'], 'logUpper': conformal[g]['upper']} for g in GROUPS],
        'labelUncertaintySeconds': 60, 'domain': domain, 'inputSha256': [v['sha256'] for v in protocol['inputs']],
        'meanInterpretation': 'conditional tag-elapsed mean, not validated route ETA',
        'limitations': ['tag-boundaries-not-matched-to-provider-ride', 'distance-and-stop-sequence-not-matched-to-provider', 'no-contemporaneous-provider-baseline',
                        'observational-not-route-ranking-or-optimality', 'holiday-designated-after-training-read-as-weekday']}
    parity_indices = np.flatnonzero(train | calibration)[::max(1, int((train | calibration).sum()/128))][:128]
    parity = {name: float(np.max(np.abs(shared.portable_predict(trees[name], x[parity_indices]) - predictions[name][parity_indices]))) for name in models}
    if max(parity.values()) > 1e-8: raise ValueError('portable_prediction_mismatch')
    write_new(output/'model.json', artifact)
    sample = np.flatnonzero(evaluation_mask)[::max(1, int(evaluation_mask.sum()/512))][:512]
    write_new(output/'parity.json', {'toleranceSeconds': 1e-8, 'cases': [{'input': public_input(rows[i]), 'features': xs[i],
        'predictions': {name: float(values[i]) for name, values in predictions.items()}, 'lowerSeconds': float(lo[i]), 'upperSeconds': float(hi[i])} for i in sample]})
    # No fitting, selection or calibration happens after this point.
    baseline = np.asarray([r['distanceMeters']*reference['baselineSecondsPerMeter'] for r in rows])
    old = np.asarray([v if v is not None else np.nan for v in (old_prediction(r, reference, reference_holidays) for r in rows)])
    expected = np.clip(predictions['mean'], 1, 10800)
    supported = np.ones(len(rows), dtype=bool)
    for i in [0, 1, 3, 4, 5, 6]:
        tolerance = max(.05, (domain['maximum'][i]-domain['minimum'][i])*.15) if i in [0, 1] else .015
        supported &= (x[:, i] >= domain['minimum'][i]-tolerance) & (x[:, i] <= domain['maximum'][i]+tolerance)

    def evaluation(mask):
        return quality_evaluation(mask, y, supported, expected, median, lo, hi, baseline, old)
    train_od = {rows[i]['odGroup'] for i in np.flatnonzero(train)}; unseen = np.asarray([r['odGroup'] not in train_od for r in rows])
    m = evaluation_mask
    checked = {name: evaluation(mask) for name, mask in quality_groups(m, unseen, part, day, phase['evaluation']).items()}
    checked['calibration'] = evaluation(calibration)
    failures = [name for name, value in checked.items() if name != 'calibration' and not quality_passed(value)]
    split = lambda mask: {'rows': int(mask.sum()), 'dates': sorted(set(day[mask])), 'physicalRuns': len({rows[i]['groupId'] for i in np.flatnonzero(mask)})}
    report = {'version': VERSION, 'phase': args.phase, 'qualityPassed': not failures, 'qualityFailedGroups': failures,
        'counts': {'input': len(ids), 'eligible': len(rows), 'excluded': dict(exclusions)},
        'split': {'train': split(train), 'calibration': split(calibration), 'innerTrain': split(inner), 'innerFuture': split(tune), 'evaluation': split(m)},
        'selection': {'trials': trials, 'selectedLeaves': selected, 'testUsedForSelection': False},
        'calibration': {'logConformalByDayPart': conformal, 'upperCoverage': args.upper_coverage, 'lowerCoverage': args.lower_coverage},
        'evaluations': checked, 'portableParity': parity,
        'reproducibility': {'protocolSha256': protocol_sha, 'modelSha256': shared.sha(output/'model.json'), 'python': sys.version.split()[0],
                            'numpy': np.__version__, 'sklearn': sklearn.__version__},
        'elapsedSeconds': round(time.monotonic()-begun, 3)}
    write_new(output/'report.json', report); print(json.dumps(report), flush=True)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        # 'refused': a rule of the protocol said no (ValueError with a short code). 'crash': anything else, named with its message
        # (KeyError: 'model') so the next failure can be diagnosed; the caller treats a crash as retryable, a refusal as final.
        refused = isinstance(error, ValueError) and len(str(error)) < 100
        print(json.dumps({'error': 'spatial_bus_v3_training_refused', 'kind': 'refused' if refused else 'crash',
                          'reason': str(error) if refused else f'{type(error).__name__}: {error}'[:160]}), file=sys.stderr)
        sys.exit(1)
