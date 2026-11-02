#!/usr/bin/env python3
"""Train a portable spatial bicycle ETA candidate on actual Seoul rentals.

The experiment is frozen before loading labels. Model selection uses only the
training period; calibration and final future dates never choose parameters.
Run from mvp; inputs, grouping keys and all artifacts stay in ignored data/.
Rental-to-return labels include stops. This research model cannot be promoted
to a pure riding-time or whole-trip production model by this command.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from private_files import open_private

# An explicitly local dependency installation avoids modifying system Python (data/ of the working directory, as data_path below).
RUNTIME = Path.cwd() / 'data' / 'training-runtime'
if RUNTIME.is_dir(): sys.path.insert(0, str(RUNTIME))

FEATURES = ['logEndpointMeters', 'originLatitude', 'originLongitude', 'destinationLatitude', 'destinationLongitude',
            'northMeters', 'eastMeters', 'bearingSin', 'bearingCos', 'seoulHourSin', 'seoulHourCos',
            'seoulWeekdaySin', 'seoulWeekdayCos', 'weekend']
KST = dt.timezone(dt.timedelta(hours=9))
VERSION = 'seoul-bicycle-spatial-v1'
TOKEN = re.compile(r'^[a-f0-9]{64}$')

def data_path(value):
    # The automatic refresh points JIGAK_DATA_ROOT at its model store (local folder or the bucket mount).
    root = Path(os.environ.get('JIGAK_DATA_ROOT') or Path.cwd() / 'data').resolve(); path = Path(value).resolve()
    if path == root or not path.is_relative_to(root): raise ValueError('outside_data')
    return path


def evaluation_registry(name):
    """Evaluation-day journal: JIGAK_EVALUATION_JOURNAL_DIR when the refresh sets it, else data/<name>."""
    directory = os.environ.get('JIGAK_EVALUATION_JOURNAL_DIR')
    if not directory: return data_path(f'data/{name}')
    root = Path(directory).resolve(); root.mkdir(parents=True, exist_ok=True)
    return root / name


def holiday_calendars(paths, default_file, first, last_day):
    """Reviewed korea-holidays-YYYY.json files for every year from first through last_day. Explicit --holidays files win,
    then JIGAK_HOLIDAY_DIR, then the single repository file. Returns (holidays, sha of the one file or of the sorted file shas)."""
    directory = os.environ.get('JIGAK_HOLIDAY_DIR')
    files = [Path(p) for p in paths] if paths else sorted(Path(directory).glob('korea-holidays-[0-9][0-9][0-9][0-9].json')) if directory else [default_file]
    calendars = {}
    for path in files:
        calendar = json.loads(path.read_text(encoding='utf-8'))
        if calendar['year'] in calendars: raise ValueError('holiday_calendar_duplicate_year')
        calendars[calendar['year']] = calendar
    for year in range(int(first[:4]), int(last_day[:4]) + 1):
        if year not in calendars or last_day > calendars[year]['reviewAfter'][:10]: raise ValueError('holiday_calendar_scope')
    holidays = {day for calendar in calendars.values() for day in calendar['holidays']}
    digest = sha(files[0]) if len(files) == 1 else hashlib.sha256('|'.join(sorted(sha(path) for path in files)).encode()).hexdigest()
    return holidays, digest

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024): h.update(chunk)
    return h.hexdigest()

def write_new(path, value):
    with open_private(path) as output:
        json.dump(value, output, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        output.write('\n'); output.flush(); os.fsync(output.fileno())

def feature_vector(row):
    a, b, c, d = [float(row[key]) for key in ['originLatitude', 'originLongitude', 'destinationLatitude', 'destinationLongitude']]
    rad = math.pi / 180
    v = math.sin((c-a)*rad/2)**2 + math.cos(a*rad)*math.cos(c*rad)*math.sin((d-b)*rad/2)**2
    distance = 6371000 * 2 * math.atan2(math.sqrt(v), math.sqrt(max(0, 1-v)))
    north, east = (c-a)*111195.0802335329, (d-b)*111195.0802335329*math.cos((a+c)/2*rad)
    norm = math.hypot(north, east)
    local = dt.datetime.fromtimestamp(row['startedAt']/1000, KST)
    hour = (local.hour + local.minute/60 + local.second/3600)/24*2*math.pi
    weekday = (local.weekday()+1)%7/7*2*math.pi
    return [math.log(distance), a,b,c,d,north,east,east/norm,north/norm,math.sin(hour),math.cos(hour),math.sin(weekday),math.cos(weekday),float(local.weekday() >= 5)]

def validated(row):
    if (row.get('source'),row.get('region'),row.get('mode'),row.get('target'),row.get('deploymentEligible')) != ('seoul-ddareungi-rental','seoul','bicycle','bicycle-rental-elapsed',False): raise ValueError('source_contract')
    if row.get('uncertaintySeconds') != 1 or row.get('inputDistanceKind') != 'station-geodesic' or row.get('coordinatePrecision') != 'station': raise ValueError('target_contract')
    if any(not TOKEN.fullmatch(str(row.get(key,''))) for key in ['id','groupId','entityGroup','sourceArchiveSha256']): raise ValueError('missing_group')
    start, end, seconds = row['startedAt'], row['observedAt'], row['actualSeconds']
    if not all(isinstance(x,(int,float)) and math.isfinite(x) for x in [start,end,seconds]) or not 120 <= seconds <= 10800 or abs(end-start-seconds*1000)>0.001: raise ValueError('label_contract')
    if dt.datetime.fromtimestamp(start/1000,KST).date().isoformat() != row['sourceDate']: raise ValueError('source_date')
    if not all(37<float(row[key])<38 for key in ['originLatitude','destinationLatitude']) or not all(126<float(row[key])<128 for key in ['originLongitude','destinationLongitude']): raise ValueError('region')
    x = feature_vector(row)
    if not 100 <= row['inputDistanceMeters'] <= 20000 or abs(math.exp(x[0])-row['inputDistanceMeters'])>max(2,row['inputDistanceMeters']*.001): raise ValueError('endpoint_distance')
    return x

def held_out(entity):
    return int.from_bytes(hashlib.sha256(('public-mobility-entity-holdout-v1|'+entity).encode()).digest()[:4],'big')%10 == 0

def public_input(row):
    return {key:row[key] for key in ['startedAt','originLatitude','originLongitude','destinationLatitude','destinationLongitude']}

def portable(estimator):
    # sklearn's TreePredictor values already contain the learning-rate factor.
    trees=[]
    for iteration in estimator._predictors:
        if len(iteration)!=1: raise ValueError('non_scalar_model')
        nodes=[]
        for node in iteration[0].nodes:
            if node['is_categorical']: raise ValueError('categorical_export_unsupported')
            nodes.append({'value':float(node['value']), 'feature':int(node['feature_idx']), 'threshold':float(node['num_threshold']),
                          'left':int(node['left']), 'right':int(node['right']), 'leaf':bool(node['is_leaf'])})
        trees.append(nodes)
    return {'initial':float(estimator._baseline_prediction[0,0]),'trees':trees}

def portable_predict(model, xs):
    import numpy as np
    result=np.full(len(xs),model['initial'],dtype=float)
    for tree in model['trees']:
        for i,x in enumerate(xs):
            index=0
            while not tree[index]['leaf']:
                n=tree[index]; index=n['left'] if x[n['feature']]<=n['threshold'] else n['right']
            result[i]+=tree[index]['value']
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',action='append',required=True)
    parser.add_argument('--output-directory',required=True)
    parser.add_argument('--train-through',required=True)
    parser.add_argument('--tune-through',required=True,help='First inner training cutoff; later training dates select parameters.')
    parser.add_argument('--calibration-through',required=True)
    parser.add_argument('--test-through',required=True)
    parser.add_argument('--execute',action='store_true')
    args=parser.parse_args()
    dates=[dt.date.fromisoformat(x) for x in [args.tune_through,args.train_through,args.calibration_through,args.test_through]]
    if dates != sorted(set(dates)): raise ValueError('split_order')
    inputs=[data_path(x) for x in args.input]; output=data_path(args.output_directory)
    if not 1<=len(inputs)<=12 or len(set(inputs))!=len(inputs) or any(not p.is_file() or p.stat().st_size>384*1024**2 for p in inputs): raise ValueError('input_bound')
    if output.exists(): raise ValueError('new_experiment_directory_required')
    protocol={'version':VERSION,'trainThrough':args.train_through,'tuneThrough':args.tune_through,'calibrationThrough':args.calibration_through,'testThrough':args.test_through,
              'seed':61016,'selection':'lowest inner-future MAE; final dates never select models','candidates':[7,15,31],
              'maxIterations':180,'learningRate':.08,'minimumLeafRows':80,'l2Regularization':10,'earlyStopping':False,
              'quantiles':[.05,.5,.95],'conformalCoverage':.9,'heldOutEntityFraction':.1,'featureNames':FEATURES,
              'qualityGate':{'minimumRows':100,'maximumUnsupported':0,'intervalCoverage':.8,'upperCoverage':.9,'maximumMeanRelativeWidth':1.5,'maeImprovesBothBaselines':True},
              'deployment':'shadow','productionEligible':False,'target':'bicycle-rental-elapsed',
              'inputs':[{'file':p.name,'sha256':sha(p)} for p in inputs], 'trainerSha256':sha(Path(__file__))}
    if not args.execute: print(json.dumps(protocol)); return
    output.mkdir(parents=True,mode=0o700)
    write_new(output/'protocol.json',protocol) # Freeze before reading any label.
    import numpy as np
    import sklearn
    from sklearn.ensemble import HistGradientBoostingRegressor
    from threadpoolctl import threadpool_limits
    started=time.monotonic(); rows=[]; xs=[]; ids=set(); groups=set(); sessions=set(); sources=set()
    for input_index,path in enumerate(inputs):
        manifest=json.loads(Path(str(path)+'.manifest.json').read_text(encoding='utf-8'))
        if not manifest.get('reproducibleGrouping') or not TOKEN.fullmatch(manifest.get('groupingSessionSha256','')): raise ValueError('reproducible_grouping_required')
        sessions.add(manifest['groupingSessionSha256']); sources.add(manifest['sourceArchiveSha256']); count=0
        with path.open(encoding='utf-8') as source:
            for line in source:
                if len(line)>100000 or len(rows)>=600000: raise ValueError('row_bound')
                if not line.strip(): continue
                row=json.loads(line); x=validated(row)
                if row['id'] in ids or row['groupId'] in groups: raise ValueError('duplicate_rental')
                if row['sourceDate']>args.test_through or row['sourceArchiveSha256']!=manifest['sourceArchiveSha256']: raise ValueError('outside_frozen_source')
                ids.add(row['id']); groups.add(row['groupId']); rows.append(row); xs.append(x); count+=1
        if count!=manifest['outputRows']: raise ValueError('manifest_row_mismatch')
        if sha(path)!=protocol['inputs'][input_index]['sha256']: raise ValueError('source_changed_during_read')
    if len(sessions)!=1 or len(sources)!=len(inputs): raise ValueError('inconsistent_grouping_or_source')
    x=np.array(xs,dtype=float); y=np.array([r['actualSeconds'] for r in rows],dtype=float)
    day=np.array([r['sourceDate'] for r in rows]); hold=np.array([held_out(r['entityGroup']) for r in rows])
    # Remove trips crossing a chronological boundary, including midnight rentals.
    boundary=lambda s: int(dt.datetime.combine(dt.date.fromisoformat(s)+dt.timedelta(days=1),dt.time(),KST).timestamp()*1000)
    ended=np.array([r['observedAt'] for r in rows])
    train=(day<=args.train_through)&(ended<boundary(args.train_through))&~hold
    cal=(day>args.train_through)&(day<=args.calibration_through)&(ended<boundary(args.calibration_through))&~hold
    test=(day>args.calibration_through)&(day<=args.test_through)
    inner=train&(day<=args.tune_through)&(ended<boundary(args.tune_through)); tune=train&(day>args.tune_through)
    if min(inner.sum(),tune.sum(),train.sum())<1000 or min(cal.sum(),test.sum())<200: raise ValueError('insufficient_future_groups')
    def model(leaves,quantile=.5):
        return HistGradientBoostingRegressor(loss='quantile',quantile=quantile,max_iter=protocol['maxIterations'],learning_rate=protocol['learningRate'],
          max_leaf_nodes=leaves,min_samples_leaf=protocol['minimumLeafRows'],l2_regularization=10,early_stopping=False,random_state=protocol['seed'])
    trials=[]
    with threadpool_limits(limits=4):
        for leaves in protocol['candidates']:
            fitted=model(leaves).fit(x[inner],y[inner]); mae=float(np.abs(fitted.predict(x[tune])-y[tune]).mean())
            trials.append({'leaves':leaves,'innerFutureMaeSeconds':mae})
            print(json.dumps({'stage':'training-only-model-selection',**trials[-1]}),flush=True)
        selected=min(trials,key=lambda v:(v['innerFutureMaeSeconds'],v['leaves']))['leaves']
        estimators={}
        for label,q in [('lower',.05),('median',.5),('upper',.95)]:
            estimators[label]=model(selected,q).fit(x[train],y[train]); print(json.dumps({'stage':'fit','target':label,'rows':int(train.sum())}),flush=True)
        # Baselines fit the identical training rows, excluding held-out devices.
        seconds_per_meter=float(np.quantile(y[train]/np.exp(x[train,0]),.5,method='inverted_cdf'))
        raw=x[:,[0,9,10,11,12]]; center=np.quantile(raw[train],.5,axis=0,method='inverted_cdf')
        scale=np.quantile(raw[train],.75,axis=0,method='inverted_cdf')-np.quantile(raw[train],.25,axis=0,method='inverted_cdf'); scale=np.where(scale>0,scale,1)
        normalized=np.clip((raw-center)/scale,-4,4); design=np.column_stack((np.ones(len(x)),normalized))
        penalty=np.eye(design.shape[1]); penalty[0,0]=1e-8
        coefficient=np.linalg.solve(design[train].T@design[train]+penalty,design[train].T@np.log(y[train]/(np.exp(x[train,0])*seconds_per_meter)))
        ridge=np.exp(x[:,0])*seconds_per_meter*np.exp(design@coefficient); baseline=np.exp(x[:,0])*seconds_per_meter
        cal_predictions={key:value.predict(x[cal]) for key,value in estimators.items()}
        cl=np.minimum(cal_predictions['lower'],cal_predictions['median']); cu=np.maximum(cal_predictions['upper'],cal_predictions['median'])
        score=np.maximum.reduce((cl-y[cal],y[cal]-cu,np.zeros(cal.sum())))
        conformal=float(np.quantile(score,min(1,math.ceil((len(score)+1)*.9)/len(score)),method='inverted_cdf'))
        bounds={'minimum':[float(v) for v in x[train].min(axis=0)],'maximum':[float(v) for v in x[train].max(axis=0)]}
        trees={key:portable(value) for key,value in estimators.items()}
        model_artifact={'version':VERSION,'deployment':'shadow','productionEligible':False,'target':'bicycle-rental-elapsed','region':'seoul','trainedAt':int(time.time()*1000),
                        'featureNames':FEATURES,'models':trees,'conformalSeconds':conformal,'labelUncertaintySeconds':1,'domain':bounds,
                        'trainingThrough':args.train_through,'sourceArchiveSha256':sorted(sources),'inputSha256':[v['sha256'] for v in protocol['inputs']],
                        'limitations':['rental-return-includes-stops','no-contemporaneous-provider-baseline','no-initial-final-walk','observational-not-route-optimality','offline-shadow-only']}
        # Numerical packaging parity on train/calibration inputs before final evaluation.
        check=np.flatnonzero(train|cal)[::max(1,int((train|cal).sum()/128))][:128]
        parity={key:float(np.max(np.abs(portable_predict(trees[key],x[check])-value.predict(x[check])))) for key,value in estimators.items()}
        if max(parity.values())>1e-8: raise ValueError('portable_inference_mismatch')
        write_new(output/'model.json',model_artifact)
        write_new(output/'parity.json',{'toleranceSeconds':1e-8,'maximumErrorSeconds':parity,'cases':[{'input':public_input(rows[i]),'features':xs[i],
                    'predictions':{key:float(value.predict(x[i:i+1])[0]) for key,value in estimators.items()}} for i in check]})
        # This is the only final-future evaluation. No fitting follows these predictions.
        predictions={key:value.predict(x[test]) for key,value in estimators.items()}
    ti=np.flatnonzero(test); actual=y[test]; median=np.clip(predictions['median'],1,10800)
    lower=np.maximum(0,np.minimum(predictions['lower'],median)-conformal-1); upper=np.maximum(predictions['upper'],median)+conformal+1
    # Domain support is a declared spatial/distance envelope, never outcome-based.
    support=np.ones(len(ti),dtype=bool)
    for feature in [0,1,2,3,4]:
        tolerance=.15*(bounds['maximum'][feature]-bounds['minimum'][feature]) if feature==0 else .015
        support&=(x[test,feature]>=bounds['minimum'][feature]-tolerance)&(x[test,feature]<=bounds['maximum'][feature]+tolerance)
    def evaluate(mask):
        n=int(mask.sum()); accepted=mask&support; k=int(accepted.sum())
        if not n:return None
        return {'rows':n,'supported':k,'unsupported':n-k,'baselineMaeSeconds':float(np.abs(baseline[test][mask]-actual[mask]).mean()),
                'ridgeMaeSeconds':float(np.abs(ridge[test][mask]-actual[mask]).mean()),
                'modelMaeSeconds':float(np.abs(median[accepted]-actual[accepted]).mean()) if k==n else None,
                'supportedModelMaeSeconds':float(np.abs(median[accepted]-actual[accepted]).mean()) if k else None,
                'intervalCoverage':float(np.sum(accepted&(lower<=actual-1)&(upper>=actual+1))/n),
                'upperCoverage':float(np.sum(accepted&(upper>=actual+1))/n),
                'meanRelativeWidth':float(((upper[accepted]-lower[accepted])/actual[accepted]).mean()) if k else None}
    od=lambda r:(r['originStationId'],r['destinationStationId'])
    ods={od(rows[i]) for i in np.flatnonzero(train)}; unseen=np.array([od(rows[i]) not in ods for i in ti])
    evaluations={'all':evaluate(np.ones(len(ti),dtype=bool)),'unseenOd':evaluate(unseen),'seenOd':evaluate(~unseen),'heldOutBicycle':evaluate(hold[test])}
    hours=np.array([dt.datetime.fromtimestamp(rows[i]['startedAt']/1000,KST).hour for i in ti])
    parts={'night':hours<6,'morning':(hours>=6)&(hours<10),'day':(hours>=10)&(hours<17),'evening':(hours>=17)&(hours<21),'late':hours>=21}
    evaluations['dayParts']={name:evaluate(mask) for name,mask in parts.items()}
    evaluations['days']={s:evaluate(day[test]==s) for s in sorted(set(day[test]))}
    def good(e):
        return bool(e and e['rows']>=100 and e['unsupported']==0 and e['modelMaeSeconds']<min(e['baselineMaeSeconds'],e['ridgeMaeSeconds']) and e['intervalCoverage']>=.8 and e['upperCoverage']>=.9 and e['meanRelativeWidth']<=1.5)
    checked={k:v for k,v in evaluations.items() if k not in ['dayParts','days']}; checked.update({f'dayPart:{k}':v for k,v in evaluations['dayParts'].items()}); checked.update({f'day:{k}':v for k,v in evaluations['days'].items()})
    failures=[k for k,e in checked.items() if not good(e)]
    split=lambda mask:{'rows':int(mask.sum()),'dates':sorted(set(day[mask])),'bicycles':len({rows[i]['entityGroup'] for i in np.flatnonzero(mask)})}
    report={'version':VERSION,'deployment':'shadow','productionEligible':False,'qualityPassed':not failures,'qualityFailedGroups':failures,
            'counts':{'input':len(rows),'sourceFiles':len(inputs),'excludedHeldOutTraining':int(((day<=args.train_through)&hold).sum()),'excludedHeldOutCalibration':int(((day>args.train_through)&(day<=args.calibration_through)&hold).sum()),
                      'purgedTrainingBoundary':int(((day<=args.train_through)&(ended>=boundary(args.train_through))&~hold).sum()),'purgedCalibrationBoundary':int(((day>args.train_through)&(day<=args.calibration_through)&(ended>=boundary(args.calibration_through))&~hold).sum())},
            'split':{'train':split(train),'calibration':split(cal),'test':split(test),'innerTrain':split(inner),'innerFuture':split(tune)},
            'selection':{'trials':trials,'selectedLeaves':selected,'finalTestUsedForSelection':False},'evaluations':evaluations,
            'calibration':{'conformalSeconds':conformal,'labelUncertaintySeconds':1,'coverageTarget':.9},'portableParity':parity,
            'reproducibility':{'protocolSha256':sha(output/'protocol.json'),'modelSha256':sha(output/'model.json'),'groupingSessionSha256':next(iter(sessions)),
                               'python':sys.version.split()[0],'numpy':np.__version__,'sklearn':sklearn.__version__,'threads':4},
            'elapsedSeconds':round(time.monotonic()-started,3),'limitations':model_artifact['limitations']}
    write_new(output/'report.json',report)
    print(json.dumps(report,ensure_ascii=False),flush=True)

if __name__=='__main__':
    try: main()
    except Exception as error:
        # Never print raw records, identifiers or source-bearing tracebacks.
        print(json.dumps({'error':'spatial-training-refused','reason':str(error) if isinstance(error,ValueError) and len(str(error))<100 else type(error).__name__}),file=sys.stderr)
        sys.exit(1)
