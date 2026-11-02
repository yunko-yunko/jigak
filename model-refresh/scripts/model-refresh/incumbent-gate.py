#!/usr/bin/env python3
"""The promotion gate of train-spatial-bus-v3.py and train-rail-gate.py, applied to the model in service on a fresh day.

`reference` runs right after a promotion. It rebuilds the training split the trainer used and keeps what the gate needs later
but the checkpoint does not carry: the OD groups of the spatial bus training rows, the subway ridge baseline. The rebuilt rows
must reproduce the checkpoint's feature domain (and the subway seconds per metre) exactly, or no reference is written.

`gate` scores the served predictions of every row of the evaluation day (written by incumbent.ts with the server's own code)
with the trainers' quality_evaluation, quality_passed and quality_groups: every group (all, OD seen/unseen, each day part,
each day) must pass, as for a promotion.
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

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from private_files import open_private  # noqa: E402


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


spatial = load('spatial_bus_training', 'train-spatial-bus-v3.py')
rail = load('rail_gate_training', 'train-rail-gate.py')
shared = spatial.shared
REFERENCE_VERSION = 'jigak-incumbent-reference-v1'
# Rows left to the provider because the model has no encoding for a station: a few are a new or renamed station, more is a day the
# model no longer covers. Above max(10, 0.1% of the day) the group 'unseenStation' fails and nothing is extended.
UNSEEN_STATION_ROWS, UNSEEN_STATION_SHARE = 10, 0.001


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def rows_by_day(paths, first, last):
    """Same reading rule as the trainers: rows of [first, last] by sourceDate, a later file wins for the days it covers."""
    by_day = {}
    for path in paths:
        days = collections.defaultdict(list)
        with Path(path).open(encoding='utf-8') as stream:
            for line in stream:
                if not line.strip(): continue
                row = json.loads(line)
                if first <= row['sourceDate'] <= last: days[row['sourceDate']].append(row)
        by_day.update(days)
    return [row for day in sorted(by_day) for row in by_day[day]]


def write(path, value):
    with open_private(Path(path)) as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(',', ':')); stream.write('\n')


def same_domain(values, train, domain, columns):
    import numpy as np
    return np.asarray(values)[train].min(axis=0).tolist() == [domain['minimum'][i] for i in columns] \
        and np.asarray(values)[train].max(axis=0).tolist() == [domain['maximum'][i] for i in columns]


def spatial_reference(args, checkpoint):
    import numpy as np
    phase = spatial.refresh_window(args.window)
    holidays, _ = shared.holiday_calendars(None, spatial.HOLIDAY_FILE, phase['first'], phase['evaluation'][-1])
    rows, xs = [], []
    for row in rows_by_day(args.input, phase['first'], phase['evaluation'][-1]):
        x = spatial.validate(row, holidays)
        if x is not None: rows.append(row); xs.append(x)
    if not rows: raise ValueError('no_training_rows')
    day = np.asarray([r['sourceDate'] for r in rows]); ended = np.asarray([r['observedAt'] for r in rows])
    hold = np.asarray([spatial.held_out(r['vehicleGroup']) for r in rows])
    train = spatial.training_mask(day, ended, hold, phase)
    if not train.any() or not same_domain(xs, train, checkpoint['domain'], range(len(spatial.FEATURES))): raise ValueError('training_rows_do_not_match_checkpoint')
    return {'trainRows': int(train.sum()), 'trainOd': sorted({rows[i]['odGroup'] for i in np.flatnonzero(train)})}


def rail_rows(paths, stations, first, last, holidays):
    """Rows with the trainer's coordinates and quantized base features (zeros where a station has no coordinate)."""
    import numpy as np
    by_id, by_name = rail.load_stations(Path(stations))
    rows, base = [], []
    for row in rows_by_day(paths, first, last):
        rail.validate(row)
        points = [rail.station_point(row, side, by_id, by_name)[0] for side in ['origin', 'destination']]
        rows.append(row); base.append(rail.base_features(points[0], points[1], row['startedAt'], holidays) if all(points) else None)
    known = np.asarray([b is not None for b in base], dtype=bool)
    distance = np.asarray([max(50.0, math.expm1(b[0])) if b else np.nan for b in base])
    x = np.asarray([rail.quantize(b) if b else [0.0] * 12 for b in base]).reshape(len(rows), 12)
    return rows, known, distance, x


def rail_reference(args, checkpoint):
    import numpy as np
    phase = rail.refresh_window(args.window)
    holidays, _ = shared.holiday_calendars(None, rail.HOLIDAY_FILE, phase['first'], phase['evaluation'][-1])
    rows, known, distance, x = rail_rows(args.input, args.stations, phase['first'], phase['evaluation'][-1], holidays)
    y = np.asarray([r['actualSeconds'] for r in rows], dtype=float)
    day = np.asarray([r['sourceDate'] for r in rows]); ended = np.asarray([r['observedAt'] for r in rows])
    train = rail.training_mask(day, ended, known, phase)
    if not train.any(): raise ValueError('no_training_rows')
    ratio = float(np.median(y[train]/distance[train]))
    if ratio != checkpoint['secondsPerMeter'] or not same_domain(x, train, checkpoint['domain'], range(12)): raise ValueError('training_rows_do_not_match_checkpoint')
    baseline = distance*ratio
    center, scale, coefficient = rail.ridge_fit(x[:, rail.RIDGE_COLUMNS], train, np.log(y[train]/baseline[train]))
    return {'trainRows': int(train.sum()), 'ridge': {'columns': rail.RIDGE_COLUMNS, 'center': center.tolist(), 'scale': scale.tolist(), 'coefficient': coefficient.tolist()}}


def predictions(path):
    served = {}
    with Path(path).open(encoding='utf-8') as stream:
        for line in stream:
            if not line.strip(): continue
            item = json.loads(line)
            if item['id'] in served: raise ValueError('duplicate_prediction')
            served[item['id']] = item['incumbent']
    return served


def envelopes(rows, served, mean_key):
    import numpy as np
    missing = [r['id'] for r in rows if r['id'] not in served]
    if missing: raise ValueError('prediction_missing')
    pick = lambda key: np.asarray([served[r['id']][key] if served[r['id']] else np.nan for r in rows], dtype=float)
    return np.asarray([served[r['id']] is not None for r in rows], dtype=bool), pick(mean_key), pick('median'), pick('lower'), pick('upper')


def spatial_gate(args, reference, dates):
    import numpy as np
    holidays, _ = shared.holiday_calendars(None, spatial.HOLIDAY_FILE, dates[0], dates[-1])
    old_model = json.loads(Path(args.public_bus).read_text(encoding='utf-8')); old_model = old_model.get('model', old_model)
    if old_model.get('version') not in ('public-bus-duration-v2', 'public-bus-duration-v3'): raise ValueError('public_bus_reference_contract')
    old_holidays = holidays if old_model['version'] == 'public-bus-duration-v3' else None
    rows = [row for row in rows_by_day(args.input, dates[0], dates[-1]) if row['sourceDate'] in dates]
    excluded = sum(spatial.validate(row, holidays) is None for row in rows)
    rows = [row for row in rows if spatial.validate(row, holidays) is not None]
    supported, expected, median, lo, hi = envelopes(rows, predictions(args.predictions), 'mean')
    y = np.asarray([r['actualSeconds'] for r in rows], dtype=float)
    baseline = np.asarray([r['distanceMeters']*old_model['baselineSecondsPerMeter'] for r in rows], dtype=float)
    old = np.asarray([v if v is not None else np.nan for v in (spatial.old_prediction(r, old_model, old_holidays) for r in rows)], dtype=float)
    part = np.asarray([spatial.day_part(dt.datetime.fromtimestamp(r['startedAt']/1000, spatial.KST).hour) for r in rows])
    day = np.asarray([r['sourceDate'] for r in rows]); trained = set(reference['trainOd'])
    unseen = np.asarray([r['odGroup'] not in trained for r in rows], dtype=bool)
    groups = spatial.quality_groups(np.ones(len(rows), dtype=bool), unseen, part, day, dates)
    checked = {name: spatial.quality_evaluation(mask, y, supported, expected, median, lo, hi, baseline, old) for name, mask in groups.items()}
    return checked, [name for name, value in checked.items() if not spatial.quality_passed(value)], {'excluded': excluded, 'publicBusVersion': old_model['version']}


def rail_gate(args, reference, dates, checkpoint):
    import numpy as np
    holidays, _ = shared.holiday_calendars(None, rail.HOLIDAY_FILE, dates[0], dates[-1])
    rows, known, distance, x = rail_rows(args.input, args.stations, dates[0], dates[-1], holidays)
    keep = np.asarray([r['sourceDate'] in dates for r in rows], dtype=bool)
    rows = [r for r, k in zip(rows, keep) if k]; known, distance, x = known[keep], distance[keep], x[keep]
    served, median, _, lo, hi = envelopes(rows, predictions(args.predictions), 'median')
    # The server answers nothing for a station the model has no encoding for (the trainer would use the prior there). Such a row is
    # the provider's, not the model's: it is left out and counted, up to the limit above. Any other row the server leaves unanswered
    # counts as unsupported.
    in_domain = rail.supported_rows(x, known, checkpoint['domain'])
    origins = {o for o, *_ in checkpoint['encodings']['origins']}; destinations = {d for d, *_ in checkpoint['encodings']['destinations']}
    unseen_station = in_domain & ~served & np.asarray([r['originName'] not in origins or r['destinationName'] not in destinations for r in rows], dtype=bool)
    total, keep = len(rows), ~unseen_station
    rows = [r for r, k in zip(rows, keep) if k]; known, distance, x, served, median, lo, hi, in_domain = (v[keep] for v in (known, distance, x, served, median, lo, hi, in_domain))
    supported = in_domain & served
    y = np.asarray([r['actualSeconds'] for r in rows], dtype=float)
    baseline = np.where(known, distance*checkpoint['secondsPerMeter'], np.nan)
    ridge = reference['ridge']
    ridge = rail.ridge_predict(x[:, rail.RIDGE_COLUMNS], baseline, np.asarray(ridge['center']), np.asarray(ridge['scale']), np.asarray(ridge['coefficient']))
    pair_median = {(o, d): math.exp(value) for o, d, value, _ in checkpoint['encodings']['pairs']}
    seen = np.asarray([(r['originName'], r['destinationName']) in pair_median for r in rows], dtype=bool)
    hybrid = np.asarray([pair_median.get((r['originName'], r['destinationName']), b) for r, b in zip(rows, baseline)], dtype=float)
    hours = np.asarray([dt.datetime.fromtimestamp(r['startedAt']/1000, rail.KST).hour for r in rows])
    day = np.asarray([r['sourceDate'] for r in rows])
    groups = rail.quality_groups(np.ones(len(rows), dtype=bool), seen, hours, day, dates)
    checked = {name: rail.quality_evaluation(mask, y, supported, median, lo, hi, baseline, ridge, hybrid) for name, mask in groups.items()}
    failed = [name for name, value in checked.items() if not rail.quality_passed(value)]
    limit = max(UNSEEN_STATION_ROWS, math.floor(total*UNSEEN_STATION_SHARE))
    if unseen_station.sum() > limit: failed.append('unseenStation')
    return checked, failed, {'unlocated': int((~known).sum()), 'unseenStation': int(unseen_station.sum()), 'unseenStationLimit': limit}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['reference', 'gate'])
    parser.add_argument('--model', choices=['spatialBus', 'railGate'], required=True)
    parser.add_argument('--checkpoint', required=True, help='The model file exactly as served (its sha256 ties the reference to it).')
    parser.add_argument('--input', action='append', required=True, help='Context JSONL (bus) or rail gate JSONL; repeat as the trainer did.')
    parser.add_argument('--stations', help='railGate: the station coordinates the trainer used.')
    parser.add_argument('--window', help='reference: the trainer --window of that promotion.')
    parser.add_argument('--reference', help='gate: the file `reference` wrote for this checkpoint.')
    parser.add_argument('--predictions', help='gate: JSONL {"id", "incumbent": {mean?, median, lower, upper} | null}, one per row of the day.')
    parser.add_argument('--evaluation-date', action='append', help='gate: the fresh evaluation day (repeat for several).')
    parser.add_argument('--public-bus', help='gate, spatialBus: the old public bus model the trainer would compare with (a report with "model", or the model).')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.model == 'railGate' and not args.stations: raise ValueError('stations_required')
    checkpoint_sha = sha(args.checkpoint); checkpoint = json.loads(Path(args.checkpoint).read_text(encoding='utf-8'))
    if args.command == 'reference':
        if not args.window: raise ValueError('window_required')
        body = spatial_reference(args, checkpoint) if args.model == 'spatialBus' else rail_reference(args, checkpoint)
        write(args.output, {'version': REFERENCE_VERSION, 'model': args.model, 'checkpointSha256': checkpoint_sha, 'window': args.window,
                            'inputs': [{'file': Path(p).name, 'sha256': sha(p)} for p in args.input], **body})
        print(json.dumps({'status': 'written', 'model': args.model, 'trainRows': body['trainRows']}))
        return
    if not (args.reference and args.predictions and args.evaluation_date) or args.model == 'spatialBus' and not args.public_bus: raise ValueError('gate_arguments')
    reference = json.loads(Path(args.reference).read_text(encoding='utf-8'))
    if reference.get('version') != REFERENCE_VERSION or reference.get('model') != args.model or reference.get('checkpointSha256') != checkpoint_sha: raise ValueError('reference_not_for_this_checkpoint')
    dates = sorted(set(args.evaluation_date))
    checked, failed, extra = spatial_gate(args, reference, dates) if args.model == 'spatialBus' else rail_gate(args, reference, dates, checkpoint)
    result = {'passed': not failed, 'failedGroups': failed, 'rows': (checked.get('all') or {}).get('rows', 0), 'evaluationDates': dates, **extra, 'evaluations': checked}
    write(args.output, result)
    print(json.dumps({'passed': result['passed'], 'failedGroups': failed, 'rows': result['rows']}))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        refused = isinstance(error, ValueError) and len(str(error)) < 100
        print(json.dumps({'error': 'incumbent_gate_refused', 'kind': 'refused' if refused else 'crash',
                          'reason': str(error) if refused else f'{type(error).__name__}: {error}'[:160]}), file=sys.stderr)
        sys.exit(1)
