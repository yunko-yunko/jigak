# 서버 담당 가이드 2026-11-02

서버를 맡은 팀원이 할 일은 네 가지입니다. 최신 코드를 받고, 백엔드를 다시 배포하고, 지도 타일을 올리고, 모델을 올립니다. 이 문서만 보고 순서대로 하면 되도록 명령과 파일 이름, 환경변수 이름을 그대로 적었습니다. 배경이 더 필요하면 [DEPLOYMENT.md](DEPLOYMENT.md), [HANDOFF-2026-11-02.md](HANDOFF-2026-11-02.md), [MODEL-REFRESH.md](MODEL-REFRESH.md)를 봅니다.

## 기한

| 날짜 (KST)      | 일                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11/04까지       | 서버 재배포와 모델 자동 갱신 Job 설치를 끝냅니다. 11/07 만료 전에 첫 성공 갱신이 나오려면 이 날짜가 마지노선입니다.                                                                                             |
| 11/05 12:51     | 공개 버스 모델(`public-bus-operational.json`) 만료                                                                                                                                                              |
| **11/07 00:40** | 공간 버스 모델(`spatial-bus-operational.json`) 만료. 갱신이 없으면 이 시각부터 서버가 공급자 시간으로 돌아갑니다. **이 시각 전에 새 학습이 승격돼야 합니다**(자동 갱신 Job이 매 실행 시도합니다).               |
| 11/07 00:45     | 지하철 개찰 모델(`rail-gate-operational.json`) 만료                                                                                                                                                             |
| 11/07 20:00     | 두 파일에 든 공휴일 달력(11/07까지)의 끝에서 4시간 앞. 이때의 요청이 자정 넘어 탈 차까지 예측해야 해서 여유를 둡니다. 재검증(4절)으로 만료가 늘어나도 이 시각은 넘지 못하고, 서버도 이 시각에 두 모델을 끕니다. |
| 11/15 00:00     | 따릉이 공간 모델과 공휴일 달력 검토 기한                                                                                                                                                                        |
| **11/06**       | **제출.** 그 전에 서버, 지도, 모델, 앱 빌드가 모두 같은 커밋으로 맞아야 합니다.                                                                                                                                 |

만료돼도 서버가 멈추지는 않습니다. 정확도만 떨어지고 `/api/health`가 `degraded`로 보입니다.

## 0. 받을 것과 준비

- 코드: 브랜치 `dev`입니다(`dev2` → `dev` PR이 합쳐진 뒤). 이미 클론이 있으면 `git checkout dev && git pull`.
  ```bash
  git clone -b dev <저장소 주소> perception-map
  cd perception-map/jigak-backend
  ```
- 사용자에게 따로 받는 것: 모델 번들 `dist/handoff-20261102/model-store-bootstrap`, 지도 파일 `korea-detail-v1.pmtiles`와 `seoul-ngii-v1.pmtiles`, 비밀 값(키 6개 안팎), `OSRM.md`(자체 OSRM을 쓸 때).
- 도구: `gcloud`(로그인됨), Node 24.11 이상, PowerShell(`cloud-run.ps1`), Docker(OSRM 서버를 띄울 때).
- 비밀 값은 이 문서에도 저장소에도 적지 않습니다. 셸 기록에 남지 않게 표준 입력으로 넣습니다.

## 1. 이번에 바뀐 것

**앱과 서버는 같이 배포합니다.** 이전 앱 빌드는 새 서버 응답을 `invalid-response`로 거부하고 "올바른 자료를 보내지 않았어요"를 띄웁니다. 반대로 새 앱은 옛 서버(지금 Cloud Run `perception-map`)의 응답 형식을 모릅니다. 순서는 서버 배포 → 5절 점검 통과 → 사용자에게 알림 → 사용자가 같은 커밋으로 앱 빌드입니다.

### 백엔드 기능

| 영역                   | 내용                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 공유 킥보드·전기자전거 | 시연용 가상 차량(`MOBILITY_SIMULATION`)을 서울 실제 등록 대수로 늘렸습니다(킥보드 14,933대, 전기자전거 52,605대). 유동인구로 배치하고 합법 반납 지점(문 앞, 보행 가중치, 반납 금지 구역)으로 안내합니다. `/api/sim/*`가 열립니다.    |
| 시간                   | 모든 공유 대여의 대여+반납은 합쳐서 1분입니다. 킥보드 14–20 km/h, 전기자전거 17–21 km/h. 대기 1분 이상은 체인에 "대기 N분"으로 나옵니다.                                                                                             |
| 경로 순위              | 추천과 탭 대표 경로 모두 실제 도착 시각만으로 고릅니다(순위 비용 없음, 사용자 결정 D1). 두 번째 대여나 택시 뒤 탑승도 더 빠르면 고릅니다. 걸어가는 편이 2분 안쪽으로만 느린 짧은 탑승은 지웁니다(걷기 대안이 실제로 있을 때만). 달리기 경로의 `rideKey`는 `'run'`입니다. |
| 전기자전거             | 요청의 `preferences`에 `allowEbike`가 없고 `hasScooterLicense`도 없으면 옛 앱으로 보고 전기자전거를 끕니다. 현재 앱은 항상 `allowEbike`를 보냅니다.                                                                                  |
| 장소 검색              | 전국 검색, 역 목록(`place-stations-v1.json`), 별칭("홍대", "건대")을 지원합니다.                                                                                                                                                     |
| 지하철 출구            | "N번 출구" 단계와 출구 기준 도보(`seoul-subway-exits-v1.json`).                                                                                                                                                                      |
| Kakao                  | 실패하면 경로·상태·코드를 한 줄로 로그에 남깁니다(키는 가림). 네트워크 오류, 타임아웃, 5xx는 300–600 ms 뒤 한 번 다시 시도합니다. 기본 키가 한도에 걸리거나 거부되면 예비 키로 넘깁니다.                                             |
| 버스 한도              | 오퍼레이션·키별 하루 상한(`DATA_GO_KR_DAILY_LIMIT`, 기본 1000). 80%에서 주변 교통이, 95%에서 경로 검색이 배차 기준 대기로 바뀌고, 다 쓰면 예비 키로 넘어갑니다. 0시 KST에 초기화됩니다. 도착 캐시는 30초.                            |
| 모델 자동 갱신         | 서울 버킷의 Cloud Run Job이 하루 세 번 모델을 다시 학습·평가·승격하고, 서비스는 `manifest.json`을 따라 재시작 없이 바꿉니다. 4절.                                                                                                    |

### API 응답 변경 (앱이 엄격하게 검증하는 것)

- `/api/health`: 버스 상태에 `quota`가 생겼습니다(`resetsAt` 포함). 모델마다 `trainedAt`, `expiresAt`, `sha256`, `origin`, `manifestGeneration`, `promotedAt`, `previousVersion`, `expirySource`, `revalidatedAt`가 붙고, 최상위에 `modelRefresh`가 생겼습니다. `simulation.windowStore`, `simulation.fleetByType`도 새로 있습니다.
- `/api/health/ready`: 시뮬레이터가 켜져 있으면 오늘 창이 준비될 때까지 503(`status: "starting"`)입니다.
- 새 엔드포인트: `/api/models/refresh`, `/api/sim/status`, `/api/maps/seoul-ngii-v1.pmtiles`(NGII 지도, Range만). `/api/health`에 `maps.ngii`(`configured`, `available`)가 생겼습니다. 경로는 나오지 않습니다.
- 새 이동수단 종류 `ebike`, 지하철 출구 필드, 경로 단계의 "대기 N분". 옛 앱은 이를 거부합니다.
- DB 마이그레이션은 이번에 추가되지 않았습니다. 최초 설치는 `1793232000000-initial-orm-schema.ts` 하나입니다(2절).

## 2. 재배포 전에 할 일

체크리스트로 씁니다.

- [ ] 코드를 받고 데이터 파일 확인, 빌드, 테스트
- [ ] 비밀 확인과 예비 키 등록
- [ ] `deploy/cloud-run.env.yaml` 작성
- [ ] 버킷 만들기(시뮬레이터 창, 모델, NGII 지도는 비공개)
- [ ] OSRM 서버(선택, 권장)
- [ ] `-PlanOnly`로 계획 확인 후 배포

### 2-1. 코드와 데이터 파일

새로 추가된 데이터 파일이 빠지면 해당 기능이 조용히 꺼집니다. 이미지에는 `npm run build`의 `copy-assets.mjs`가 넣습니다.

```bash
cd jigak-backend
ls src/common/engine/realtime/data/shared-mobility-return-rules-v1.json \
   src/common/engine/realtime/data/shared-mobility-door-points-v1.json \
   src/common/engine/realtime/data/shared-mobility-demand-v1.json \
   src/common/engine/realtime/data/shared-mobility-foot-weights-osm-v1.json \
   src/common/engine/realtime/data/seoul-pm-parking-rules-v1.json \
   src/common/engine/connectivity/data/seoul-subway-exits-v1.json \
   src/modules/places/data/place-stations-v1.json
npm ci && npm run build && npm test
```

기본 유동인구 가중치는 OSM 기반 `shared-mobility-foot-weights-osm-v1.json`입니다. 예전 문서의 `shared-mobility-foot-weights-v1.json`은 없는 이름입니다.

### 2-2. 비밀 (Secret Manager → `SecretBindings`, env yaml에는 넣지 않음)

| 이름                                     | 필수       | 용도                                                                     |
| ---------------------------------------- | ---------- | ------------------------------------------------------------------------ |
| `KAKAO_REST_API_KEY`                     | 필수       | 장소·길찾기                                                              |
| `KAKAO_REST_API_KEY_SUB`            | 선택(권장) | 기본 키가 한도·거부일 때의 예비 키. 로그인 키와 별개                     |
| `DATA_GO_KR_SERVICE_KEY`                 | 필수       | 서울 버스, TAGO 버스                                                     |
| `DATA_GO_KR_SERVICE_KEY_FALLBACK`        | 선택(권장) | 다른 공공데이터포털 계정의 키. 버스 일일 한도를 다 쓰면 0시 KST까지 사용 |
| `SEOUL_OPEN_API_KEY`                     | 필수       | 지하철 실시간                                                            |
| `SEOUL_OPEN_API_KEY_FALLBACK`            | 선택(권장) | 지하철이 `ERROR-337`(일일 한도)일 때 사용                                |
| DB 비밀번호, `AUTH_TOKEN_ENCRYPTION_KEY` | 필수       | `-DbPasswordSecret`, `-AuthEncryptionKeySecret`로 연결                   |

> 보안: 11/01 작업 중 예비 Kakao 키 값이 에이전트 출력에 한 번 찍혔습니다. 그 값은 쓰지 말고 사용자에게 새로 발급받은 키를 받습니다.

```bash
gcloud secrets create jigakmap-kakao-rest-key-spare --replication-policy=user-managed --locations=asia-northeast3
gcloud secrets versions add jigakmap-kakao-rest-key-spare --data-file=-     # 값을 붙여 넣고 Ctrl-D
gcloud secrets add-iam-policy-binding jigakmap-kakao-rest-key-spare \
  --member=serviceAccount:<런타임 서비스 계정> --role=roles/secretmanager.secretAccessor
# jigakmap-data-go-kr-key-spare, jigakmap-seoul-open-api-key-spare 도 같은 방식입니다.
```

`cloud-run.ps1`은 `--set-secrets`로 비밀 전체를 **교체**합니다. 지금 서비스에 붙은 기존 비밀(`SEOUL_BIKE_API_KEY`, `SEOUL_CITY_DATA_API_KEY`, `TRAFFIC_SIGNAL_API_KEY` 등)을 `SecretBindings`에 모두 다시 적습니다. 값은 `이름:숫자버전` 형식이고 `latest`는 안 됩니다. 현재 붙은 목록은 다음으로 봅니다.

```bash
gcloud run services describe perception-map --region asia-northeast3 --format="yaml(spec.template.spec.containers[0].env)"
```

### 2-3. 환경변수 (`deploy/cloud-run.env.yaml`)

```powershell
Copy-Item deploy/cloud-run.env.example.yaml deploy/cloud-run.env.yaml    # git에 없는 파일입니다
```

`REPLACE_*`를 모두 채워야 스크립트가 진행합니다. `PORT`는 넣지 않습니다. **`cloud-run.ps1`은 `--env-vars-file`로 환경변수 전체를 교체합니다.** `gcloud run services update --update-env-vars`로만 넣은 값은 다음 배포 때 사라지므로 모두 이 파일에 적습니다.

기존 변수 중 채울 값:

| 이름                   | 예                                            | 설명                                                                                                                                                             |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_HOST`              | `/cloudsql/프로젝트:asia-northeast3:인스턴스` | `-InstanceConnectionName`과 같아야 합니다                                                                                                                        |
| `CORS_ORIGINS`         | `https://app.example.com`                     | 쉼표로 여러 개. 정확한 origin(경로 없음), 운영은 HTTPS만 허용. 웹에서 앱을 열 주소를 모두 넣습니다. 기본값은 `http://localhost:8081,http://127.0.0.1:8081`입니다 |
| `AUTH_PUBLIC_BASE_URL` | `https://api.example.com`                     | API 공개 주소                                                                                                                                                    |
| `AUTH_WEB_RETURN_URL`  | `https://app.example.com/`                    | 로그인 뒤 돌아갈 웹 주소                                                                                                                                         |
| `PEDESTRIAN_OSRM_URL`  | `http://10.0.0.5:5011/route/v1/foot`          | 빈 값이면 공개 FOSSGIS(느림, 프로세스당 초당 1회). 2-5                                                                                                           |
| `BICYCLE_OSRM_URL`     | `http://10.0.0.5:5002/route/v1/bike`          | 같음                                                                                                                                                             |

이번에 새로 생긴 변수:

| 이름                                                                                                                                               | 권장 값                                  | 설명                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MOBILITY_SIMULATION`                                                                                                                              | `'scooter,ebike'`                        | 시연용 가상 차량. 빈 값이면 꺼짐이고 `/api/sim/*`도 닫힙니다                                                                                                                                           |
| `MOBILITY_SIMULATION_FLEET`                                                                                                                        | `''`                                     | 킥보드 대수(3000–72000). 빈 값 = 14933                                                                                                                                                                 |
| `MOBILITY_SIMULATION_EBIKE_FLEET`                                                                                                                  | `''`                                     | 전기자전거 대수(1000–60000). 빈 값 = 52605. 두 차종 합계는 3000–72000                                                                                                                                  |
| `MOBILITY_SIMULATION_SEED`                                                                                                                         | `'jigak'`                                | 모든 인스턴스가 같은 상태를 계산하게 둡니다                                                                                                                                                            |
| `MOBILITY_SIMULATION_WINDOW_DIR`                                                                                                                   | `'/sim-windows'`                         | 하루치 창 저장 위치. `-SimulationWindowBucket`과 반드시 함께 쓰고, 하나만 있으면 스크립트가 멈춥니다                                                                                                   |
| `MOBILITY_SIMULATION_READY_GATE`                                                                                                                   | `''`                                     | 빈 값 = `true`. 오늘 창이 준비될 때까지 `/api/health/ready`가 503                                                                                                                                      |
| `MOBILITY_FOOT_WEIGHTS_PATH`                                                                                                                       | `''`                                     | 빈 값 = 저장소의 OSM 가중치. NGII 판(`ngii-derived-20261102.zip`)은 서울 리전 비공개 버킷 볼륨에만 두고 절대 경로를 넣습니다. 읽지 못하면 서버가 시작하지 않습니다. 필수가 아니므로 기본은 비워 둡니다 |
| `DATA_GO_KR_DAILY_LIMIT`                                                                                                                           | `'1000'`                                 | 버스 오퍼레이션·키별 하루 상한. `0` = 무제한. **인스턴스마다 따로 셉니다.**                                                                                                                            |
| `MAP_NGII_PMTILES_PATH`                                                                                                                            | `'/maps/seoul-ngii-v1.pmtiles'`          | NGII 지도를 API가 Range로 내려줍니다(3절). `-MapBucket`과 반드시 함께 쓰고, 하나만 있으면 스크립트가 멈춥니다. 빈 값이면 `/api/maps/seoul-ngii-v1.pmtiles`가 404입니다                                 |
| `MODEL_MANIFEST_PATH`                                                                                                                              | `'/models/manifest.json'`                | 4절의 자동 갱신을 쓸 때 **정확히 이 값**이어야 합니다. `-ModelBucket`을 쓰면 반드시 필요하고, 쓰지 않으면 빈 값이어야 합니다                                                                           |
| `MODEL_MANIFEST_POLL_SECONDS`                                                                                                                      | `''`                                     | 빈 값 = 60초                                                                                                                                                                                           |
| `MODEL_REFRESH_STATUS_PATH`                                                                                                                        | `''`                                     | 빈 값 = manifest와 같은 폴더의 `refresh-status.json`                                                                                                                                                   |
| `MODEL_REFRESH_SCHEDULE_KST`                                                                                                                       | `''`                                     | 빈 값 = `05:30,09:30,13:30`                                                                                                                                                                            |
| `ETA_PUBLIC_BUS_MODEL_PATH`, `ETA_SPATIAL_BUS_MODEL_PATH`, `ETA_RAIL_GATE_MODEL_PATH`, `ETA_SPATIAL_BICYCLE_MODEL_PATH`, `BICYCLE_RIDE_TIMES_PATH` | 자동 갱신: `''` / 수동: `/models/<파일>` | 4-4의 수동 대체 방식에서만 채웁니다. 자동 갱신에서는 manifest에 없는 모델의 대체 경로로만 쓰입니다                                                                                                     |

예시 조각:

```yaml
CORS_ORIGINS: 'https://app.example.com'
AUTH_PUBLIC_BASE_URL: 'https://api.example.com'
AUTH_WEB_RETURN_URL: 'https://app.example.com/'
PEDESTRIAN_OSRM_URL: 'http://10.0.0.5:5011/route/v1/foot'
BICYCLE_OSRM_URL: 'http://10.0.0.5:5002/route/v1/bike'
MOBILITY_SIMULATION: 'scooter,ebike'
MOBILITY_SIMULATION_SEED: 'jigak'
MOBILITY_SIMULATION_WINDOW_DIR: '/sim-windows'
DATA_GO_KR_DAILY_LIMIT: '1000'
MODEL_MANIFEST_PATH: '/models/manifest.json'
MAP_NGII_PMTILES_PATH: '/maps/seoul-ngii-v1.pmtiles'
```

### 2-4. Cloud Run 크기와 시뮬레이터

`MOBILITY_SIMULATION`에 `scooter` 또는 `ebike`가 있으면 `cloud-run.ps1`이 아래를 자동으로 붙입니다. 계획 출력에서 확인합니다.

| 설정          | 값                                                | 이유                                                                                                                                     |
| ------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CPU / 메모리  | `--cpu 2 --memory 2Gi` (꺼짐이면 1 / 512Mi)       | 창 계산 작업자 스레드가 약 550 MB, 서버 전체가 0.8–1.1 GB(추정). 작업자와 요청이 CPU를 하나씩 씁니다. **1 CPU / 512Mi에서는 안 됩니다.** |
| CPU 할당      | `--no-cpu-throttling --cpu-boost`                 | 창 계산이 요청 밖(시작 시, 매일 05:00 KST)에서 돕니다                                                                                    |
| 최소 인스턴스 | `--min-instances 1`                               | 첫 창 계산 약 50–90초(추정). 상시 1대 비용은 하루 약 3–4달러(추정)                                                                       |
| startup probe | `GET /api/health/ready`, 5초 간격, 실패 60회      | 창이 준비되기 전에는 트래픽을 받지 않습니다                                                                                              |
| 창 저장 볼륨  | `-SimulationWindowBucket`이 `/sim-windows`로 붙음 | 재시작·새 인스턴스에서 약 0.1초에 읽습니다(하루 약 21 MB)                                                                                |
| 최대 인스턴스 | 창 버킷이 없으면 `-MaxInstances 2` 이하           | 버킷이 없으면 새 인스턴스마다 창을 다시 계산합니다                                                                                       |

`DATA_GO_KR_DAILY_LIMIT`가 인스턴스마다 따로 세어지므로 `MaxInstances 2`면 실제 호출이 최대 2배입니다.

창 저장 버킷(서울, 비공개, 7일 lifecycle):

```bash
gcloud storage buckets create gs://<프로젝트>-sim-windows --location=asia-northeast3 \
  --uniform-bucket-level-access --public-access-prevention
cat > lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}
JSON
gcloud storage buckets update gs://<프로젝트>-sim-windows --lifecycle-file=lifecycle.json
gcloud storage buckets add-iam-policy-binding gs://<프로젝트>-sim-windows \
  --member=serviceAccount:<런타임 서비스 계정> --role=roles/storage.objectUser
```

### 2-5. OSRM 서버 (foot-v2, bike)

선택이지만 권장합니다. 없으면 공개 FOSSGIS를 써서 검색이 8–16초 걸릴 수 있고 단지 안 보행로(foot-v2)도 못 씁니다.

- 데이터: foot-v2 5.4 GB, bike 3.5 GB. 사용자가 보낸 `OSRM.md`를 따릅니다. 만든 때와 같은 `osrm/osrm-backend` 이미지(v5.26.0, 다이제스트는 `OSRM.md`)를 써야 파일을 읽습니다.
- foot-v2는 NGII 지형도로 만들어서 사용자 PC에서만 다시 만들 수 있고, 원본은 국외로 못 나갑니다. foot-v2 없이 쓰려면 기본 `foot`을 5001 포트로 띄우고 그 주소를 `PEDESTRIAN_OSRM_URL`에 넣습니다.

```bash
# 서울 리전 VM, RAM 16 GB 이상 권장. :latest 대신 OSRM.md의 다이제스트로 고정하세요.
docker run -d --name osrm-foot -p 5011:5000 -v $PWD/foot-v2:/data osrm/osrm-backend:latest \
  osrm-routed --algorithm mld --max-table-size 200 /data/korea.osrm
docker run -d --name osrm-bike -p 5002:5000 -v $PWD/bike:/data osrm/osrm-backend:latest \
  osrm-routed --algorithm mld --max-table-size 200 /data/korea.osrm
curl -s "http://localhost:5011/route/v1/foot/127.0634,37.4946;127.0276,37.4979?overview=false" | head -c 200
```

Cloud Run이 VM 내부 IP에 닿으려면 Direct VPC egress가 필요합니다. `cloud-run.ps1`에는 없으므로 배포 뒤 한 번 더 실행합니다. 다음 배포 때도 풀리지 않는지 확인합니다.

```bash
gcloud run services update perception-map --region asia-northeast3 \
  --network <VPC> --subnet <서브넷> --vpc-egress private-ranges-only
```

이 구성은 아직 해 본 적이 없습니다.

### 2-6. 계획 확인과 배포 (PowerShell)

서비스 이름은 지금 배포돼 있는 `perception-map`입니다. 스크립트의 기본값 `jigakmap-api`가 아닙니다.

```powershell
cd jigak-backend
$deployment = @{
  ProjectId = '<프로젝트>'; Region = 'asia-northeast3'; Service = 'perception-map'
  ArtifactRepository = '<저장소>'; ImageTag = 'release-20261102-1'
  InstanceConnectionName = '<프로젝트>:asia-northeast3:<SQL 인스턴스>'
  ServiceAccount = '<런타임 서비스 계정>'
  DbPasswordSecret = '<비밀>:<버전>'; AuthEncryptionKeySecret = '<비밀>:<버전>'
  SecretBindings = @{
    KAKAO_REST_API_KEY = '<비밀>:<버전>'
    KAKAO_REST_API_KEY_SUB = 'jigakmap-kakao-rest-key-spare:1'
    DATA_GO_KR_SERVICE_KEY = '<비밀>:<버전>'
    DATA_GO_KR_SERVICE_KEY_FALLBACK = 'jigakmap-data-go-kr-key-spare:1'
    SEOUL_OPEN_API_KEY = '<비밀>:<버전>'
    SEOUL_OPEN_API_KEY_FALLBACK = 'jigakmap-seoul-open-api-key-spare:1'
    # 기존 비밀(SEOUL_BIKE_API_KEY 등)도 모두 다시 적습니다.
  }
  MaxInstances = 2; MinInstances = -1
  SimulationWindowBucket = '<프로젝트>-sim-windows'
  MapBucket = '<프로젝트>-ngii-kr'
  AllowUnauthenticated = $true
}
.\deploy\cloud-run.ps1 @deployment -PlanOnly
```

계획에 `--cpu 2 --memory 2Gi`, `--min-instances 1`, `--no-cpu-throttling --cpu-boost`, `--startup-probe`, `name=sim-windows`, `name=maps,type=cloud-storage,bucket=<프로젝트>-ngii-kr,readonly=true`가 있는지 봅니다. 모델 버킷은 4절에서 만든 뒤 `-ModelBucket <프로젝트>-jigak-models`를 더해 최종 배포합니다. 그러려면 4절의 1–3단계를 이 배포 전에 해 두는 편이 한 번에 끝납니다.

확인했으면 `-PlanOnly`를 빼고 실행합니다. 빌드 → migration Job(`node dist/common/database/migrate.js`) → 서비스 배포 순서이고, migration이 실패하면 서비스 배포를 멈춥니다.

**DB 마이그레이션:** 보통은 위 스크립트가 알아서 합니다. 따로 돌릴 때는 Job을 실행합니다. 이번 릴리스에서 새로 추가된 마이그레이션은 없고, 기존 DB는 `schema_migrations`의 `001-initial` checksum이 맞을 때만 채택됩니다. checksum이 다르면 적용되지 않고 멈춥니다.

```bash
cd jigak-backend && npm run migration:run     # 로컬 확인용. 운영은 cloud-run.ps1이 만드는 migration Job
```

> 미검증: `--add-volume name=sim-windows`를 다시 붙일 때 gcloud가 "이미 있음"을 낼 수 있습니다. 나오면 해당 배포 명령 앞에 `--clear-volumes --clear-volume-mounts`를 두고 `sim-windows`, `models`, `maps` 볼륨을 함께 다시 붙입니다.

## 3. 지도 호스팅

앱은 지도를 PMTiles 파일 하나를 HTTP Range 요청으로 읽어 그립니다. OSM 지도 두 개는 공개 버킷에 두고, NGII 지도는 **API 서버를 거쳐서만** 내려줍니다.

| 파일                      | 크기                    | 앱 설정                                                                                  | 어디에                                                                                                                  |
| ------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `korea.pmtiles`           | (기존)                  | `EXPO_PUBLIC_MAP_TILES_URL`                                                              | 이미 `https://storage.googleapis.com/jigak-bucket1/korea.pmtiles`에 있습니다. 기본값이라 설정이 없으면 이 주소를 씁니다 |
| `korea-detail-v1.pmtiles` | 48 MB (OSM 상세)        | `EXPO_PUBLIC_MAP_DETAIL_TILES_URL`                                                       | 공개 읽기 GCS 버킷(`jigak-bucket1`도 됨)                                                                                |
| `seoul-ngii-v1.pmtiles`   | 134 MB (국토지리정보원) | `EXPO_PUBLIC_MAP_NGII_TILES_URL` = `https://<API 도메인>/api/maps/seoul-ngii-v1.pmtiles` | 서울 리전(`asia-northeast3`) **비공개** 버킷 → Cloud Run 읽기 전용 볼륨 `/maps`                                         |

`seoul.pmtiles`는 올리지 않습니다. 변수가 비어 있으면 그 층은 꺼집니다.

### NGII 규칙

- `seoul-ngii-v1.pmtiles`는 국토지리정보원 수치지형도에서 만들었고 국외 반출 금지입니다. 서울 리전 단일 리전 **비공개** 버킷에만 둡니다. `allUsers` 권한, 공개 URL, 멀티 리전 버킷, 다른 리전, Cloud CDN, 해외 미러는 쓰지 않습니다.
- 버킷은 Cloud Run 서비스(서울)만 읽습니다. 앱은 API의 `/api/maps/seoul-ngii-v1.pmtiles`로만 받습니다.
- 서버는 Range 요청만 받습니다. 한 번에 한 구간, 512 KiB까지이고, 파일 전체를 한 번에 주지 않습니다. IP마다 분당 600회로 제한합니다(장소 검색과 같은 값, PostgreSQL 공유 제한).
- IP마다 받은 바이트도 셉니다. 기본값은 **10분에 60 MiB**입니다. 파일(127.7 MiB)을 한 IP로 다 받으려면 창이 세 번 필요해 20분을 넘깁니다. 지도를 10분 써도 2–5 MB라 한 사람에게는 넉넉합니다. 통신사 공유 IP나 심사장 와이파이처럼 여러 명이 IP 하나를 쓰면 함께 셉니다. 아래 "바이트 예산"을 봅니다.
- 응답은 `Cache-Control: private, max-age=300`입니다. 공유 캐시와 CDN에는 남지 않습니다. Cloud Run 앞에 Cloud CDN이나 다른 캐시를 붙이지 않습니다.
- 출처 표기 "© 국토지리정보원 수치지형도"는 앱에 이미 들어 있습니다. 지도 화면에서 보이는지 마지막에 확인합니다.
- 원본(`mvp/data/ngii`)과 GPKG는 팀원에게 주지 않고 올리지도 않습니다.

### 업로드

```bash
# 1) NGII 전용 버킷: 서울, 균일 접근, 공개 차단
gcloud storage buckets create gs://<프로젝트>-ngii-kr --location=asia-northeast3 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage cp seoul-ngii-v1.pmtiles gs://<프로젝트>-ngii-kr/
# 런타임 서비스 계정만 읽습니다. allUsers는 넣지 않고 CORS도 설정하지 않습니다(브라우저는 버킷이 아니라 API에서 읽습니다).
gcloud storage buckets add-iam-policy-binding gs://<프로젝트>-ngii-kr \
  --member=serviceAccount:<런타임 서비스 계정> --role=roles/storage.objectViewer

# 2) 상세 타일(OSM): 기존 공개 버킷
gcloud storage cp korea-detail-v1.pmtiles gs://jigak-bucket1/
cat > cors.json <<'JSON'
[{"origin": ["*"], "method": ["GET", "HEAD"], "responseHeader": ["Range", "If-Match", "Content-Type"], "exposeHeader": ["Content-Range", "Content-Length", "ETag", "Accept-Ranges"], "maxAgeSeconds": 3600}]
JSON
gcloud storage buckets update gs://jigak-bucket1 --cors-file=cors.json
gcloud storage objects update gs://jigak-bucket1/korea-detail-v1.pmtiles --cache-control="public, max-age=3600"
```

`jigak-bucket1`의 기존 CORS 설정이 있으면 `gcloud storage buckets describe gs://jigak-bucket1 --format="default(cors_config)"`로 먼저 보고, 덮어써도 되는지 사용자에게 묻습니다. 이 CORS는 OSM 버킷에만 씁니다.

### 서비스에 붙이기

env yaml에 `MAP_NGII_PMTILES_PATH: '/maps/seoul-ngii-v1.pmtiles'`를 넣고, `cloud-run.ps1`에 `-MapBucket <프로젝트>-ngii-kr`를 더합니다. 스크립트가 버킷을 읽기 전용 `/maps`로 붙입니다(`name=maps,...,readonly=true`). 둘 중 하나만 있거나 `-Region`이 `asia-northeast3`가 아니면 스크립트가 멈춥니다.

PowerShell 없이 이미 배포된 서비스에 붙일 때는 아래처럼 합니다. 이때도 env yaml에 같은 값을 적어 두어야 다음 배포에서 빠지지 않습니다.

```bash
gcloud run services update perception-map --region asia-northeast3 \
  --add-volume name=maps,type=cloud-storage,bucket=<프로젝트>-ngii-kr,readonly=true \
  --add-volume-mount volume=maps,mount-path=/maps \
  --update-env-vars MAP_NGII_PMTILES_PATH=/maps/seoul-ngii-v1.pmtiles
```

변수가 비어 있으면 그 주소는 404(`MAP_NOT_CONFIGURED`)이고, 파일을 읽지 못하면 503(`MAP_UNAVAILABLE`)입니다. 어느 쪽이든 서버는 시작합니다.

### 바이트 예산

| 변수                           | 기본값 | 허용 범위 | 뜻                                                |
| ------------------------------ | ------ | --------- | ------------------------------------------------- |
| `MAP_NGII_BYTE_BUDGET_MIB`     | `60`   | 1–1024    | IP 하나가 한 창에서 받을 수 있는 NGII 바이트(MiB) |
| `MAP_NGII_BYTE_WINDOW_MINUTES` | `10`   | 1–1440    | 창 길이(분). 그 IP의 첫 응답부터 셉니다           |

- 빈 값이면 기본값입니다. 범위를 벗어나거나 정수가 아니면 서버가 시작하지 않습니다.
- 횟수 제한과 같은 PostgreSQL 표(`api_rate_windows`)에 따로 키를 두고 셉니다. 인스턴스가 여러 개여도 한 IP는 한 예산입니다. 스키마는 바뀌지 않았습니다.
- 실제로 보낸 바이트만 셉니다. HEAD, 400(Range 없음·형식 오류·512 KiB 초과), 416, 404, 503은 세지 않습니다. 파일을 읽다 실패한 503은 먼저 센 바이트를 되돌립니다.
- 예산을 넘길 요청은 잘라 보내지 않고 통째로 거절합니다. 429와 `Retry-After`(창이 끝날 때까지 남은 초), 문구 "지도를 짧은 시간에 많이 받았어요. 잠시 후 다시 시도해 주세요."를 보냅니다. 앱은 그 동안 NGII 층에 빈칸이 생기고 바탕 지도는 그대로입니다.
- IPv4는 주소 하나, IPv6는 /64 하나를 한 예산으로 셉니다. 휴대폰과 집은 /64를 통째로 받아 그 안에서 주소를 바꿀 수 있기 때문입니다. 분당 600회 제한은 아직 IPv6 주소 하나하나를 따로 셉니다.
- IP는 `TRUST_PROXY_HOPS`를 따라 정합니다(모든 요청 제한과 같음). Cloud Run 배포 예시는 `'1'`입니다. Cloud Run 앞단은 프록시 한 단계라서, `0`이면 모든 사용자가 그 프록시 주소 하나로 묶여 경로 검색(분당 30회), 장소 검색, 지도 예산을 다 함께 나눠 쓰게 됩니다. `'1'`이면 Cloud Run이 `X-Forwarded-For` 끝에 붙이는 사용자 IP를 씁니다(앞쪽 값은 사용자가 꾸밀 수 있어 쓰지 않습니다). 배포 뒤 아래 "확인"에서 두 기기가 따로 세지는지 봅니다. 실제 Cloud Run에서는 아직 확인하지 않았습니다.
- 더 막고 싶으면 값을 낮춥니다. 63 MiB 이하면 파일 전체에 창이 세 번 필요해 20분을 넘깁니다. 대신 IP를 공유하는 사람이 많은 곳에서 먼저 막힙니다. IP를 바꿔 가며 받는 사람은 어느 값으로도 막지 못합니다.

NGII 파일을 바꿀 때는 사용자에게 먼저 묻습니다. 같은 이름을 덮어쓰면 앱에 캐시된 옛 조각(최대 5분)과 새 조각이 섞일 수 있습니다. 서버의 ETag(크기와 수정 시각)가 바뀌면 PMTiles가 다시 읽지만, Cloud Run에서는 확인하지 않았습니다(미검증). 이름을 바꾸려면 서버 코드의 파일 이름도 바꿔야 합니다.

### 앱 설정 (서버 변수가 아닙니다)

앱 빌드 담당에게 전달합니다.

```bash
EXPO_PUBLIC_MAP_DETAIL_TILES_URL=https://storage.googleapis.com/jigak-bucket1/korea-detail-v1.pmtiles
EXPO_PUBLIC_MAP_NGII_TILES_URL=https://<API 도메인>/api/maps/seoul-ngii-v1.pmtiles
EXPO_PUBLIC_API_URL=https://<API 도메인>
```

지도 화면은 출처가 없는 프레임(웹의 sandbox iframe, 네이티브의 HTML WebView)이라 `Origin: null`을 보냅니다. `CORS_ORIGINS`에 적을 수 있는 출처가 없으므로, 서버는 이 경로에서만 `null`과 `CORS_ORIGINS`를 허용하고 쿠키는 받지 않습니다. 다른 출처는 403입니다. `null`을 허용해도 Origin 없이 보내는 curl이 이미 읽을 수 있는 것 이상은 열리지 않습니다. 구간 상한과 바이트 예산은 누구에게나 똑같이 걸립니다. `null`을 빼려면 앱 지도 프레임에 고정 출처를 주는 앱 수정이 먼저 필요합니다.

### 확인

```bash
U1=https://storage.googleapis.com/jigak-bucket1/korea-detail-v1.pmtiles
U2=https://<API 도메인>/api/maps/seoul-ngii-v1.pmtiles
curl -s -D - -o /tmp/head.bin -r 0-15 -H "Origin: https://app.example.com" $U1
curl -s -D - -o /tmp/head.bin -r 0-15 -H "Origin: null" $U2
head -c 7 /tmp/head.bin     # PMTiles 파일의 첫 7바이트는 문자 PMTiles
curl -s -o /dev/null -w '%{http_code}\n' $U2                      # Range 없음: 400
curl -s -o /dev/null -w '%{http_code}\n' -r 0-1048575 $U2         # 512 KiB 초과: 400
curl -s -o /dev/null -w '%{http_code}\n' https://storage.googleapis.com/<프로젝트>-ngii-kr/seoul-ngii-v1.pmtiles   # 버킷 직접: 401 또는 403
curl -s $API/api/health | jq .maps                               # {"ngii":{"configured":true,"available":true}}
gcloud run services describe perception-map --region asia-northeast3 --format=yaml | grep -A1 -E 'MAP_NGII_BYTE|TRUST_PROXY_HOPS'   # 넣은 값 확인
```

바이트 예산은 데모 전에 시험하지 않습니다. 시험한 IP는 10분 동안 NGII 층이 비어 보입니다. 시험할 때는 PC 한 대에서 아래를 돌리고, 끝나자마자 다른 네트워크(휴대폰 LTE)에서 앱 지도를 엽니다. 거기서 NGII 층이 보이면 IP마다 따로 세는 것입니다. 보이지 않으면 `TRUST_PROXY_HOPS`를 봅니다.

```bash
# 512 KiB씩 읽습니다. 처음부터 돌리면 192번째까지 206, 위 확인을 먼저 돌렸다면(16 B 사용) 191번째까지 206이고 그 뒤로 429
for i in $(seq 0 193); do curl -s -o /dev/null -w '%{http_code} ' -r $((i*524288))-$((i*524288+524287)) -H "Origin: null" $U2; done; echo
curl -s -D - -o /dev/null -r 0-524287 -H "Origin: null" $U2 | grep -i -E '^HTTP|retry-after'   # 429, Retry-After: 남은 초
```

기대값: 두 지도 모두 `206`, `Content-Range: bytes 0-15/<전체 크기>`(48 MB는 47959990, NGII는 133894110 바이트 근처), `Accept-Ranges: bytes`, `Access-Control-Allow-Origin`. NGII는 `Cache-Control: private, max-age=300`이고 `Access-Control-Allow-Credentials`가 없습니다. 200이 오고 `Content-Range`가 없으면 Range가 막힌 것입니다. 버킷 주소를 직접 열었을 때 206이나 200이 오면 공개 권한이 남아 있는 것이니 바로 지웁니다.

버킷 위치와 공개 차단도 확인합니다.

```bash
gcloud storage buckets describe gs://<프로젝트>-ngii-kr \
  --format="value(location,locationType,public_access_prevention)"   # ASIA-NORTHEAST3 region enforced
```

## 4. 모델 올리기

운영은 자동 갱신(4-1~4-3)이 기본이고, 4-4의 수동 복사는 자동이 안 될 때의 대체 방법입니다. **둘을 섞지 않습니다.** 둘 다 서비스의 `/models`에 볼륨을 붙이므로 한 서비스에 한쪽만 붙입니다.

구조: Cloud Scheduler(`30 5,9,13 * * *`, Asia/Seoul) → Cloud Run Job `jigak-model-refresh`(8 vCPU / 32GiB, 작업 제한 3시간) → 버킷 `gs://<프로젝트>-jigak-models`(서울). 서비스는 같은 버킷을 읽기 전용 `/models`로 붙이고 `MODEL_MANIFEST_PATH=/models/manifest.json`을 60초마다 확인해 재시작 없이 바꿉니다.

### 4-1. 첫 manifest(세대 1) 만들기

사용자가 준 번들 `dist/handoff-20261102/model-store-bootstrap`은 현재 운영 모델 5개와 공휴일 달력으로 만든 첫 세대 씨앗입니다. 번들 안의 `SHA256SUMS`나 README가 있으면 먼저 확인합니다. `manifest.json`이 버킷에 이미 있으면 다시 만들지 않습니다(Job이 덮어쓰기를 거부합니다).

이 번들은 Windows PC에만 있고, 그 안의 `operational/revalidations.json`은 공간 버스·지하철 만료를 11/09 03:22·03:35로 적고 있습니다. 두 파일의 공휴일 달력은 11/07에서 끝나므로 11/08 00:00부터는 예측이 null이고, 요청 뒤 4시간까지의 탑승을 예측하려면 실제로 쓸 수 있는 끝은 11/07 20:00입니다. 이 커밋부터는 `init`이 그 연장을 11/07 20:00으로 잘라 넣고(`expiryClippedBy: "calendar-end"`), 서버와 러너도 같은 값으로 봅니다. 그래서 옛 번들로 init해도 health가 11/07 20:00 이후를 서빙 중이라고 하지는 않습니다. 그래도 팀원에게 넘기기 전에 이 커밋으로 번들을 다시 만들면(모노레포 루트에서 `npm --prefix jigak-backend run models:store:bundle -- --out <폴더> --store <측정한 store>`) 번들 자체의 값도 정직해집니다. 다시 만든 번들에는 공간 버스·지하철의 재검증 기준 파일(`references/<모델>/<sha256>.json`)도 들어가서, 클라우드 1세대부터 재검증이 됩니다(옛 번들에는 없음. 그 경우 4-2의 8단계를 다시 돌리면 기준 파일만 더합니다). 어느 쪽이든 11/07 00:40 전에 새 모델이 승격돼야 합니다.

```bash
gcloud storage ls gs://<프로젝트>-jigak-models/manifest.json     # 있으면 이 단계는 건너뜁니다
gcloud storage rsync --recursive dist/handoff-20261102/model-store-bootstrap gs://<프로젝트>-jigak-models/bootstrap
gcloud run jobs execute jigak-model-refresh --region asia-northeast3 \
  --args=init,--from-bundle,/models-store/bootstrap --wait
gcloud storage ls gs://<프로젝트>-jigak-models/manifest.json     # 생겼는지 확인
```

버킷과 Job은 4-2에서 만들어지므로 이 4-1은 4-2의 7단계 뒤에 합니다.

### 4-2. Job과 Scheduler 설치 (`deploy/model-refresh-job.sh`)

먼저 계획만 출력합니다. `gcloud`를 부르지 않습니다. **백엔드 저장소 루트**에서 실행합니다(백엔드만 담은 저장소 `jigak-backend`의 클론, 또는 모노레포의 `jigak-backend/`). Job 코드와 이미지 정의가 그 안의 `model-refresh/`에 있습니다.

```bash
cd jigak-backend
bash deploy/model-refresh-job.sh --project <프로젝트> --service perception-map \
  --alert-email <알림 메일> --api-host <API 도메인> --bundle <받은 번들 폴더>
```

`--service perception-map`을 꼭 줍니다. 기본값은 `jigakmap-api`이고, 이 값은 런타임 서비스 계정을 읽는 데만 씁니다. 계획을 읽고 `--apply`를 붙여 실행합니다. 이미 있는 리소스는 건너뛰므로 다시 돌려도 됩니다. 중간에 멈추면 `--from-step N`으로 이어 갑니다.

```bash
bash deploy/model-refresh-job.sh --project <프로젝트> --service perception-map \
  --alert-email <알림 메일> --api-host <API 도메인> --bundle <받은 번들 폴더> --apply
```

단계: 1 API 사용 → 2 Artifact Registry `jigak` → 3 버킷(서울, 균일 접근, 버전 관리, 이전 버전 14일·`raw/` 21일 수명주기) → 4 서비스 계정과 권한 → 5 시크릿 `data-go-kr-service-key` → 6 이미지 빌드 → 7 Job → 8 첫 세대 → 9 Scheduler → 10 `--plan` 실행 → 11 API 서비스 마운트 안내 → 12 알림.

Job 크기는 스크립트가 `--cpu 8 --memory 32Gi --task-timeout 3h --max-retries 1 --tasks 1 --parallelism 1`로 정합니다. 학습 실행은 하루 한 번 30분 안팎(추정)이고, 할 일이 없는 실행은 1분입니다. 메모리가 모자라면 Job 환경변수에 `MODEL_REFRESH_WORKERS=1`을 넣고 16GiB로 줄일 수 있지만 실측 전에는 바꾸지 않습니다.

**5단계에서 한 번 직접 할 일**(키는 스크립트가 읽지도 찍지도 않습니다). 키가 없으면 6단계 전에 멈춥니다.

```bash
read -rs KEY && printf %s "$KEY" | gcloud --project <프로젝트> secrets versions add data-go-kr-service-key --data-file=- ; unset KEY
```

**6단계(이미지)는 백엔드 저장소만 있으면 됩니다.** `gcloud builds submit <백엔드 루트> --config model-refresh/cloudbuild.yaml`로 `model-refresh/Dockerfile`을 빌드합니다. 고정 입력(TOPIS 도로 기준표, 역 좌표)은 `model-refresh/data-static/`에 커밋돼 있어 사용자 PC의 `mvp/data`가 필요 없습니다(예전의 `stage-context.sh`는 없어졌습니다).

**8단계(첫 세대)는 번들이 있어야 합니다.** 번들은 git에 없는 운영 모델로 만들므로 사용자 PC(모노레포)에서 만듭니다: 모노레포 루트에서 `npm --prefix jigak-backend run models:store:bundle -- --out <폴더>`. 받은 폴더를 `--bundle <폴더>`로 넘기면 스크립트가 그것을 버킷 `bootstrap/`에 올리고 Job을 `init --from-bundle`로 한 번 돌립니다. 모노레포 안에서 돌리면 `--bundle` 없이 스크립트가 직접 만듭니다. 버킷에 `manifest.json`이 이미 있으면 첫 세대는 건너뛰고 번들의 재검증 기준 파일(`references/`)만 덮어쓰지 않고 더합니다.

이미지를 손으로 만들고 Job만 따로 배포하려면(스크립트를 쓰지 않을 때):

```bash
TAG=$(date +%Y%m%d-%H%M)
IMAGE=asia-northeast3-docker.pkg.dev/<프로젝트>/jigak/jigak-model-refresh:$TAG
gcloud --project <프로젝트> builds submit . --region asia-northeast3 \
  --config model-refresh/cloudbuild.yaml --substitutions _IMAGE=$IMAGE
gcloud --project <프로젝트> run jobs deploy jigak-model-refresh --region asia-northeast3 --image $IMAGE \
  --cpu 8 --memory 32Gi --task-timeout 3h --max-retries 1 --tasks 1 --parallelism 1 \
  --service-account jigak-model-refresh@<프로젝트>.iam.gserviceaccount.com \
  --set-secrets DATA_GO_KR_SERVICE_KEY=data-go-kr-service-key:1 \
  --set-env-vars MODEL_REFRESH_MODE=cloud,TZ=Asia/Seoul \
  --add-volume name=models,type=cloud-storage,bucket=<프로젝트>-jigak-models,mount-options=implicit-dirs \
  --add-volume-mount volume=models,mount-path=/models-store
# 이어서 4-1의 번들 업로드와 init 실행, 그다음
bash deploy/model-refresh-job.sh --project <프로젝트> --service perception-map --from-step 9 --apply
```

`--from-step 9`부터는 Scheduler(`30 5,9,13 * * *`), `--plan` 첫 실행, 알림입니다.

**푸시 트리거(선택, 권장).** `main` 푸시로 API를 배포하는 기존 트리거에 `ignoredFiles: model-refresh/**`를 더하고, Job 이미지용 트리거를 하나 더 만듭니다: 구성 파일 `model-refresh/cloudbuild.trigger.yaml`, 포함 파일 `model-refresh/**`, `src/common/engine/intelligence/**`, `src/common/engine/private-files.ts`, `src/common/engine/realtime/bicycle-ride-times.ts`, `src/common/engine/realtime/data/korea-holidays-*.json`. 이 트리거는 이미지를 올리고 `gcloud run jobs update`로 Job 이미지를 바꿉니다(Job은 위에서 먼저 만들어 둠). 트리거 서비스 계정 권한은 `docs/MODEL-REFRESH.md` "이미지 자동 빌드"에 있습니다. 트리거 없이 두면 Job 코드를 바꿀 때마다 6단계(`--from-step 6`)를 다시 돌립니다.

### 4-3. 서비스가 버킷을 따라가게 하기

env yaml에 `MODEL_MANIFEST_PATH: '/models/manifest.json'`이 있어야 하고(2-3), 배포 인자에 `-ModelBucket`을 더합니다.

```powershell
.\deploy\cloud-run.ps1 @deployment -ModelBucket '<프로젝트>-jigak-models'
```

`-ModelBucket`은 버킷을 읽기 전용 `/models`로 붙입니다(서비스 계정은 `roles/storage.objectViewer`를 4단계에서 받았습니다). 읽지 못하는 권한 오류가 나면 `-ModelMountOptions 'uid=1000;gid=1000'`을, 갱신이 늦게 따라오면 `-ModelMountOptions 'stat-cache-ttl=30s'`를 더합니다.

확인:

```bash
API=https://<API 도메인>
curl -s $API/api/models/refresh | jq '{status, reasons, manifest, lastRun, nextScheduledAt}'
curl -s $API/api/health | jq '{mode, models: (.models | map_values({active, origin, expiresAt, expirySource, manifestGeneration})), modelRefresh: .modelRefresh.status}'
gcloud run jobs executions list --job jigak-model-refresh --region asia-northeast3 --limit 3
```

기대값: `modelRefresh.status`가 `ok`(마지막 실행이 아직 없으면 `stale`), `manifest.generation`이 1 이상, `manifest.error`가 `null`, 모델 `origin`이 `manifest`, `active: true`. `unconfigured`면 `MODEL_MANIFEST_PATH`가 안 들어간 것입니다.

### 4-4. 수동 대체: `cloud-models/*.json` 복사

자동 갱신을 못 쓸 때만 합니다. **권장하지 않습니다:** 자동 갱신은 기존 모델이 새 평가일에서도 기준을 통과하면 유효기간을 늘리고(재검증, manifest에만 기록) 새 모델을 계속 학습합니다. 파일을 직접 읽는 이 방식에서는 파일 안의 만료(아래 표)를 그대로 따르고 새 모델도 생기지 않습니다. 재검증이 붙어도 지금 공간 버스·지하철 파일은 달력 끝 4시간 앞인 11/07 20:00까지만 쓸 수 있으므로, 두 방식 모두 11/07 00:40 전에 새로 학습한 파일이 필요합니다. 이때는 `MODEL_MANIFEST_PATH`를 비워 두고(`-ModelBucket`도 쓰지 않음) env yaml에 다섯 경로를 적습니다.

| 파일                               | 환경변수                                                                  | 만료 (KST)      |
| ---------------------------------- | ------------------------------------------------------------------------- | --------------- |
| `public-bus-operational.json`      | `ETA_PUBLIC_BUS_MODEL_PATH=/models/public-bus-operational.json`           | 11-05 12:51     |
| `spatial-bus-operational.json`     | `ETA_SPATIAL_BUS_MODEL_PATH=/models/spatial-bus-operational.json`         | **11-07 00:40** |
| `rail-gate-operational.json`       | `ETA_RAIL_GATE_MODEL_PATH=/models/rail-gate-operational.json`             | 11-07 00:45     |
| `spatial-bicycle-operational.json` | `ETA_SPATIAL_BICYCLE_MODEL_PATH=/models/spatial-bicycle-operational.json` | 11-15 00:00     |
| `bicycle-ride-times-202606.json`   | `BICYCLE_RIDE_TIMES_PATH=/models/bicycle-ride-times-202606.json`          | 없음            |

```bash
cd cloud-models
sha256sum -c SHA256SUMS.txt          # macOS는 shasum -a 256 -c. 모두 OK여야 합니다
gcloud storage buckets create gs://<프로젝트>-models --location=asia-northeast3 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage cp public-bus-operational.json spatial-bus-operational.json rail-gate-operational.json \
  spatial-bicycle-operational.json bicycle-ride-times-202606.json gs://<프로젝트>-models/
gcloud storage buckets add-iam-policy-binding gs://<프로젝트>-models \
  --member=serviceAccount:<런타임 서비스 계정> --role=roles/storage.objectViewer
gcloud run services update perception-map --region asia-northeast3 \
  --add-volume name=models,type=cloud-storage,bucket=<프로젝트>-models,readonly=true \
  --add-volume-mount volume=models,mount-path=/models
```

서버는 30초마다 모델 파일의 수정 시각을 확인해, 같은 이름으로 덮어쓰면 재배포 없이 새 모델을 읽습니다(`bicycle-ride-times`와 공휴일 달력은 시작할 때 한 번만 읽으므로 새 리비전이 필요합니다). 만료된 모델은 같은 이름으로 덮어써도 날짜를 고친 파일은 거부됩니다. 새로 학습한 파일이 있어야 합니다. 그래서 수동 방식은 11/07 이후를 보장하지 못합니다.

## 5. 배포 후 확인

```bash
API=https://<API 도메인>
curl -s -o /dev/null -w '%{http_code}\n' $API/api/health/ready      # 계산 중 503 starting, 준비되면 200
curl -s $API/api/health | jq '{mode, cap: .capabilities | {places, transit, realtimeBus, sharedScooter, sharedEbike, scooterRouting, ebikeRouting}, models: .models | map_values(.active), sim: .simulation | {enabled, ready, source, windowStore, fleetByType}, maps, realtimeSources}'
curl -s $API/api/models/public-bus | jq '{active, expiresAt, spatial: .spatial.active}'
curl -s $API/api/models/refresh | jq '{status, reasons}'
curl -s $API/api/sim/status | jq '.byType'
curl -s "$API/api/realtime/mobility?latitude=37.4946&longitude=127.0634&radius=500&limit=2500" | jq '.totals'
```

| 항목                                                                          | 기대값                                                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/api/health/ready`                                                           | 200, `simulation.ready: true`. 두 번째 배포부터 `source: "store"`             |
| `mode`                                                                        | `live-ready`                                                                  |
| `capabilities.sharedScooter`, `sharedEbike`, `scooterRouting`, `ebikeRouting` | 모두 `true`                                                                   |
| `models.publicBus.active`, `railGate.active`, `bicycleRide.active`            | `true`. `hgb`는 `false`(정상)                                                 |
| `simulation.windowStore`                                                      | `configured`                                                                  |
| `simulation.fleetByType`                                                      | 킥보드 14,933 / 전기자전거 52,605                                             |
| `realtimeSources` 중 `seoul-bus`, `tago-bus`, `seoul-subway`                  | `status: "available"`. 한도 초과는 `quota`+`resetsAt`, 키 거부는 `auth-error` |
| 대치역 500 m `totals`                                                         | 0이 아니어야 합니다(로컬은 전기자전거 74, 킥보드 31, 시각에 따라 다름)        |
| `modelRefresh.status`                                                         | `ok`                                                                          |
| `maps.ngii`                                                                   | `configured: true`, `available: true`                                         |

경로 검색 표본입니다. 도보·대중교통·킥보드·전기자전거 후보가 나와야 하고 지하철 단계에 "N번 출구"가 보여야 합니다.

```bash
NOW=$(($(date +%s)*1000)); DL=$((NOW+3600000))
P='"preferences":{"allowRunning":false,"allowBicycle":true,"maxRunningMeters":0,"maxBicycleMeters":5000,"runningPace":"steady","preparationSeconds":0,"bicycleReady":false,"allowTaxi":true,"allowScooter":true,"allowEbike":true,"hasScooterLicense":true}'
route() { curl -s -X POST $API/api/routes/search -H 'content-type: application/json' -d "{\"origin\":{\"id\":\"a\",\"name\":\"$1\",\"address\":\"\",\"latitude\":$2,\"longitude\":$3},\"destination\":{\"id\":\"b\",\"name\":\"$4\",\"address\":\"\",\"latitude\":$5,\"longitude\":$6},\"deadline\":$DL,\"now\":$NOW,$P}" | jq '[.routes[]? | {title, min: (.durationSeconds.min/60|floor), max: (.durationSeconds.max/60|ceil)}] | .[:6]'; }
route 강남역 37.4979 127.0276 선릉역 37.5045 127.0490
route 서울숲역 37.5436 127.0446 건대입구역 37.5404 127.0702
curl -s "$API/api/places?q=%ED%99%8D%EB%8C%80" | jq '[.places[0:3][] | .name], .provenance.provider'
```

`preferences`에 `allowEbike`를 빼면 서버가 옛 앱으로 보고 전기자전거를 끕니다. 위 표본은 이를 포함합니다.

**앱에서 검색 하나:** 새 앱 빌드(또는 로컬 웹 `EXPO_PUBLIC_API_URL=https://<API 도메인>`)에서 대치역 → 강남역을 검색합니다. 결과가 뜨고 "올바른 자료를 보내지 않았어요"가 나오지 않아야 합니다. 서버 JSON이 정상이어도 앱의 엄격한 검증이 거부할 수 있어서, 이 검색이 최종 판정입니다. 지도 화면에서 상세 타일과 NGII 층, 출처 표기 "© 국토지리정보원 수치지형도"도 함께 봅니다. Kakao 한도가 작으니 검색은 여러 번 반복하지 않습니다.

그다음 Cloud Run 지표에서 메모리 최고값과 ready까지 걸린 시간을 한 번 기록합니다(시뮬레이터는 Cloud Run에서 아직 측정한 적이 없습니다). 문제가 없으면 사용자에게 알립니다. 서버 커밋 해시와 API 주소를 함께 보냅니다.

## 6. 문제가 생기면

### 서비스 되돌리기

```bash
gcloud run revisions list --service perception-map --region asia-northeast3
gcloud run services update-traffic perception-map --region asia-northeast3 --to-revisions <이전 리비전>=100
```

서버를 되돌리면 **앱도 그 시점의 빌드로** 되돌려야 합니다(1절). DB 스키마는 이미지를 되돌려도 되돌아가지 않습니다. 이번에 마이그레이션이 없으므로 이 점은 문제가 되지 않습니다.

### 모델 되돌리기

새 모델이 이상하면 이전 모델로 되돌립니다. 롤백은 history 항목을 가리키는 새 세대를 만드는 일이라 서비스는 최대 60초 안에 따라옵니다. 만료된 버전으로는 되돌아가지 않습니다.

```bash
gcloud run jobs execute jigak-model-refresh --region asia-northeast3 \
  --args=rollback,--model,spatialBus --wait                      # 계획만 출력
gcloud run jobs execute jigak-model-refresh --region asia-northeast3 \
  --args=rollback,--model,spatialBus,--execute --wait            # 실행
```

모델 키는 `publicBus`, `spatialBus`, `railGate`, `bicycleRide`입니다. 로컬 저장소 폴더에서는 백엔드 루트에서 `npm run models:rollback -- --store <폴더> --model spatialBus [--execute]`입니다(모노레포의 `npm --prefix mvp run models:rollback`도 같은 러너). 버킷 객체 버전 관리로 manifest의 직전 객체도 14일 남습니다.

### 증상별

| 증상                                       | 확인                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health/ready`가 계속 503             | 시뮬레이터가 오늘 창을 계산 중입니다(첫 배포 50–90초). 5분이 넘으면 로그와 CPU/메모리를 봅니다. 급하면 `MOBILITY_SIMULATION_READY_GATE: 'false'`로 한 리비전을 띄웁니다                                                                                                                                                                                                                                                                 |
| 컨테이너가 메모리로 죽음                   | 시뮬레이터에는 2 CPU / 2Gi가 필요합니다. 1 CPU / 512Mi로 줄지 않았는지 `gcloud run services describe`로 봅니다                                                                                                                                                                                                                                                                                                                          |
| 서버가 시작하지 않음                       | `MOBILITY_FOOT_WEIGHTS_PATH`를 읽지 못함, `MOBILITY_SIMULATION_WINDOW_DIR`와 `-SimulationWindowBucket` 불일치, `CORS_ORIGINS`가 HTTPS가 아님                                                                                                                                                                                                                                                                                            |
| 장소·길찾기 실패                           | 로그의 `Kakao call failed:` 줄. 기본·예비 키 모두 한도면 0시 KST에 초기화될 때까지 기다립니다                                                                                                                                                                                                                                                                                                                                           |
| 버스가 배차 기준으로 나옴                  | `realtimeSources`의 `quota`. 예비 키를 등록하고 `DATA_GO_KR_DAILY_LIMIT`을 확인합니다                                                                                                                                                                                                                                                                                                                                                   |
| `modelRefresh.status`가 `degraded`/`stale` | `reasons`를 봅니다. `manifest-sha-mismatch`, `manifest-candidate-invalid`, `manifest-candidate-missing`이면 서비스는 이전 모델을 그대로 쓰는 중입니다                                                                                                                                                                                                                                                                                   |
| 모델이 `manifest.error`                    | manifest를 읽을 수 없거나 세대 번호가 줄어든 경우이고, 서비스는 쓰던 manifest를 유지합니다                                                                                                                                                                                                                                                                                                                                              |
| Job 실패(exit 1, 2, 3)                     | `gcloud run jobs executions list`와 로그, 버킷의 `runs/<runId>/report.json`. exit 1은 크래시, 2는 만료까지 48시간 미만인데 갱신이 실패했거나 만료된 경우, 3(`partial`)은 한 모델이라도 `failed`/`closed`/`blocked`인 경우입니다. 셋 다 실패한 시도로 세어 첫 실패에서 바로 알림 메일이 가고, Cloud Run은 따로 한 번 재시도합니다(재시도도 실패하면 다시 경보 조건에 걸립니다). 공개 버스 후보가 기준 미달인 날은 3이 이어질 수 있습니다 |
| 지도가 안 뜸                               | 3절의 `curl -r 0-15`가 206인지, CORS 헤더가 있는지, 앱의 `EXPO_PUBLIC_MAP_*` 주소가 맞는지 봅니다                                                                                                                                                                                                                                                                                                                                       |
| NGII 층만 안 뜸                            | `/api/health`의 `maps.ngii`. `configured: false`면 `MAP_NGII_PMTILES_PATH`가 비었고, `available: false`면 `/maps` 볼륨이나 서비스 계정 권한을 봅니다. 429면 IP당 분당 600회 제한입니다                                                                                                                                                                                                                                                  |
| 앱에서 "올바른 자료를 보내지 않았어요"     | 앱 빌드가 서버 커밋과 같은지 확인합니다. 옛 앱 + 새 서버 또는 새 앱 + 옛 서버입니다                                                                                                                                                                                                                                                                                                                                                     |

11/04까지도 자동 갱신 Job이 서지 않으면 4-4의 수동 복사로 시간을 벌고 사용자에게 알립니다. 수동 방식은 만료 시각(11/07 00:40)을 늘리지 못합니다. 자동 갱신이어도 재검증만으로는 11/07 20:00을 넘지 못하니, 그 전에 새 모델이 승격됐는지 `/api/health`의 `expiresAt`과 `expirySource`(`calendar`이면 달력 끝에서 멈추는 중)로 확인합니다.
