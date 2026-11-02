# 운영 모델 자동 갱신 (Google Cloud, 서울)

운영 모델(공개 버스, 공간 버스, 지하철 개찰, 따릉이 공간)과 공휴일 달력은 사람이 학습을 시키지 않아도 배포 서버에서 스스로 갱신됩니다. 이 Mac은 개발용이고, 같은 진입점을 로컬 폴더로 돌려 검증만 합니다.

이 문서는 서버(Cloud Run 서비스) 쪽과 클라우드 정의를 다룹니다. 갱신 단계와 기준(내려받기, 창 만들기, 학습, 평가, 승격)은 `model-refresh/scripts/models-refresh.ts`와 `model-refresh/scripts/model-refresh/`에 있습니다.

### 코드 위치 (11/02부터 이 저장소 안)

Job 코드는 백엔드 저장소의 `model-refresh/`에 있습니다(모노레포에서는 `jigak-backend/model-refresh/`). 백엔드만 담은 저장소(`USWA-Ulsan-Small-Whale-Assosiation/jigak-backend`)를 받아도 이미지를 만들고 테스트를 돌릴 수 있습니다. 이 문서의 경로와 명령은 **백엔드 저장소 루트 기준**입니다. 모노레포에서는 앞에 `jigak-backend/`를 붙이거나 `npm --prefix jigak-backend …`로 부릅니다.

| 경로                                                                                                                     | 내용                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model-refresh/scripts/models-refresh.ts`                                                                                | 진입점(`refresh`, `init`, `bundle`, `rollback`, `verify`, `holidays`)                                                                             |
| `model-refresh/scripts/model-refresh/*.ts`                                                                               | 단계(스토어, manifest, 일정, T-DATA, 파이프라인, 재검증), `incumbent-gate.py`                                                                     |
| `model-refresh/scripts/*.ts`, `*.py`                                                                                     | 러너가 띄우는 단계 스크립트(공개 버스 가공·학습·검증, 승격 3종, 학습기 3종, `private_files.py`), `requirements-spatial-eta.txt`, `holiday-env.ts` |
| `model-refresh/data-static/`                                                                                             | 고정 입력 2개(TOPIS 도로 기준표, 역 좌표)와 출처·이용 조건(`README.md`). sha256으로 확인합니다                                                    |
| `model-refresh/tests/`                                                                                                   | Job 테스트(`npm run test:model-refresh`), 타입 검사는 `npm run typecheck:model-refresh`                                                           |
| `model-refresh/Dockerfile`, `Dockerfile.dockerignore`, `cloudbuild.yaml`, `cloudbuild.trigger.yaml`, `package.json`(+락) | 이미지와 빌드. Job의 Node 의존성은 `tsx`·`zod`뿐이고 API 락과 같은 판입니다                                                                       |
| `model-refresh/monitoring/`, `model-refresh/local/`                                                                      | 경보 정책, 개발용 launchd                                                                                                                         |

- 러너는 모델 파일을 **API와 같은 코드**(`src/common/engine/intelligence/**`)로 읽고 검증합니다. 복사본이 없습니다. 공휴일은 단계마다 `holiday-env.ts`가 `JIGAK_HOLIDAY_DIR`(이번 실행의 스토어 달력)을 `usePublishedKoreanHolidays`로 등록합니다. API의 `korean-holidays.ts`는 바뀌지 않았습니다.
- API 빌드와 이미지는 `model-refresh/`를 보지 않습니다(`tsconfig` 포함 범위, `copy-assets`, API `Dockerfile`의 COPY 목록 모두 `src`만). API 이미지에는 Python도 tsx도 들어가지 않습니다.
- 모노레포의 mvp는 같은 파일을 부릅니다(`npm --prefix mvp run models:refresh` 등과 학습 단계 스크립트). mvp의 연구용 파이썬 스크립트도 `private_files.py`·`train-spatial-bicycle.py`·`prepare-public-bus.py`를 여기서 읽습니다. 사본은 없습니다.
- 백엔드 `node_modules`가 있어야 합니다(`npm ci`). 파이썬 테스트는 `PYTHON`(없으면 `python3`)에 `numpy`, `scikit-learn`이 있어야 합니다(`model-refresh/scripts/requirements-spatial-eta.txt`).

## 구조

```
Cloud Scheduler (30 5,9,13 * * *, Asia/Seoul)
   └─ run.googleapis.com/v2/.../jobs/jigak-model-refresh:run
        └─ Cloud Run Job jigak-model-refresh   (Node + Python 이미지, 8 vCPU / 32GiB, 제한 3시간)
             └─ /models-store  ← 버킷 gs://<프로젝트>-jigak-models (asia-northeast3, gcsfuse 읽기·쓰기)
                   manifest.json  ← 운영 포인터. 승격 때만 바뀐다
                   models/<key>/<version>/<시각>-<sha12>.json  ← 바뀌지 않는 모델 파일
                   calendars/…  refresh-status.json  journals/  raw/  runs/  locks/  references/
Cloud Run 서비스 jigakmap-api
   └─ /models  ← 같은 버킷, 읽기 전용 볼륨
        MODEL_MANIFEST_PATH=/models/manifest.json → 60초마다 확인, 재시작 없이 교체
```

- 모델 파일은 한 번 쓰면 바뀌지 않습니다. 운영 전환은 `manifest.json` 한 개를 바꾸는 일입니다. 서비스는 옛 manifest나 새 manifest 중 하나만 봅니다.
- 하루 세 번(05:30, 09:30, 13:30) 돕니다. T-DATA 공개 시각이 불확실해서입니다. 할 일이 없으면 1분 안에 끝납니다.
- 갱신 창은 만료 120시간 전에 열립니다. 실패하면 다음 실행과 다음 평가일에 다시 시도하고, 남은 시간이 48시간 아래인데 실패하면 Job이 exit 2로 끝나 경보가 갑니다.
- 기존 모델은 새 모델이 기준을 통과해 승격될 때까지 그대로 서빙됩니다. 새 모델이 진 날에는 아래 "재검증"으로 기존 모델의 만료를 늘립니다. 그래도 못 바꾸면 만료 뒤 서버가 지금처럼 공급자·시간표 시간으로 돌아가고, health는 `degraded`로 보입니다.

## 서버가 하는 일 (`src/common/engine/intelligence/model-manifest.ts`)

환경변수 (모두 비어 있으면 예전 `ETA_*_PATH` 고정 경로 방식 그대로입니다):

| 변수                          | 뜻                                                                    |
| ----------------------------- | --------------------------------------------------------------------- |
| `MODEL_MANIFEST_PATH`         | manifest 파일 경로. Cloud Run은 `/models/manifest.json`               |
| `MODEL_MANIFEST_POLL_SECONDS` | 확인 주기. 기본 60 (1~3600)                                           |
| `MODEL_REFRESH_STATUS_PATH`   | Job 보고서. 기본은 manifest와 같은 폴더의 `refresh-status.json`       |
| `MODEL_REFRESH_SCHEDULE_KST`  | health의 `nextScheduledAt` 계산용 시각 목록. 기본 `05:30,09:30,13:30` |

- manifest가 있는 키(`publicBus`, `spatialBus`, `railGate`, `bicycleRide`)는 manifest를 따릅니다. manifest에 없는 키는 `ETA_*_PATH`가 있으면 그것을 씁니다.
- 만료 시각은 manifest의 `expiresAt`이 모델 파일 안의 `expiresAt`보다 우선합니다(`origin`이 `manifest`일 때). 재검증은 같은 파일(sha256 그대로)에 manifest만 바꿔 만료를 늘리기 때문입니다. 서버는 한 번의 확인(`MODEL_MANIFEST_POLL_SECONDS`) 안에 따라오고, 모델 학습 시각 + 28일을 넘는 값은 28일로 자릅니다.
- 만료는 모델 파일에 든 공휴일 달력의 끝에서 4시간 앞(`calendar.lastDate` 20:00 KST)도 넘지 못합니다. 달력 밖의 날은 요일 구분을 몰라 예측이 모두 null이 되고, 만료 직전의 요청도 최대 4시간 뒤의 탑승을 예측해야 하기 때문입니다(promote도 달력을 만료+4시간의 날짜까지 넣습니다). 다만 파일 자신의 만료가 그보다 늦고 달력 끝(다음 날 00:00) 안이면 파일 값을 그대로 둡니다. 따릉이 파일이 그렇습니다. manifest나 파일이 그보다 늦은 만료를 적어도 서버는 이 시각에 모델을 끄고 `active: false`, `reasons: ['expired-checkpoint']`로 보입니다. health에는 `expirySource`(`file`/`manifest`/`calendar`)와 `revalidatedAt`이 붙습니다. `calendar`는 달력 끝이 만료를 정했다는 뜻입니다.
- 새 manifest의 경로는 `manifest.json`이 있는 폴더 안만 허용합니다(절대 경로와 `..`는 거부).
- 서비스는 새로 가리킨 파일의 sha256을 확인하고 모델 파서로 읽어 본 뒤에만 바꿉니다. 해시가 다르면 `manifest-sha-mismatch`, 파싱 실패나 크기 초과면 `manifest-candidate-invalid`, 파일이 아직 없으면 `manifest-candidate-missing`을 `reasons`에 적고 **이전 모델을 그대로 씁니다.**
- 읽을 수 없거나 형식이 틀린 manifest, 세대 번호가 줄어든 manifest는 무시하고 쓰던 manifest를 유지합니다(`manifest.error`에 이유).
- 공휴일: manifest의 `calendars`가 있으면 이미지에 든 파일 대신 그것을 씁니다(해시 확인 뒤). 바뀌면 다시 읽습니다. 이미지에 든 파일은 대체용입니다. 따릉이 실측표(`bicycleRideTimes`)는 시작할 때 한 번 읽습니다.

### 재검증 (revalidated)

새 학습 결과가 기존 모델에 지거나(`gate:worse-than-incumbent`) 자체 기준을 못 넘었을 때(`gate:quality-failed`) 기존 모델을 그냥 만료시키지 않습니다. 공간 버스와 지하철 개찰에 적용됩니다. 공개 버스는 경로에 쓰이지 않아 적용하지 않습니다.

1. 새 평가일의 행 전부로 **기존 모델 하나만** 다시 잽니다. 기준은 **승격 게이트와 같습니다**(사용자 결정 D4, 11/02).
   - 예측은 서버 코드(`model-refresh/scripts/model-refresh/incumbent.ts`가 `src/common/engine`의 모델 코드를 부름)로 냅니다. 사용자가 받는 값 그대로입니다.
   - 판정은 `model-refresh/scripts/model-refresh/incumbent-gate.py`가 합니다. 이 스크립트는 학습기의 `quality_evaluation`, `quality_passed`, `quality_groups`(`train-spatial-bus-v3.py`, `train-rail-gate.py`)를 그대로 불러 씁니다. 기준을 따로 적은 사본은 없습니다.
   - 구간: 전체, 학습에서 본/처음 보는 OD(공간 버스 `seenOd`/`newOd`, 지하철 `seenOd`/`unseenOd`), 시간대 5개(`dayPart:*`), 평가일(`day:*`). 하나라도 떨어지면 연장하지 않습니다.
   - 구간마다: 행 100개 이상, 지원 못 한 행 0건, 구간 포함률 0.80 이상, 상한 포함률 0.90 이상, 평균 상대 폭 1.5 이하, MAE가 기준선보다 작음. 기준선은 공간 버스가 거리 기준선과 이전 공개 버스 모델(같은 창 보고서의 모델, 없으면 서비스 중인 공개 버스 모델, 학습기와 같은 순서), 지하철이 거리·ridge·구간 중앙값 기준선입니다.
   - 학습기가 범위 밖으로 빼는 행(공간 버스의 서울 밖·경로 불일치)은 여기서도 뺍니다. 지하철에서 모델이 인코딩을 갖지 않은 역의 행은 서버가 답하지 않고 공급자 시간이 쓰이므로 빼고 `unseenStation`으로 셉니다. 이 행이 그날 행의 0.1%와 10행 중 큰 값을 넘으면(새 역·역 이름 변경 등) `unseenStation` 구간이 떨어진 것으로 보고 연장하지 않습니다. 그 밖에 서버가 답하지 못한 행은 지원 못 한 행입니다.
   - 처음 보는 OD와 ridge 기준선은 모델 파일에 없습니다. 그래서 승격 직후 같은 입력으로 학습 구간을 다시 만들어 `references/<모델>/<sha256>.json`에 남깁니다(`incumbent-gate.py reference`). 다시 만든 학습 행의 특성 범위가 모델 파일의 `domain`과(지하철은 `secondsPerMeter`도) 정확히 같아야 씁니다. 참조 파일이 없는 모델은 재검증하지 않습니다(`reference-missing`). 참조 파일은 manifest와 이력이 가리키는 sha256의 것만 남깁니다.
   - 번들과 `init`이 참조 파일을 함께 옮깁니다(11/02). `models:store:bundle`은 번들에 담는 운영 파일과 **같은 sha256**의 참조 파일을 `references/<모델>/<sha256>.json`으로 넣습니다. 찾는 곳은 `--store`로 준 스토어의 `references/`, 그다음 모노레포의 `mvp/data/model-references/<sha256>.json`(git 제외)입니다. 결과 JSON의 `missingReferences`에 공간 버스·지하철이 있으면 그 모델은 재검증되지 않습니다. `init --from-bundle`은 설치한 모델의 sha256과 같은 것만 스토어 `references/`에 씁니다. 그래서 클라우드 1세대부터 재검증이 됩니다. 이미 `manifest.json`이 있는 버킷은 `deploy/model-refresh-job.sh` 8단계가 참조 파일만 덮어쓰지 않고 더합니다(`gcloud storage cp --no-clobber`).
   - 지금 서비스 중인 두 파일(`5fddf255d256`, `c5aec8b5e64c`)의 참조 파일은 이 Mac의 `mvp/data/model-references/`에 있습니다(11/02 실측: 번들 `references/` 2개, `init` 후 스토어 2개). 다시 만들 때는 모노레포의 `mvp/`에서 아래처럼 실행합니다(학습 입력이 `mvp/data`에 있음, 각 3초).
     ```
     JIGAK_HOLIDAY_DIR=../jigak-backend/src/common/engine/realtime/data python3 ../jigak-backend/model-refresh/scripts/model-refresh/incumbent-gate.py reference --model spatialBus \
       --checkpoint data/spatial-bus-operational.json --window 2026-10-12:2026-10-15:2026-10-18:2026-10-24:2026-10-25 \
       --input data/public-bus-multiday-context-20261012-20261025.jsonl --output data/model-references/5fddf255d256ae92a80ef9f40eb8b77d0c09e482ebddd16c78e64ff52f0865e6.json
     JIGAK_HOLIDAY_DIR=../jigak-backend/src/common/engine/realtime/data python3 ../jigak-backend/model-refresh/scripts/model-refresh/incumbent-gate.py reference --model railGate \
       --checkpoint data/rail-gate-operational.json --window 2026-09-28,2026-10-12,2026-10-16,2026-10-21,2026-10-22+2026-10-23+2026-10-24+2026-10-25 \
       --input data/public-rail-gates-20260928-20261011.jsonl --input data/public-rail-gates-unseen-20261012-20261016.jsonl --input data/public-rail-gates-20261017-20261025.jsonl \
       --stations data/spatial-transit-stations-20261029/stations.csv --output data/model-references/c5aec8b5e64c2d6f578dfab9978be15866145216f2382403e8138f1f7572b493.json
     ```
   - 실데이터 확인(11/02): 서비스 중인 공간 버스(`5fddf255d256`)를 자기 평가일 10/25에 다시 재면 학습 보고서의 구간별 수치와 2e-16까지 같습니다. 지하철(`c5aec8b5e64c`)은 10/22~25에서 서버가 답하지 않는 역 1행을 뺀 구간이 보고서와 같고, 나머지 4개 구간도 통과합니다.
   - 10/28 Windows 재검증(옛 기준)의 공간 버스 지원율 0.982는 학습기가 빼는 행까지 센 값입니다. 10/25에도 서버가 답하지 않은 158행은 모두 학습기가 빼는 행이었고, 남은 9,837행의 지원 못 한 행은 0이었습니다. 그러니 그 수치만으로 새 기준에서 떨어진다고 볼 수는 없습니다. 다만 10/28 원자료가 이 Mac에 없어 새 기준으로 다시 재지는 못했습니다. 새 기준은 옛 기준보다 엄격하고, 연장되지 않으면 만료 뒤 공급자 시간으로 돌아갑니다.
   - 학습기 두 파일에서 판정 함수를 꺼내면서 `trainerSha256`과 프로토콜 해시가 바뀌었습니다. 옛 프로토콜이 이미 쓴 평가일을 다시 돌리면 거부되고 그날 그 모델이 닫힙니다. 11/02 기준 이 Mac에는 store가 없어(열린 시도 없음) 영향이 없습니다. Windows store는 더 쓰지 않습니다.
2. 통과하면 manifest 항목의 `expiresAt`을 (갱신을 실행한 시각 + 7일)로 늘립니다. 모델 파일은 바꾸지 않아 sha256이 그대로입니다. 새 세대가 하나 생기고 항목에 `revalidatedAt`, `revalidationCount`, `revalidations`(최근 5개: 시각, 평가일, 이전 만료, 후보가 진 이유, 두 모델의 MAE·포함률, 구간별 판정, `clippedBy`, `calendarLastDate`)가 남습니다. 승격되면 이 값들은 사라지고 이전 모델은 늘어난 만료 그대로 history에 들어갑니다.
3. 늘린 만료는 학습 시각 + 28일과 모델 파일 안 공휴일 달력의 끝(`calendar.lastDate` 다음 날 00:00 KST) 중 이른 쪽을 넘지 않습니다. 잘렸으면 `clippedBy`가 `calendar-end` 또는 `max-model-age`입니다. 더 늘릴 것이 없으면 `revalidation-limit-reached:calendar-end`처럼 이유를 붙여 거부하고, 그 뒤에는 새 모델이 승격되든지 만료됩니다.
   - 11/02 이전에 승격된 공간 버스·지하철 파일은 달력이 만료일(11/07)까지만 들어 있어, 재검증해도 11/07 20:00을 넘지 못합니다.
   - 이제 `promote-spatial-bus.ts`와 `promote-rail-gate.ts`는 검토된 공휴일 파일이 덮는 데까지 학습 시각 + 28일(+ 심야 4시간)의 달력을 넣습니다. 검토 기한이 지났거나 없는 해는 넣지 않고, 모델 자체의 7일은 지금처럼 꼭 덮어야 합니다. 그래서 새로 승격된 모델은 재검증이 실제로 일주일씩 이어집니다.
4. 통과하지 못하면 아무것도 바꾸지 않고 후보의 `closed` 결과에 `incumbentGate`를 붙입니다. `failed`가 떨어진 구간(예: `dayPart:overnight`)이나 판정을 못 한 이유(`reference-missing`, `gate-not-run:…`)이고, `evaluations`가 구간별 수치입니다. 통과해서 연장되면 같은 값이 manifest `revalidations[].evidence.incumbentGate`에 남습니다.
5. `refresh-status.json`의 해당 모델 `lastAttempt.outcome`이 `revalidated`이고 `lastAttempt.details`에 두 모델의 수치와 이전·이후 만료가 들어갑니다. 실행 결과는 `revalidated`(종료 코드 0)입니다. 다른 멤버가 실패했다면 `partial`(3)이고, 이것도 Job 실패로 세어 경보가 갑니다(아래 "경보").

학습기가 **죽은** 경우(코드·환경 오류, 보고서 없음)는 평가일을 닫지 않습니다. `train-*.py`는 실패를 `{"kind":"refused"|"crash","reason":"KeyError: 'model'"}`로 알리고, `refused`(프로토콜 규칙)는 그날 그 멤버를 닫고 `crash`는 다음 실행에서 이어 받습니다(이미 끝난 가공·학습 단계는 다시 하지 않음). 세 번 죽으면 `retries-exhausted:…`로 닫습니다. 컨테이너가 통째로 죽으면(메모리 초과, SIGKILL, 작업 제한 3시간) 오류를 셀 기회가 없으므로, 실행은 작업을 시작하기 전에 `attempt.json`의 `runs`를 올려 저장합니다. 그날이 열린 채로 세 번 시작됐으면 네 번째 실행은 학습하지 않고 `retries-exhausted:unfinished-run`으로 닫아, 같은 평가일을 끝없이 고르지 않습니다. 학습기는 평가일을 기록하기 전까지의 검사에서 죽으면 그날을 쓰지 않은 채로 둡니다. 공개 버스 후보가 기준 미달이어서 보고서에 모델이 없으면 공간 버스는 서비스 중인 공개 버스 모델을 비교 기준으로 씁니다(`protocol.referenceSource`).

`models:store:bundle -- --out DIR --store DIR`는 그 store의 재검증을 `operational/revalidations.json`으로 번들에 넣고, `init --from-bundle`은 **같은 sha256**의 파일에만, 유효한 연장일 때만 적용합니다. 이 규칙 전에 만든 번들의 연장이 파일의 달력 끝을 넘으면 달력 끝으로 잘라 적용하고 항목에 `expiryClippedBy: "calendar-end"`를 남깁니다. 러너도 만료를 볼 때(갱신 창, 48시간 경보, `refresh-status.json`, `models:manifest:verify`의 `effectiveExpiresAt`) 같은 식으로 자른 값을 씁니다.

### health로 보는 것

`GET /api/health`의 `models.*`(그리고 `/api/models/public-bus` 등)는 모델마다 다음 필드를 더 갖습니다: `trainedAt`, `expiresAt`, `sha256`, `origin`(`manifest` 또는 `env`), `manifestGeneration`, `promotedAt`, `previousVersion`, `expirySource`, `revalidatedAt`. 기존 `source`는 모델의 학습 출처 객체라서 그대로 두고 새 필드는 `origin`으로 붙였습니다. `refreshDue`와 `remainingSeconds`는 그대로입니다.

최상위 `modelRefresh` (같은 내용이 `GET /api/models/refresh`, 전체 모델은 `GET /api/models`):

```json
{
  "status": "ok|stale|degraded|unconfigured",
  "reasons": [],
  "manifest": { "generation": 7, "updatedAt": "...", "runId": "...", "error": null },
  "lastRun": { "runId": "...", "finishedAt": 1793547845554, "outcome": "noop" },
  "nextScheduledAt": 1793565000000,
  "models": {
    "spatialBus": {
      "expiresAt": 0,
      "active": true,
      "remainingSeconds": 0,
      "refreshOpensAt": 0,
      "nextAttemptAt": 0,
      "consecutiveFailures": 0,
      "lastFailureReason": null
    }
  },
  "calendars": { "2026": { "source": "kasi-spcde-api", "reviewAfter": "2026-12-17" } }
}
```

- `unconfigured`: `MODEL_MANIFEST_PATH` 없음.
- `stale`: 마지막 실행이 26시간보다 오래됐거나 보고서가 없다.
- `degraded`: manifest에 있는 모델이 만료됐거나 쓸 수 없고, 또는 48시간 안에 만료되는데 갱신이 실패하고 있다(`consecutiveFailures > 0`), 또는 manifest를 읽은 적이 없다.
- `operatingData.holidayFiles.origin`과 `operatingData.serviceCalendar.origin`(`manifest`/`bundled`), `provenance`(`kasi-spcde-api`, `unofficial-cross-check`, `carried`)로 공휴일 파일의 출처를 봅니다.

## 개발용 로컬 실행

같은 진입점입니다. 저장소는 폴더 하나입니다. 백엔드 저장소 루트에서:

```bash
npm ci                                                       # tsx, zod, typescript (Job 코드도 이것을 씀)
npm run models:store:init -- --store ~/jigak-store           # 현재 운영 파일로 1세대 (모노레포 필요, 아래)
npm run models:store:init -- --store ~/jigak-store --from-bundle <번들 폴더>   # 백엔드 저장소만 있을 때
npm run models:refresh -- --store ~/jigak-store --plan       # 아무것도 쓰지 않고 할 일만 출력
npm run models:refresh -- --store ~/jigak-store              # 실제 갱신 (.env의 DATA_GO_KR_SERVICE_KEY)
npm run models:manifest:verify -- --store ~/jigak-store
npm run test:model-refresh && npm run typecheck:model-refresh
# 백엔드가 그 폴더를 따라가게 하려면
MODEL_MANIFEST_PATH=~/jigak-store/manifest.json npm run start:dev
```

- 상대 경로(`--store`, `--out`)는 명령을 실행한 폴더 기준입니다. `npm run`은 백엔드 루트, `npm --prefix mvp run`(모노레포)은 `mvp/`입니다. mvp 쪽 `models:*`는 같은 러너를 부르고 `mvp/.env`를 읽습니다.
- `bundle`과 `--from-bundle` 없는 `init`은 git에 없는 운영 파일과 저널을 읽습니다: 모노레포의 `cloud-models/`, `mvp/data/`(평가일 저널, `spatial-bicycle-v2-final/` 따릉이 씨앗, `model-references/`). `model-refresh/`의 두 단계 위가 모노레포면 자동으로 찾고, 아니면 `--repo-root DIR` 또는 `JIGAK_MONOREPO_ROOT`로 알려 줍니다. 백엔드 저장소만 있으면 `monorepo-missing`으로 멈춥니다. 공휴일 달력은 `src/common/engine/realtime/data`, 고정 입력은 `model-refresh/data-static`에서 가져옵니다.
- 로컬 파이썬은 `PYTHON`, 없으면 `model-refresh/data/mobility-python` 또는 모노레포의 `mvp/data/mobility-python`, 그것도 없으면 `python3`(Windows `python`)입니다.

매일 05:30에 자동으로 돌리려면 launchd 에이전트를 씁니다(개발용, **설치하지 않았습니다**). 파일 안의 경로를 읽어 본 뒤 한 줄입니다.

```bash
launchctl bootstrap gui/$(id -u) /Users/dbswnstj/works/projects/digitalcontentcompetition_whale/jigak-backend/model-refresh/local/kr.jigakjido.model-refresh.plist
```

해제는 `launchctl bootout gui/$(id -u)/kr.jigakjido.model-refresh`. 저장소 폴더는 `mvp/data/model-store-local`이고, 에이전트는 `npm --prefix mvp run models:refresh`(이 저장소의 러너를 부름)를 실행합니다. 운영은 이 Mac이 아니라 클라우드 Job입니다.

## 클라우드에 올리기 (사용자 승인 필요, 아직 아무것도 만들지 않았습니다)

필요한 것: GCP 프로젝트 ID(결제 연결됨), (선택) 알림 이메일, `DATA_GO_KR_SERVICE_KEY` 값, `gcloud` 로그인(`gcloud auth login`). 백엔드 저장소 루트에서 실행합니다(모노레포에서는 `bash jigak-backend/deploy/…`).

```bash
# 1) 계획만 출력합니다. gcloud를 부르지 않습니다.
bash deploy/model-refresh-job.sh --project 프로젝트ID --alert-email 주소 --api-host API도메인
# 2) 내용을 읽은 뒤 실행합니다. 이미 있는 리소스는 건너뜁니다. 중간에 멈추면 --from-step N으로 이어 갑니다.
bash deploy/model-refresh-job.sh --project 프로젝트ID --alert-email 주소 --api-host API도메인 --apply
#    백엔드 저장소만 받은 PC라면 8단계(버킷 첫 세대)에 쓸 번들을 모노레포 PC에서 만들어 받아 옵니다:
#      (모노레포) npm --prefix jigak-backend run models:store:bundle -- --out <폴더>
#      (여기)     bash deploy/model-refresh-job.sh ... --apply --bundle <받은 폴더>
# 5단계 끝에서 한 번 직접: 키를 Secret Manager에 넣습니다(화면에 찍히지 않음).
#   read -rs KEY && printf %s "$KEY" | gcloud --project 프로젝트ID secrets versions add data-go-kr-service-key --data-file=- ; unset KEY
# 3) API 서비스가 버킷을 따라가게 합니다(cloud-run.env.yaml에 MODEL_MANIFEST_PATH: '/models/manifest.json').
pwsh deploy/cloud-run.ps1 ...기존 인자... -ModelBucket 프로젝트ID-jigak-models
```

스크립트 순서: API 사용 설정 → Artifact Registry `jigak` → 버킷(서울, 균일 접근, 버전 관리, 이전 버전 14일·`raw/` 21일 수명주기) → 서비스 계정과 권한 → 시크릿 → 이미지 빌드(Cloud Build, 서울, 이 저장소를 그대로 올림) → Job → 첫 세대 만들기(번들 올리고 Job을 `init`으로 1회. 이미 있으면 참조 파일만 더함) → Scheduler → 계획 실행(`--plan`) → (알림).

권한(최소):

| 주체                        | 권한                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `jigak-model-refresh` (Job) | 이 버킷에 `roles/storage.objectUser`, 시크릿 `data-go-kr-service-key` 하나에 `secretAccessor` |
| `jigak-refresh-scheduler`   | 이 Job에 `roles/run.invoker`                                                                  |
| API 서비스 런타임 계정      | 이 버킷에 `roles/storage.objectViewer`                                                        |

비용·한도(모두 추정, 확인하지 않음): 저장 약 12GB로 월 1달러 안쪽. 할 일이 없는 실행은 1분, 학습 실행은 하루 한 번 30분 안팎(8 vCPU/32GiB, Cloud Run Job 상한)이라 월 수 달러 수준. 안전장치: `--tasks 1 --parallelism 1`, 작업 제한 3시간(실행 간격 4시간보다 짧아 겹치지 않음), 재시도 1회, Scheduler 하루 3회, 실행당 내려받기 상한 10GB(`MODEL_REFRESH_MODE=cloud`). 예산 알림은 결제 계정 권한이 필요해 스크립트에 넣지 않았습니다. 콘솔의 결제 > 예산에서 월 한도를 정하세요.

### 이미지

- 파일: `model-refresh/Dockerfile`. 빌드 컨텍스트는 **백엔드 저장소 루트**입니다: `docker build -f model-refresh/Dockerfile -t jigak-model-refresh:dev .`. `model-refresh/Dockerfile.dockerignore`가 컨텍스트를 Job 파일로 좁힙니다(실측 약 0.9MB). `python:3.14-slim-bookworm` 위에 `node:24`의 node 바이너리, 파이썬 의존성은 `model-refresh/scripts/requirements-spatial-eta.txt`, Node 의존성은 `model-refresh/package.json`의 `tsx`와 `zod`뿐입니다. API의 Nest·TypeORM은 설치하지 않습니다.
- 들어가는 것: `model-refresh/scripts`, `model-refresh/data-static`, 그리고 API 코드 중 Job이 import하는 것만(`src/common/engine/intelligence/`, `private-files.ts`, `realtime/bicycle-ride-times.ts`, `realtime/data/korea-holidays-*.json`). 빌드 마지막에 진입점 8개를 실제로 import하고 `incumbent-gate.py --help`로 학습기 두 개를 불러 봅니다. API 쪽 파일이 바뀌어 Job이 깨지면 이미지가 만들어지지 않습니다.
- 진입점은 `node --import tsx scripts/models-refresh.ts --store /models-store`(작업 폴더 `/app/model-refresh`)이고 뒤에 인자(`--plan`, `--only spatialBus`, `init --from-bundle …`)를 붙입니다.
- 고정 입력(TOPIS 도로 기준표, 역 좌표 CSV)은 저장소에 커밋돼 있고 이미지에도 들어갑니다(`model-refresh/data-static/README.md`에 출처·이용 조건·sha256). 러너는 스토어 `static/` → 스토어 `raw/context/`(예전 위치) → 커밋된 사본 순으로 찾고 sha256이 맞는 파일만 씁니다. `raw/`는 버킷 수명주기로 21일 뒤 지워지지만, 이제 그래도 멈추지 않습니다. `init`은 고정 입력을 `static/`에 씁니다. 예전의 `mvp/data` 복사와 `stage-context.sh`는 없어졌습니다.
- 로컬 확인(11/02 실측): 위 `docker build` 후 이미지 810MB. 번들로 `docker run --rm -v <폴더>:/models-store jigak-model-refresh:dev init --from-bundle /models-store/bootstrap`과 `verify`가 성공했고, 컨테이너 안에서 `JIGAK_HOLIDAY_DIR` 달력 반영과 빈 스토어의 고정 입력 준비도 확인했습니다. `--plan`은 외부 서버를 불러서 돌리지 않았습니다. 애플 실리콘에서 만든 이미지는 arm64입니다. Cloud Run용은 Cloud Build가 amd64로 다시 만듭니다.
- Job은 root로 돌립니다. Cloud Run의 버킷 볼륨은 기본 소유가 root이고 Job이 써야 해서입니다. 포트를 열지 않고 이 버킷 하나의 권한만 가집니다.

### 이미지 자동 빌드 (main 푸시 트리거)

백엔드 저장소는 `main` 푸시마다 Google Cloud 트리거로 API를 배포합니다. Job 이미지는 그것과 **다른 트리거**로 만듭니다. 설정은 Google Cloud 콘솔(Cloud Build > 트리거)에서 하고, 이 저장소에서는 확인하지 못했습니다.

| 트리거                           | 구성 파일                               | 포함 파일(`includedFiles`)                                                                                                                                                                                 | 제외 파일(`ignoredFiles`)                                           |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 기존 API 트리거                  | (지금 그대로)                           | (지금 그대로)                                                                                                                                                                                              | `model-refresh/**` 추가: Job만 바뀐 푸시가 API를 다시 배포하지 않게 |
| 새 Job 트리거(서울, `main` 푸시) | `model-refresh/cloudbuild.trigger.yaml` | `model-refresh/**`, `src/common/engine/intelligence/**`, `src/common/engine/private-files.ts`, `src/common/engine/realtime/bicycle-ride-times.ts`, `src/common/engine/realtime/data/korea-holidays-*.json` | 없음                                                                |

- `cloudbuild.trigger.yaml`은 이미지를 `jigak-model-refresh:<커밋>`과 `:latest`로 올리고 `gcloud run jobs update jigak-model-refresh --image …:<커밋>`을 실행합니다. Job은 먼저 있어야 합니다(`deploy/model-refresh-job.sh`가 한 번 만듦). 다음 실행부터 새 이미지가 쓰입니다.
- 트리거의 서비스 계정에는 `roles/artifactregistry.writer`, `roles/run.developer`, Job 서비스 계정(`jigak-model-refresh@…`)에 대한 `roles/iam.serviceAccountUser`가 필요합니다(일반 문서 기준, 실제로 만들어 보지 않음).
- 손으로 빌드할 때는 `gcloud builds submit . --region asia-northeast3 --config model-refresh/cloudbuild.yaml --substitutions _IMAGE=…`(배포 스크립트 6단계와 같음).

### 경보

- `jsonPayload.event="model-refresh-alert"` 로그(남은 시간 48시간 미만에서 갱신 실패, 또는 만료): `monitoring/alert-policy-refresh-alert.json`
- Job 실행 실패: 종료 코드가 0이 아니면 모두입니다(1 크래시, 2 남은 48시간 미만에서 갱신 실패나 만료, 3 `partial` = 한 멤버라도 `failed`/`closed`/`blocked`). Cloud Run은 셋 다 실패한 태스크 시도로 셉니다. `monitoring/alert-policy-job-failed.json`은 실패한 시도가 하나라도 생기면(5분 단위 합계 > 0) 걸리므로 첫 실패에서 바로 메일이 가고, 재시도를 기다리지 않습니다. Cloud Run은 이와 따로 `--max-retries 1`로 한 번 더 실행하고, 그 재시도도 실패하면 다시 조건에 걸립니다. 정책의 6시간 간격(`notificationRateLimit`)은 Google 문서상 로그 기반 정책용이라, 이 지표 정책에서 메일 수를 실제로 줄이는지는 확인하지 않았습니다. 공개 버스 후보가 기준 미달인 날처럼 `partial`이 이어지면 메일도 이어집니다. 일부 멤버만 실패해도 사람이 보도록 일부러 이렇게 둡니다.
- `/api/health`에 `"modelRefresh":{"status":"ok"` 가 없으면 알림: `monitoring/uptime-check-model-health.json`. API가 `--no-allow-unauthenticated`로 배포돼 있으면 업타임 체크가 들어갈 수 없으니, 공개 API일 때만 만듭니다.
- 알림 채널(이메일)은 사용자가 정한 주소로 만들어집니다. 정책 생성에는 `gcloud alpha/beta` 구성요소가 필요합니다.

## 롤백

```bash
# 로컬/컨테이너: 계획 출력, 이어서 실행
npm run models:rollback -- --store <폴더> --model spatialBus
npm run models:rollback -- --store <폴더> --model spatialBus --execute
# 클라우드: 같은 명령을 Job 인자로
gcloud run jobs execute jigak-model-refresh --region asia-northeast3 --args=rollback,--model,spatialBus,--execute --wait
```

롤백은 history 항목을 가리키는 새 세대를 만드는 일이라 서비스는 한 번의 확인(최대 60초) 안에 따라옵니다. 만료된 버전으로는 되돌아가지 않습니다. 버킷 객체 버전 관리로 manifest의 직전 객체도 14일 남습니다.

## 배포 전에 확인할 것 (문서로 확인했지만 실제로 해 보지는 못한 것)

1. 버킷 볼륨 마운트 옵션: Cloud Run 문서에서 gcloud는 `mount-options="A=1;B=2"`(세미콜론)이고 `implicit-dirs`는 기본 켜짐입니다. `metadata-cache-ttl-secs`는 예시에는 있고 지원 목록에는 없어서 쓰지 않았습니다. 서비스 쪽 갱신 지연은 기본 캐시 때문에 폴링 60초에 더해질 수 있습니다. 느리면 `cloud-run.ps1 -ModelMountOptions 'stat-cache-ttl=30s'`로 줄입니다.
2. 읽기 전용 마운트에 `roles/storage.objectViewer`, 읽기·쓰기에 `roles/storage.objectUser`가 문서의 권한입니다(스크립트는 이대로). 읽기 전용 마운트가 root 소유라서 서비스 사용자(`node`)가 읽을 수 있는지는 첫 배포에서 확인합니다. 못 읽으면 `-ModelMountOptions 'uid=1000;gid=1000'`.
3. gcsfuse는 파일 잠금이 없고 "마지막 쓰기가 이긴다"고 문서에 적혀 있습니다. 겹침 방지는 `locks/refresh.lock`(`wx` 생성)과 Job의 `--parallelism 1`, 실행 간격보다 짧은 작업 제한에 의존합니다. `wx`가 gcsfuse에서 "이미 있으면 실패"로 동작하는지는 첫 `--plan` 실행 전후로 확인합니다.
4. Scheduler가 `run.invoker`만으로 `jobs:run`을 호출할 수 있는지: 문서는 job 실행에 `roles/run.invoker`를 요구한다고만 적었습니다. 안 되면 `roles/run.developer`로 바꿉니다.
5. 서울 리전에서 T-DATA·NOAA·서울시 서버에 접속되는지, T-DATA 이용 조건(CC BY)으로 클라우드 가공이 되는지. 첫 Job `--plan` 실행 로그로 확인합니다.
6. Python 3.14의 amd64 휠(numpy 2.5.4, scipy 1.18.1, scikit-learn 1.9.1)은 존재함을 확인했습니다. Job 크기는 8 vCPU / 32GiB입니다(가공 workers 4 기준 측정 요청). 16GiB로 줄이려면 Job 환경변수에 `MODEL_REFRESH_WORKERS=1`을 넣습니다. 클라우드 학습 메모리와 시간은 실측하지 않았습니다. 첫 학습 실행에서 Cloud Run의 메모리 사용량을 보고 조정합니다.
7. 공간 버스·지하철 파일의 만료는 11/07 00:40·00:45이고, 재검증이 붙어도 파일 안 달력 끝 때문에 11/07 20:00을 넘지 못합니다. 그러니 **11/07 00:40 전에 새 학습이 승격돼야** 합니다. 갱신 창은 만료 120시간 전(11/02)부터 열려 있어 러너가 매 실행 시도합니다. 첫 클라우드 실행이 그 전에 나오려면 11/04까지 배포해야 합니다.

## 사용자가 해야 하는 일

1. 위 배포 승인(프로젝트 ID, 결제 계정, 알림 이메일).
2. data.go.kr "한국천문연구원_특일 정보" 활용신청. 신청 전에는 공휴일 달력이 비공식 교차 확인으로만 30일씩 연장됩니다.
3. 노선표가 빠진 날을 앞쪽 가까운 노선표에서 빌리는 정책(`nearest-consistent`) 채택 여부.

(재검증 자체는 사용자가 할 일이 없습니다. 새 모델이 못 이기는 날에도 서비스 중인 모델이 승격 게이트의 모든 구간을 통과하면 이어집니다. 다만 모델 파일의 공휴일 달력 끝과 학습 뒤 28일은 넘지 않습니다.)
