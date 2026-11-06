# 처음 한 번 설치 체크리스트

백엔드만 담은 저장소(`USWA-Ulsan-Small-Whale-Assosiation/jigak-backend`)의 클론과 GCP 프로젝트 owner 권한이 있는 팀원이 위에서부터 한 번 따라 하는 순서입니다. 이유와 자세한 설명은 [SERVER-GUIDE-2026-11-02.md](SERVER-GUIDE-2026-11-02.md)(줄여서 SG), [HANDOFF-2026-11-02.md](HANDOFF-2026-11-02.md), [MODEL-REFRESH.md](MODEL-REFRESH.md)에 있습니다.

- **기한: 11/04(수)까지 끝냅니다.** 공간 버스·지하철 개찰 모델이 **11/07 00:40 KST**에 만료되고, 그 전에 Job이 새 모델을 승격해야 합니다(11번).
- 모든 명령은 클론한 저장소 **루트**에서 실행합니다. `<...>`는 실제 값으로 바꿉니다. 비밀 값은 어디에도 적지 않습니다.
- 1·2번에서 만든 셸 변수(`BUNDLE`, `PROJECT`, `REGION`, `SERVICE`, `RUNTIME_SA`)와 9번의 `API`를 뒤에서 그대로 씁니다. 새 터미널을 열면 1·2번의 `export` 줄을 다시 실행합니다.

## 1. 준비물

- 도구: `gcloud`(owner 계정으로 `gcloud auth login`), PowerShell 7(`pwsh`, 7번에서 `deploy/cloud-run.ps1`), `bash`(Windows는 Git Bash나 WSL), `curl`, `jq`, `shasum`(Linux는 `sha256sum`). 알림 정책은 `gcloud components install alpha beta`가 필요합니다. Node 24.11 이상은 로컬에서 빌드·테스트할 때만 씁니다(`npm ci && npm run build && npm test`).
- 코드: `git clone https://github.com/USWA-Ulsan-Small-Whale-Assosiation/jigak-backend.git && cd jigak-backend` (`main`). 이미 있으면 `git checkout main && git pull`.
- 사용자에게 받는 것:

| 받는 것                                                                     | 쓰는 곳                                                                                                                                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maps-20261102.zip`                                                         | 5번(OSM 상세 지도, NGII 지도)                                                                                                                                                          |
| `model-store-bootstrap-20261102.zip`                                        | 6번(첫 세대). 풀면 `model-store-bootstrap/` 폴더가 나옵니다. 사용자가 모노레포에서 `npm --prefix jigak-backend run models:store:bundle -- --out <폴더>`로 만든 것이고 git에는 없습니다 |
| 비밀 값                                                                     | 3번, 6번                                                                                                                                                                               |
| `models-20261102.zip`, `ngii-derived-20261102.zip`, `OSRM.md`, `SHA256SUMS` | 자동 갱신이 안 될 때의 수동 대체(SG 4-4), NGII 보행 가중치(선택), 자체 OSRM(선택, SG 2-5). 받은 폴더에서 `shasum -a 256 -c SHA256SUMS`로 받은 파일이 OK인지 봅니다                     |

번들이 맞는지 확인합니다. `operational/`에 모델 5개, `references/spatialBus/`와 `references/railGate/`에 `<sha256>.json`이 하나씩, `context/`에 2개가 있어야 합니다. `references/`가 비어 있으면 첫 세대부터 재검증이 되지 않으니 사용자에게 다시 만들어 달라고 합니다.

```bash
export BUNDLE=<받은 model-store-bootstrap 폴더의 절대 경로>
ls "$BUNDLE"/operational "$BUNDLE"/references/spatialBus "$BUNDLE"/references/railGate "$BUNDLE"/context
```

## 2. 서울 리전과 공통 변수

모든 리소스는 **`asia-northeast3`(서울) 단일 리전**에 만듭니다. 멀티 리전, 다른 리전, CDN은 쓰지 않습니다. 지금 서비스 이름은 `perception-map`입니다(스크립트 기본값 `jigakmap-api`가 아님).

```bash
export PROJECT=<프로젝트 ID> REGION=asia-northeast3 SERVICE=perception-map
gcloud config set project $PROJECT
gcloud run services list --region $REGION          # perception-map이 보여야 합니다
export RUNTIME_SA=$(gcloud run services describe $SERVICE --region $REGION --format='value(spec.template.spec.serviceAccountName)')
echo $RUNTIME_SA                                    # ...@...iam.gserviceaccount.com
gcloud run services describe $SERVICE --region $REGION --format='value(spec.template.spec.containers[0].image)'
# 위 결과 asia-northeast3-docker.pkg.dev/<프로젝트>/<저장소>/... 의 <저장소>가 7번의 ArtifactRepository입니다
```

## 3. 비밀 (이름만)

| Secret Manager 비밀                                                                                               | 서비스 환경변수                                                                                                                  | 비고                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| (지금 쓰는 것)                                                                                                    | `KAKAO_REST_API_KEY`, `DATA_GO_KR_SERVICE_KEY`, `SEOUL_OPEN_API_KEY`, DB 비밀번호, `AUTH_TOKEN_ENCRYPTION_KEY` 외 지금 붙은 전부 | 7번에서 **모두 다시** 적습니다. 아래 `describe`로 이름:버전을 봅니다              |
| `jigakmap-kakao-rest-key-spare`, `jigakmap-data-go-kr-key-spare`, `jigakmap-seoul-open-api-key-spare` (새로 만듦) | `KAKAO_REST_API_KEY_SUB`, `DATA_GO_KR_SERVICE_KEY_FALLBACK`, `SEOUL_OPEN_API_KEY_FALLBACK`                                  | 선택이지만 권장. 11/01에 노출된 예비 Kakao 키는 쓰지 않고 새로 받은 값을 넣습니다 |
| `data-go-kr-service-key` (6번 스크립트가 만듦)                                                                    | Job의 `DATA_GO_KR_SERVICE_KEY`                                                                                                   | 갱신 Job 전용. 값은 6번에서 넣습니다                                              |

```bash
gcloud run services describe $SERVICE --region $REGION --format="yaml(spec.template.spec.containers[0].env)"
for s in jigakmap-kakao-rest-key-spare jigakmap-data-go-kr-key-spare jigakmap-seoul-open-api-key-spare; do
  gcloud secrets create $s --replication-policy=user-managed --locations=$REGION
  echo "$s 값을 붙여 넣고 Enter (화면에 안 보임):"
  read -rs KEY && printf %s "$KEY" | gcloud secrets versions add $s --data-file=- ; unset KEY
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor
done
```

## 4. API 서비스 설정 준비 (아직 배포하지 않음)

```bash
cp deploy/cloud-run.env.example.yaml deploy/cloud-run.env.yaml    # git에 올라가지 않는 파일
```

`deploy/cloud-run.env.yaml`에서 `REPLACE_*`를 모두 채웁니다(`DB_HOST`의 `/cloudsql/...`는 7번 `InstanceConnectionName`과 같아야 합니다). 그리고 **이미 있는 줄의 값을** 아래처럼 바꿉니다. `DATA_GO_KR_DAILY_LIMIT`만 예제에 줄이 없어 새로 더합니다. 같은 키를 두 번 쓰지 않고, 이 다섯 줄 끝에는 주석을 달지 않습니다(`cloud-run.ps1`이 값을 읽지 못해 멈춥니다). `PORT`는 넣지 않습니다. 배포는 환경변수 **전체를 이 파일로 교체**하므로 서비스에 필요한 값은 모두 이 파일에 있어야 합니다(SG 2-3).

```yaml
MOBILITY_SIMULATION: 'scooter,ebike'
MOBILITY_SIMULATION_WINDOW_DIR: '/sim-windows'
DATA_GO_KR_DAILY_LIMIT: '1000'
MODEL_MANIFEST_PATH: '/models/manifest.json'
MAP_NGII_PMTILES_PATH: '/maps/seoul-ngii-v1.pmtiles'
```

- `MOBILITY_SIMULATION`에 `scooter`나 `ebike`가 있으면 `cloud-run.ps1`이 2 CPU / 2Gi, min instances 1, CPU 상시 할당(`--no-cpu-throttling --cpu-boost`)을 붙입니다. startup probe(`/api/health/ready`)는 항상 붙습니다.
- `MOBILITY_SIMULATION_WINDOW_DIR`는 시뮬레이터 창 저장 버킷을 만들 때만 씁니다(권장, 서울·비공개·7일 수명주기). 만드는 명령은 SG 2-4에 있고, `<프로젝트>`는 `$PROJECT`, `<런타임 서비스 계정>`은 `$RUNTIME_SA`로 바꿉니다(`gs://$PROJECT-sim-windows`). 만들지 않으면 이 값을 `''`로 두고 7번에서 `SimulationWindowBucket = ''`, `MaxInstances = 2`로 둡니다.
- `MODEL_MANIFEST_PATH`는 6번 모델 버킷과, `MAP_NGII_PMTILES_PATH`는 5번 NGII 버킷과 짝입니다.
- `ETA_*_PATH`, `BICYCLE_RIDE_TIMES_PATH`는 `''` 그대로 둡니다(수동 대체 때만 채움).

## 5. 지도 타일

OSM 상세 지도는 **공개** 기본 지도 버킷에, NGII 지도는 **비공개 서울 버킷**에만 둡니다. NGII는 국외 반출 금지라 공개 권한(`allUsers`), 버킷 CORS, Cloud CDN, 다른 리전에 절대 두지 않습니다. 앱은 API를 거쳐서만 NGII를 읽습니다. zip은 **저장소 밖**(아래 `~/jigak-maps`)에 풉니다. 저장소 안에 풀면 실수로 커밋·푸시돼 GitHub(국외)로 나갈 수 있습니다.

```bash
unzip <받은 폴더>/maps-20261102.zip -d ~/jigak-maps && (cd ~/jigak-maps && shasum -a 256 -c SHA256SUMS.txt)
export MAPS=~/jigak-maps
# OSM 상세 지도: 기존 공개 버킷
gcloud storage cp $MAPS/korea-detail-v1.pmtiles gs://jigak-bucket1/
gcloud storage objects update gs://jigak-bucket1/korea-detail-v1.pmtiles --cache-control="public, max-age=3600"
gcloud storage buckets describe gs://jigak-bucket1 --format="default(cors_config)"   # CORS가 없으면 SG 3절의 cors.json(덮어쓰기 전에 사용자에게 확인)
# NGII: 서울 비공개 버킷, 런타임 서비스 계정만 읽기
gcloud storage buckets create gs://$PROJECT-ngii-kr --location=$REGION --uniform-bucket-level-access --public-access-prevention
gcloud storage cp $MAPS/seoul-ngii-v1.pmtiles gs://$PROJECT-ngii-kr/
gcloud storage buckets add-iam-policy-binding gs://$PROJECT-ngii-kr --member=serviceAccount:$RUNTIME_SA --role=roles/storage.objectViewer
gcloud storage buckets describe gs://$PROJECT-ngii-kr --format="value(location,locationType,public_access_prevention)"   # ASIA-NORTHEAST3 region enforced
```

## 6. 모델 버킷, 갱신 Job, Scheduler

`deploy/model-refresh-job.sh` 한 번으로 버킷 `gs://$PROJECT-jigak-models`, 서비스 계정, 비밀, Job 이미지(`model-refresh/Dockerfile`), Job `jigak-model-refresh`(8 vCPU / 32Gi), 첫 세대(번들 업로드 후 `init --from-bundle`), Scheduler(05:30·09:30·13:30 KST), `--plan` 실행, 알림을 만듭니다. 학습 고정 입력(TOPIS 도로 기준표, 역 좌표)은 `model-refresh/data-static/`에 커밋돼 있어 따로 올릴 것이 없습니다.

```bash
# 계획만 출력(gcloud를 부르지 않음). 12단계 계획을 읽어 봅니다.
bash deploy/model-refresh-job.sh --project $PROJECT --service $SERVICE --bundle "$BUNDLE" --alert-email <알림 메일> --api-host <API 호스트 이름>
# 실행
bash deploy/model-refresh-job.sh --project $PROJECT --service $SERVICE --bundle "$BUNDLE" --alert-email <알림 메일> --api-host <API 호스트 이름> --apply
```

- `--api-host`는 `https://` 없이 호스트 이름만 씁니다(예: `api.example.com`). 둘 다 선택이고 빼면 그 단계만 건너뜁니다.
- **처음 `--apply`는 5단계에서 `exit 1`로 멈추는 것이 정상입니다**(Job용 키가 아직 없음). 아래 첫 줄로 data.go.kr 키를 넣고(입력이 화면에 안 보임), 같은 옵션에 `--from-step 6`을 더해 이어 갑니다.
  ```bash
  read -rs KEY && printf %s "$KEY" | gcloud --project $PROJECT secrets versions add data-go-kr-service-key --data-file=- ; unset KEY
  bash deploy/model-refresh-job.sh --project $PROJECT --service $SERVICE --bundle "$BUNDLE" --alert-email <알림 메일> --api-host <API 호스트 이름> --from-step 6 --apply
  ```
- 어느 단계에서든 실패하면 고친 뒤 `--from-step <그 단계 번호> --apply`로 이어 갑니다. 이미 있는 리소스는 건너뜁니다. 단 12단계(알림)는 매번 새로 만드니, 12단계까지 한 번 끝난 뒤 다시 돌릴 때는 `--alert-email`을 뺍니다.
- 확인: 버킷에 `manifest.json`, `static/`(파일 2개), `references/spatialBus/`·`references/railGate/`가 있어야 하고, `verify` 실행이 성공(종료 0, 로그 `model-manifest-verified`의 `ok: true`)해야 합니다.
  ```bash
  gcloud storage ls gs://$PROJECT-jigak-models/ gs://$PROJECT-jigak-models/static/ gs://$PROJECT-jigak-models/references/
  gcloud run jobs execute jigak-model-refresh --region $REGION --args=verify --wait
  ```

## 7. API 배포 (4번 설정 + 버킷 연결)

PowerShell에서 실행합니다. 스크립트가 이 클론으로 이미지를 빌드하고, migration Job을 돌린 뒤 서비스를 배포합니다. 클론이 `main` 최신인지 먼저 확인합니다.

```powershell
$P = '<프로젝트 ID>'
$deployment = @{
  ProjectId = $P; Region = 'asia-northeast3'; Service = 'perception-map'
  ArtifactRepository = '<2번에서 본 저장소 이름>'; ImageTag = 'release-20261102-1'
  InstanceConnectionName = "${P}:asia-northeast3:<SQL 인스턴스>"
  ServiceAccount = '<2번의 RUNTIME_SA>'
  DbPasswordSecret = '<비밀>:<버전>'; AuthEncryptionKeySecret = '<비밀>:<버전>'
  SecretBindings = @{
    # 3번 describe에 나온 비밀을 전부 이름:숫자버전으로 적습니다(latest 불가). 여기 없는 비밀은 서비스에서 빠집니다.
    # DB_PASSWORD, AUTH_TOKEN_ENCRYPTION_KEY는 위 두 줄로 붙으니 여기 다시 쓰지 않습니다.
    KAKAO_REST_API_KEY = '<비밀>:<버전>'
    DATA_GO_KR_SERVICE_KEY = '<비밀>:<버전>'
    SEOUL_OPEN_API_KEY = '<비밀>:<버전>'
    # SEOUL_BIKE_API_KEY, SEOUL_CITY_DATA_API_KEY, TRAFFIC_SIGNAL_API_KEY 등 지금 붙은 나머지도 같은 형식으로
    KAKAO_REST_API_KEY_SUB = 'jigakmap-kakao-rest-key-spare:1'
    DATA_GO_KR_SERVICE_KEY_FALLBACK = 'jigakmap-data-go-kr-key-spare:1'
    SEOUL_OPEN_API_KEY_FALLBACK = 'jigakmap-seoul-open-api-key-spare:1'
  }
  MaxInstances = 2; MinInstances = -1
  SimulationWindowBucket = "$P-sim-windows"     # 창 버킷을 안 만들었으면 '' (그리고 WINDOW_DIR도 '')
  ModelBucket = "$P-jigak-models"; MapBucket = "$P-ngii-kr"
  AllowUnauthenticated = $true
}
./deploy/cloud-run.ps1 @deployment -PlanOnly   # 계획 확인
./deploy/cloud-run.ps1 @deployment             # 실제 배포
```

계획(인자마다 작은따옴표로 찍힘)에 `--cpu 2 --memory 2Gi`, `--min-instances 1`, `--no-cpu-throttling --cpu-boost`, `--startup-probe httpGet.path=/api/health/ready,...`, `--env-vars-file .../cloud-run.env.yaml`, 볼륨 `name=models`(`/models`, 읽기 전용), `name=maps`(`/maps`, 읽기 전용), `name=sim-windows`가 있어야 합니다. 스크립트는 `MODEL_MANIFEST_PATH`·`-ModelBucket`, `MAP_NGII_PMTILES_PATH`·`-MapBucket`, `MOBILITY_SIMULATION_WINDOW_DIR`·`-SimulationWindowBucket` 짝이 안 맞으면 멈춥니다. 볼륨이 "이미 있음"으로 실패하면 SG 2-6 끝의 메모를 봅니다.

## 8. Cloud Build 트리거 (콘솔: Cloud Build > 트리거)

`main` 푸시는 기존 트리거로 API를 자동 배포합니다. Job 이미지는 별도 트리거로 만듭니다(MODEL-REFRESH.md "이미지 자동 빌드").

1. **기존 API 트리거 수정:** "무시된 파일 필터"(Ignored files filter)에 `model-refresh/**`를 더합니다. 같은 화면에서 배포 단계가 이미지(`--image`)만 바꾸는지 봅니다. `--env-vars-file`, `--set-env-vars`, `--set-secrets`, `--clear-volumes`가 있으면 7번 설정이 푸시마다 지워지니 사용자에게 알립니다. 목록: `gcloud builds triggers list --region=$REGION`(없으면 `--region` 없이).
2. **새 Job 트리거:** 이벤트 "브랜치로 푸시"(Push to a branch), 저장소 `jigak-backend`(기존 API 트리거와 같은 연결), 브랜치 `^main$`, 리전 `asia-northeast3`(그 리전에서 저장소가 안 보이면 기존 API 트리거와 같은 리전), 구성 "Cloud Build 구성 파일"(Cloud Build configuration file) `model-refresh/cloudbuild.trigger.yaml`, 서비스 계정은 아래 3에서 권한을 줄 계정, "포함된 파일 필터"(Included files filter):
   `model-refresh/**`, `src/common/engine/intelligence/**`, `src/common/engine/private-files.ts`, `src/common/engine/realtime/bicycle-ride-times.ts`, `src/common/engine/realtime/data/korea-holidays-*.json`
3. 새 트리거의 서비스 계정 권한:
   ```bash
   TRIGGER_SA=<새 트리거에 지정한 서비스 계정 이메일>
   gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$TRIGGER_SA --role=roles/artifactregistry.writer
   gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$TRIGGER_SA --role=roles/run.developer
   gcloud iam service-accounts add-iam-policy-binding jigak-model-refresh@$PROJECT.iam.gserviceaccount.com --member=serviceAccount:$TRIGGER_SA --role=roles/iam.serviceAccountUser
   ```
4. 시험: 콘솔에서 새 트리거 "실행"(브랜치 `main`). 빌드가 끝나면 `gcloud run jobs describe jigak-model-refresh --region $REGION | grep -i image`가 `jigak-model-refresh:<커밋 앞 7자>`를 가리켜야 합니다.

## 9. 첫 Job 실행과 `/api/health` 읽기

6번 스크립트의 10단계가 `--plan`을 이미 한 번 돌렸습니다. 다시 볼 때와 실제 실행은 아래와 같습니다.

```bash
gcloud run jobs execute jigak-model-refresh --region $REGION --args=--plan --wait     # 할 일 목록만, 아무것도 바꾸지 않음
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="jigak-model-refresh" AND jsonPayload.event="model-refresh-plan"' --limit 1 --freshness 1h --format=json
gcloud run jobs execute jigak-model-refresh --region $REGION                            # 실제 실행(학습이면 30분 안팎, 추정)
gcloud run jobs executions list --job jigak-model-refresh --region $REGION --limit 3   # 성공 여부
```

종료 코드: 0 정상(승격 또는 할 일 없음), 3 일부 모델 실패, 2 만료 48시간 안 갱신 실패, 1 크래시. 0이 아니면 버킷의 `runs/<runId>/report.json`과 로그를 봅니다(SG 6절 "Job 실패").

```bash
export API=https://<API 도메인>
curl -s -o /dev/null -w '%{http_code}\n' $API/api/health/ready     # 시뮬레이터 창 계산 중 503, 준비되면 200
curl -s $API/api/health | jq '{mode,
  models: {publicBus: .models.publicBus.active, spatialBus: .models.publicBus.spatial.active, railGate: .models.railGate.active, bicycleRide: .models.bicycleRide.active},
  modelRefresh: (.modelRefresh | {status, reasons, generation: .manifest.generation, error: .manifest.error}),
  ngii: .maps.ngii,
  simulation: (.simulation | {enabled, ready, status, source, windowStore, fleetByType})}'
curl -s $API/api/models/refresh | jq '{status, reasons, manifest, lastRun, nextScheduledAt}'
```

| 항목                  | 정상                                                                                                     | 아니면                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `mode`                | `live-ready`                                                                                             | 키 비밀(3번, 7번)                                                            |
| `models.*`            | 모두 `true`                                                                                              | `modelRefresh.reasons`                                                       |
| `modelRefresh.status` | `ok`(첫 실행 전에는 `stale`), `generation` 1 이상, `error` `null`                                        | `unconfigured`: `MODEL_MANIFEST_PATH` 빠짐. `degraded`: `reasons`(SG 6절 표) |
| `ngii`                | `{"configured": true, "available": true}`                                                                | `configured: false`: 변수 빠짐. `available: false`: `/maps` 볼륨·권한        |
| `simulation`          | `enabled: true`, `ready: true`, `windowStore: "configured"`, `fleetByType` 킥보드 14933·전기자전거 52605 | 5분 넘게 `building`이면 SG 6절                                               |

NGII 주소 확인과 경로 검색 표본은 SG 3절 "확인", 5절에 있습니다.

## 10. 앱 빌드 환경 (사용자에게 전달)

```bash
EXPO_PUBLIC_API_URL=https://<API 도메인>
EXPO_PUBLIC_MAP_DETAIL_TILES_URL=https://storage.googleapis.com/jigak-bucket1/korea-detail-v1.pmtiles
EXPO_PUBLIC_MAP_NGII_TILES_URL=https://<API 도메인>/api/maps/seoul-ngii-v1.pmtiles
```

**새 앱은 이 백엔드와 같이 나가야 합니다.** 옛 앱은 새 서버 응답을 거부하고 "올바른 자료를 보내지 않았어요"를 띄우고, 새 앱은 옛 서버를 읽지 못합니다. 순서는 서버 배포 → 9번 확인 통과 → 서버 커밋 해시와 API 주소를 사용자에게 보냄 → 사용자가 같은 커밋으로 앱 빌드입니다. `main` 푸시가 곧 서버 교체이니 푸시 시점을 사용자와 맞춥니다. 심사 기기에는 새 빌드만 설치합니다.

## 11. 기한 (KST)

| 언제            | 무엇                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| 11/04           | 1~10번 완료. 그래야 만료 전에 Scheduler 실행이 여러 번 돌아 첫 성공 승격이 나옵니다                              |
| 11/05 12:51     | 공개 버스 모델 파일 만료(자동 갱신이 대신함)                                                                     |
| **11/06**       | **대회 제출.** 서버, 지도, 모델, 앱 빌드가 같은 커밋이어야 합니다                                                |
| **11/07 00:40** | 공간 버스(00:40)·지하철 개찰(00:45) 만료. **그 전에 Job이 새 모델을 승격해야 합니다.** 아래 명령으로 매일 봅니다 |

```bash
# 시각은 UTC(KST는 +9시간). 재검증만으로는 2026-11-07T11:00Z(=11/07 20:00 KST)를 넘지 못하므로, 그보다 뒤면 새 모델이 승격된 것입니다
curl -s $API/api/health | jq -c '[.models.publicBus.spatial, .models.railGate] | map({active, expiresAt: (if .expiresAt then (.expiresAt/1000|floor|todate) else null end), expirySource})'
```

만료돼도 서버는 멈추지 않고 공급자 시간으로 돌아갑니다(정확도만 떨어짐). 11/04까지 Job이 서지 않으면 SG 4-4의 수동 대체로 시간을 벌고 사용자에게 바로 알립니다.

## 12. 문제가 생기면 (되돌리기)

```bash
# API: 이전 리비전으로 트래픽 100%. 서버를 되돌리면 앱도 그 시점 빌드로 되돌립니다
gcloud run revisions list --service $SERVICE --region $REGION
gcloud run services update-traffic $SERVICE --region $REGION --to-revisions <이전 리비전>=100
# 모델: 이전 버전으로(첫 줄은 계획만, 둘째 줄이 실행). 키: publicBus, spatialBus, railGate, bicycleRide
gcloud run jobs execute jigak-model-refresh --region $REGION --args=rollback,--model,spatialBus --wait
gcloud run jobs execute jigak-model-refresh --region $REGION --args=rollback,--model,spatialBus,--execute --wait
# Job 이미지: 이전 이미지로
gcloud artifacts docker images list $REGION-docker.pkg.dev/$PROJECT/jigak/jigak-model-refresh --include-tags
gcloud run jobs update jigak-model-refresh --region $REGION --image <이전 이미지 주소>
# 자동 실행 잠시 멈춤 / 다시 시작
gcloud scheduler jobs pause jigak-model-refresh --location $REGION
gcloud scheduler jobs resume jigak-model-refresh --location $REGION
```

- 설치 스크립트 실패: 고친 뒤 `bash deploy/model-refresh-job.sh ... --from-step <N> --apply`.
- 증상별 확인(503 지속, 메모리, Kakao 한도, `degraded`, Job exit 1·2·3, 지도 안 뜸, "올바른 자료를 보내지 않았어요"): SG 6절 표.
- 끝나면 사용자에게 서버 커밋 해시, API 주소, 9번 health 결과를 보냅니다.
