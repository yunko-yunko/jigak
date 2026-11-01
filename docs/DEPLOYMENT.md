# GCP Cloud Run / Cloud SQL 배포

이 서버는 Node.js 24.11 이상과 NestJS·TypeORM을 사용하는 API입니다. 계정, OAuth 임시 상태, 세션, 저장 이동, 문의, ETA 관측값과 contextual/journey 학습 모델을 PostgreSQL에 저장합니다. 서비스 인스턴스의 로컬 파일을 영속 저장소로 사용하지 않습니다. 이 저장소에는 배포 준비 파일만 작성되어 있으며 실제 GCP 리소스 생성이나 배포는 수행하지 않았습니다.

2026-11-02 재배포(가상 차량 실규모, 예비 키, 모델·지도 자료, 배포 순서와 점검)는 [HANDOFF-2026-11-02.md](HANDOFF-2026-11-02.md)를 먼저 봅니다.

## 로컬 실행

```powershell
Copy-Item example.env .env
npm ci
docker compose up -d postgres
npm run build
npm run start:dev
```

`.env`의 `DB_PASSWORD=local-development-only`는 Compose의 개발 DB에만 사용합니다. 운영용 값과 구분합니다. API까지 컨테이너로 실행하려면 `docker compose up --build`를 사용합니다. Compose는 DB 상태 확인 → API 시작 시 마이그레이션 → HTTP 수신 순서로 실행합니다.

## 배포 전 준비

1. 결제가 연결된 GCP 프로젝트, Cloud SQL **PostgreSQL** 인스턴스, 빈 데이터베이스와 DB 사용자를 준비합니다. 예제 리전은 서울 `asia-northeast3`입니다. DB 사용자는 시작 마이그레이션에 필요한 테이블 생성·변경 권한을 가져야 합니다.
2. Cloud Run, Cloud Build, Artifact Registry, Cloud SQL Admin API를 활성화합니다. GitHub 연결 배포는 Cloud Build가 소스를 빌드하고 이미지를 저장하도록 구성합니다.
3. Cloud Run 실행 서비스 계정에는 `roles/cloudsql.client`가 필요합니다. 기존 기본 계정에 권한이 있으면 그대로 사용합니다. Cloud Build의 배포 권한도 콘솔 연결 설정에서 확인합니다.
4. DB 비밀번호, `AUTH_TOKEN_ENCRYPTION_KEY`와 사용하는 API 키를 Cloud Run 콘솔의 환경변수에 입력합니다. 암호화 키는 정확히 32바이트 난수의 Base64 값이며 배포 간 같은 값을 보존합니다. Secret Manager는 선택 사항이고, 사용하는 경우 API 활성화와 해당 비밀의 접근 권한을 추가합니다.

Cloud Run에 Cloud SQL 인스턴스를 연결하면 `DB_HOST=/cloudsql/프로젝트:리전:인스턴스`로 접속할 수 있습니다. Unix socket 연결은 Cloud SQL Auth Proxy가 암호화하므로 `DB_SSL=false`를 사용합니다. 이 배포 예제는 Cloud SQL의 public-IP/proxy 경로를 사용합니다. private-IP 전용 인스턴스는 별도 VPC 경로와 접속 설정이 필요합니다. [Cloud SQL 공식 연결 안내](https://docs.cloud.google.com/sql/docs/postgres/connect-run).

Secret Manager를 사용하는 경우 환경변수는 명시적인 숫자 버전으로 고정합니다. 예제의 `secret-name:1`에서 `1`은 실제 생성된 비밀 버전으로 바꿉니다. [Cloud Run 공식 비밀 설정 안내](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

## GitHub 저장소 연결 배포

1. 서버의 `Dockerfile`, `package.json`, `package-lock.json`, `tsconfig*.json`, `src`, `scripts`를 GitHub 배포 브랜치에 push합니다. `.env`와 실제 비밀 값은 저장소에 올리지 않습니다.
2. Cloud Run 콘솔에서 저장소 연결 → Cloud Build → GitHub 저장소와 배포 브랜치를 선택합니다. 기존 서비스는 소스 탭의 저장소 연결 설정을 사용합니다.
3. 빌드 유형을 Dockerfile로 선택하고 서버의 Dockerfile 경로를 지정합니다. 저장소 최상위에 서버가 있으면 `Dockerfile`을 사용하고, 하위 폴더에 있으면 해당 폴더의 Dockerfile을 지정합니다.
4. 서비스 설정에서 컨테이너 포트 `8080`, 실행 환경 2세대를 선택하고 컨테이너 명령·인수는 비워 둡니다. Cloud SQL 연결에 실제 인스턴스를 추가합니다. `DB_HOST`의 연결 이름도 동일해야 합니다.
5. 아래 환경변수를 콘솔에 입력합니다. 네이티브 앱 전용이면 `CORS_ORIGINS`는 빈 문자열로 등록하고, `AUTH_PUBLIC_BASE_URL`에는 실제 Cloud Run HTTPS URL을 사용합니다. `AUTH_WEB_RETURN_URL`은 네이티브 흐름에서는 사용하지 않지만 검증을 위해 같은 HTTPS API 주소를 넣을 수 있습니다.
6. 배포하면 DB 연결 → 잠금 획득 → 미적용 TypeORM 마이그레이션 → API 시작 순서로 실행합니다. 테이블이 없는 빈 DB도 시작할 수 있습니다. 이미지 주소를 직접 선택하거나 별도 migration Job을 생성할 필요가 없습니다.
7. 로그에서 `event=database-migrations-complete`와 Nest 시작 성공을 확인한 뒤 `/api/health/ready`가 `{"status":"ok","database":"ready"}`를 반환하는지 확인합니다.

다음 push에도 같은 순서로 자동 실행합니다. `typeorm_migrations` 이력으로 이미 적용된 변경을 건너뛰고, 동시에 시작하는 인스턴스는 같은 PostgreSQL advisory lock으로 순서를 기다립니다. 마이그레이션 실패 시 변경을 롤백하고 HTTP 포트를 열지 않습니다. 데이터베이스와 DB 사용자는 Cloud SQL에서 먼저 생성되어 있어야 합니다. [Cloud Run 공식 저장소 연결 안내](https://docs.cloud.google.com/run/docs/continuous-deployment).

## 환경변수 설정

GitHub 연결 배포에서는 `example.env`를 참고해 Cloud Run 콘솔에 직접 입력합니다. 아래 YAML 복사 명령은 선택적인 PowerShell 배포 스크립트를 사용할 때만 필요합니다.

```powershell
Copy-Item deploy/cloud-run.env.example.yaml deploy/cloud-run.env.yaml
npm run env:deployment
```

`cloud-run.env.yaml`의 `REPLACE_*` 값을 전부 바꿉니다. 비밀 값은 이 파일에 넣지 않습니다. `DB_HOST`의 인스턴스 연결 이름은 배포 스크립트의 `InstanceConnectionName`과 같아야 합니다. `PORT`는 파일에서 제외합니다. Cloud Run이 `--port 8080`에 맞춰 자동 설정하며, 프로세스는 `HOST=0.0.0.0`에서 수신합니다. [Cloud Run 컨테이너 계약](https://docs.cloud.google.com/run/docs/container-contract).

공개 HTTPS API 주소는 `AUTH_PUBLIC_BASE_URL`, 웹 앱의 고정 복귀 주소는 `AUTH_WEB_RETURN_URL`, 정확한 웹 출처는 `CORS_ORIGINS`에 설정합니다. 운영 DNS/API 도메인을 사용하면 첫 배포 전에도 값을 고정할 수 있습니다. 서비스의 자동 URL을 쓰는 첫 배포라면 제공사를 비활성화한 상태로 배포해 URL을 확인한 다음 올바른 URL로 다시 배포합니다. 모바일 앱의 공개 API URL은 프런트엔드의 `EXPO_PUBLIC_API_URL`에 설정하며 서버의 비밀과 구분합니다.

웹 로그인 쿠키는 기존 `SameSite=Lax` 정책을 유지합니다. 웹 앱과 API는 `app.example.com`과 `api.example.com`처럼 같은 사이트의 HTTPS 도메인에 배포합니다. 서로 다른 사이트의 프런트엔드와 `*.run.app` 조합은 교차 사이트 fetch에서 로그인 쿠키가 전달되지 않으므로, 웹 로그인용 API에는 같은 사이트의 커스텀 도메인을 연결합니다. 네이티브 앱은 Bearer 세션을 사용합니다.

| 구분                          | 환경변수                                                                                                                                                                                                                          | 설정                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 런타임                        | `NODE_ENV`, `HOST`                                                                                                                                                                                                                | `production`, `0.0.0.0`                                                                                                                                         |
| Cloud Run 주입                | `PORT`                                                                                                                                                                                                                            | `8080` (`--port`로 지정, env 파일에 추가하지 않음)                                                                                                              |
| DB 필수                       | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`                                                                                                                                                                                        | Cloud SQL socket 경로, `5432`, 실제 DB/사용자                                                                                                                   |
| DB 비밀                       | `DB_PASSWORD`                                                                                                                                                                                                                     | Cloud Run 환경변수 또는 Secret Manager                                                                                                                          |
| 연결 풀                       | `DB_POOL_MAX`, `DB_SSL`                                                                                                                                                                                                           | 예제 `5`, `false` (socket)                                                                                                                                      |
| 웹/인증                       | `CORS_ORIGINS`, `AUTH_PUBLIC_BASE_URL`, `AUTH_WEB_RETURN_URL`                                                                                                                                                                     | 실제 HTTPS URL/출처                                                                                                                                             |
| 인증 비밀                     | `AUTH_TOKEN_ENCRYPTION_KEY`                                                                                                                                                                                                       | 32바이트 Base64 키, 배포 간 같은 값 보존                                                                                                                        |
| 지도                          | `KAKAO_REST_API_KEY`, `KAKAO_REST_API_KEY_FALLBACK`                                                                                                                                                                               | 장소 검색/경로, 예비 키는 선택 비밀                                                                                                                             |
| 공공 데이터                   | `DATA_GO_KR_SERVICE_KEY`, `SEOUL_OPEN_API_KEY`, `SEOUL_BIKE_API_KEY`, `SEOUL_CITY_DATA_API_KEY`, `SEOUL_PARKING_API_KEY`, `TRAFFIC_SIGNAL_API_KEY`                                                                                | 사용하는 공급원별 키/활용승인                                                                                                                                   |
| 공공 데이터 예비 키           | `DATA_GO_KR_SERVICE_KEY_FALLBACK`, `SEOUL_OPEN_API_KEY_FALLBACK`, `DATA_GO_KR_DAILY_LIMIT`                                                                                                                                        | 일일 한도 소진 시 0시 KST까지 쓰는 선택 비밀, 버스 호출 상한(비밀 아님)                                                                                         |
| 시간 비교                     | `OPENAI_API_KEY`, `OPENAI_MODEL`                                                                                                                                                                                                  | 빈 키는 거리와 기본 속도로 계산                                                                                                                                 |
| Google 로그인                 | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`                                                                                                                                                                            | 해당 로그인 사용 시 모두 설정                                                                                                                                   |
| 카카오 로그인                 | `KAKAO_LOGIN_REST_API_KEY`, `KAKAO_LOGIN_CLIENT_SECRET`, `KAKAO_LOGIN_OIDC`                                                                                                                                                       | 해당 로그인 사용 시 설정, OIDC는 실제 활성화 시 `true`                                                                                                          |
| Apple 로그인                  | `APPLE_SERVICE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`                                                                                                                                                          | 해당 로그인 사용 시 모두 설정, 개인 키는 비밀                                                                                                                   |
| 경로/운영                     | `PEDESTRIAN_ROUTING_ENABLED`, `PEDESTRIAN_OSRM_URL`, `PEDESTRIAN_USER_AGENT`, `BICYCLE_ROUTING_ENABLED`, `BICYCLE_OSRM_URL`, `ROUTE_INTERMEDIATE_HUBS`, `ROUTE_CALL_LIMIT`, `ROUTE_METRICS_ENABLED`                               | 주석 있는 `example.env` 참조                                                                                                                                    |
| 추가 공유 이동수단            | `MOBILITY_GBFS_FEEDS`                                                                                                                                                                                                             | 검증된 공개 HTTPS GBFS 피드 JSON 배열 또는 빈 값                                                                                                                |
| 시연용 가상 킥보드·전기자전거 | `MOBILITY_SIMULATION`, `MOBILITY_SIMULATION_FLEET`, `MOBILITY_SIMULATION_EBIKE_FLEET`, `MOBILITY_SIMULATION_SEED`                                                                                                                 | `scooter`, `ebike` 또는 `scooter,ebike`로 켬. 시연용 가상 데이터이며 실제 운영사 아님                                                                           |
| 외부 검증 모델                | `ETA_MODEL_PATH`, `ETA_PUBLIC_BUS_MODEL_PATH`, `ETA_SPATIAL_BUS_MODEL_PATH`, `ETA_RAIL_GATE_MODEL_PATH`, `BICYCLE_RIDE_TIMES_PATH`, `ETA_SPATIAL_BICYCLE_MODEL_PATH`, `ETA_HGB_MODEL_PATH`, `ETA_PUBLIC_BICYCLE_SHADOW_DIRECTORY` | 읽기 전용 파일/폴더 경로 또는 빈 값                                                                                                                             |
| 모델 자동 갱신                | `MODEL_MANIFEST_PATH`, `MODEL_MANIFEST_POLL_SECONDS`, `MODEL_REFRESH_STATUS_PATH`, `MODEL_REFRESH_SCHEDULE_KST`                                                                                                                   | 갱신 Job의 버킷 manifest 경로(`/models/manifest.json`)와 확인 주기. 설정하면 아래 모델 경로 대신 manifest를 따르고 재시작 없이 바뀝니다. 빈 값은 아래 고정 경로 |

### 시연용 가상 킥보드·전기자전거

서울에는 공개된 공유 킥보드·공유 전기자전거 피드가 없어서, 시연용으로 가상 차량을 켤 수 있습니다. 이 데이터는 **시연용 가상 데이터**이며 실제 운영사·기기·대여가 아닙니다. 가상 운영사 하나가 킥보드와 대여소 없는 공유 전기자전거(PAS, 최고 보조 속도 25 km/h)를 함께 운영합니다. 따릉이 대여 이력(2026년 6월)의 대여소별·시간대별 이용량을 가상 수요의 위치와 시간 분포로만 사용합니다. 따릉이 실시간 재고는 실제 데이터 그대로입니다.

- `MOBILITY_SIMULATION`은 `scooter`와 `ebike`(`e-bike`도 같음)를 쉼표로 적습니다. `scooter`만 쓰면 지금까지처럼 킥보드만, `scooter,ebike`면 둘 다, `ebike`면 전기자전거만 켜집니다. 대소문자와 공백은 무시하며, 빈 값이나 알 수 없는 값만 있으면 꺼짐이고, 꺼져 있으면 아래 조회는 모두 404입니다. 알 수 없는 이름(예: `scooter,bike`의 `bike`)은 무시하고 시작할 때 경고 로그 한 줄로 알립니다.
- 대수: `MOBILITY_SIMULATION_FLEET`는 킥보드(3000~72000, 빈 값이면 14,933), `MOBILITY_SIMULATION_EBIKE_FLEET`는 전기자전거(1000~60000, 빈 값이면 52,605)입니다. 두 차종 합계는 3000~72000대여야 합니다. 수요가 서울 전역 따릉이 대여소에 퍼져 있어 3000대보다 적으면 대부분의 이용자가 주변 차량을 찾지 못하므로 합계 최소값이 3000입니다. 기본값은 서울의 실제 등록 대수와 같은 대수(실제 기기 1대 = 가상 기기 1대)입니다: 공유 킥보드 14,933대(2025년, 데일리안 2026-03-23)와 민간 공유 전기자전거 52,605대(2026년 6월, 6개 업체, 투어코리아 2026-09-14), 합계 67,538대. 더 최근 수치로 킥보드 16,055대·전기자전거 54,842대(2026년 6월, 세계일보 2026-07-05)도 있으나 참고값이며, 상한 72,000대는 이 합계(70,897대)가 들어가도록 잡았습니다. 지금 빌릴 수 있는 대수는 대수를 줄여서가 아니라 상태 모델(이용 중·충전·수리·거점 보관·야간 수거·숨김·견인 등)에서 나옵니다(설계 문서 §21).
- 같은 대수와 `MOBILITY_SIMULATION_SEED`(기본 `jigak`)면 모든 Cloud Run 인스턴스가 같은 차량 상태를 계산합니다. Cloud Run(`K_SERVICE`가 있음)의 상한은 72,000대라 기본값(67,538대)은 자르지 않습니다. 그보다 크게 적으면 비율대로 줄이고(각 차종 최소값은 지킴) 경고 로그를 남깁니다.
- 가상 운영사가 주차·민원·견인·고장·배터리 교체·회수·수리·재배치를 모두 계산하며, 차량 상태는 날을 넘겨 이어집니다. 3일마다 04:00(KST)에 정상 상태 견본에서 다시 시작합니다(48시간 예열 뒤 제공). 그 사이의 04:00 경계는 끊김 없이 이어지지만, 다시 시작하는 날의 04:00에는 개별 차량 위치가 한 번 다시 섞여 지도의 점이 바뀝니다. 그때 상태별 대수 차이는 fleet의 0.4% 안팎이고, 1 km 칸 대여 가능 대수의 변화는 평범한 하루치 변화보다 작습니다(측정값은 설계 문서 §18.2). 수요가 적은 달에는 가상 운영사가 fleet의 일부(가정값, 1월 12%·11월 6% 등)를 거점에 보관하므로 거리의 차량 수가 계절에 따라 달라집니다. 설계와 측정값은 `docs/2026-11-01-scooter-simulation.md`에 있습니다.
- 하루치 계산은 작업자 스레드에서 하며 요청을 막지 않습니다. 실규모(14,933 + 52,605대)의 120시간 창 계산은 성능 작업 전 이 Mac(M5 Pro, 작업자 경유)에서 38~43초였고 목표는 25초 이하입니다. 킥보드 6,000 + 전기자전거 18,000대는 약 4.8~9.8초였습니다. 계산이나 저장된 창 적재가 끝나기 전에는 `/api/health/ready`가 503(본문의 `simulation.status`가 `building` 등)으로 답하고, Cloud Run startup probe가 그동안 이 인스턴스에 트래픽을 보내지 않습니다. 그래도 들어온 경로 검색은 응답의 `rentalAvailability`에 "대여 가능 위치·재고 미확인"(`supply-unavailable`)과 "위치를 계산하는 중" 안내를 붙이고, 지도 이동수단 조회는 "지금 가상 기기 위치를 계산하고 있어요"를 표시합니다. `MOBILITY_SIMULATION_READY_GATE=false`면 `/api/health/ready`가 DB만 확인합니다. 그동안에도 `/api/sim/*`, GBFS, 지도 이동수단 조회는 빈 목록으로 바로 답하고 계산을 기다리지 않습니다. 다음 날 계산은 05:00(KST)부터 미리 합니다. 이 계산은 요청 밖에서 돌기 때문에, 환경 파일의 `MOBILITY_SIMULATION`에 `scooter`나 `ebike`(`e-bike`)가 들어 있으면 `deploy/cloud-run.ps1`이 `--cpu 2 --no-cpu-throttling --cpu-boost`를 붙입니다(요청 기반 CPU에서는 계산이 거의 진행되지 않음, 작업자와 요청이 CPU를 하나씩 씀). CPU 상시 할당 비용이 늘어납니다. Cloud Run 1 vCPU당 계산이 이 Mac보다 느려 시작 직후 첫 창은 약 35~60초 걸릴 것으로 추정하며, 배포한 리비전에서 확인하지 않았습니다(미검증).
- 메모리: 6,000 + 18,000대일 때 이 Mac에서 전체 서버(tsx)는 시뮬레이터 없이 398 MB, 두 창을 계산한 뒤 577 MB(최고 598 MB)였습니다. 실규모 67,538대에서는 시뮬레이터만 띄운 Node의 작업자 경유 RSS 최고값이 478~537 MB(성능 작업 전)였고, 전체 서버는 계산 중 최고 1,100 MB, 두 창을 둔 평상시 950 MB 이하를 목표로 합니다. 작업자 힙 한도와 측정값은 설계 문서 §11, §21.2에 있습니다. `deploy/cloud-run.ps1`은 `MOBILITY_SIMULATION`이 켜져 있으면 `--cpu 2 --memory 2Gi`, 꺼져 있으면 지금처럼 `--cpu 1 --memory 512Mi`로 배포합니다. Cloud Run(Linux, 컴파일된 JS)에서의 RSS와 계산 시간은 배포한 리비전에서 다시 확인해야 합니다(미검증). 창 저장소를 켜고 저장된 창이 없을 때(miss)는 작업자가 창을 압축하느라 약 80 MB를 더 씁니다(추정).
- 창 저장소(`MOBILITY_SIMULATION_WINDOW_DIR`): 계산한 하루치 창을 `날짜_키.simwin.zst`(zstd, 실규모 약 21 MB/일)로 저장해, 재시작·재배포·새 인스턴스가 다시 계산하지 않고 읽습니다(이 Mac에서 적재 약 0.1초). 키는 모델 버전, 시뮬레이터 코드·데이터 파일 해시, 차종별 대수, seed, 날짜·창 범위의 sha-256이므로 코드나 가정값이 바뀌면 자동으로 새로 계산합니다. 읽을 때 키, 입력값, 열마다의 sha-256, zstd 체크섬을 모두 확인하고 하나라도 다르면 그 파일을 지우고 다시 계산합니다. 빈 값이면 저장하지 않습니다(기본). 로컬은 `example.env`의 `.cache/sim-windows`(git·Docker 제외)를 씁니다. Cloud Run의 로컬 디스크는 메모리이므로 서울 리전 Cloud Storage 버킷을 `/sim-windows`에 볼륨으로 붙이고 값을 `/sim-windows`로 둡니다. `deploy/cloud-run.ps1 -SimulationWindowBucket <버킷>`이 볼륨을 붙이며, 값과 버킷 중 하나만 있으면 배포 전에 멈춥니다. 버킷은 지도 타일용 공개 버킷과 따로 비공개로 만듭니다.

  ```bash
  gcloud storage buckets create gs://your-project-id-sim-windows --location=asia-northeast3 \
    --uniform-bucket-level-access --public-access-prevention
  # lifecycle.json: {"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}
  gcloud storage buckets update gs://your-project-id-sim-windows --lifecycle-file=lifecycle.json
  gcloud storage buckets add-iam-policy-binding gs://your-project-id-sim-windows \
    --member=serviceAccount:jigakmap-api@your-project-id.iam.gserviceaccount.com --role=roles/storage.objectUser
  gcloud storage buckets describe gs://your-project-id-sim-windows --format='value(location)'  # ASIA-NORTHEAST3
  ```

  서버는 어제~모레 날짜의 파일만 남기고, 같은 날짜의 옛 키는 하루가 지나면, 12개를 넘으면 오래된 날짜부터 지웁니다. 버킷의 7일 lifecycle이 한 번 더 지웁니다. Cloud Storage FUSE 읽기·쓰기 시간은 배포한 리비전에서 확인하지 않았습니다(미검증).

- 시뮬레이터를 켜면 `deploy/cloud-run.ps1`이 `--min-instances 1`(직접 지정은 `-MinInstances`)과 `/api/health/ready` startup probe(5초 간격, 최대 300초)를 붙입니다. probe는 시뮬레이터를 꺼도 붙습니다. 상시 1대 비용은 하루 약 3~4달러로 추정합니다(미검증). 창 저장 버킷이 없으면 새 인스턴스마다 창을 직접 계산하므로 심사 기간에는 `MaxInstances = 2` 이하를 권장합니다.
- 켜면 지도 이동수단 조회에 `시연용 가상 킥보드`·`시연용 가상 전기자전거` 표시가 붙은 차량이 나오고, 경로 검색은 이 차량으로 킥보드·전기자전거 구간을 만들 수 있습니다(가상 요금: 킥보드 잠금 해제 1,000원·분당 150원, 전기자전거 잠금 해제 600원(00~06시 1,000원)·분당 160원, 잠금 해제 30초·반납 45초). 경로 구간에는 `simulated: true` 출처가 붙습니다.
- 읽기 전용 조회(공개 요청 한도 적용): `GET /api/sim/status`(상태별 대수, 오늘 집계, 작업조, 차종별 `byType`), `GET /api/sim/events`(`since` 또는 `cursor`, `limit` 1~500, `types`, `vehicleTypes`=`kick-scooter`·`e-bike`, `lat`·`lon`·`radius`. 차량이 있는 사건에는 `vehicleType`), `GET /api/sim/crews`(작업조·거점·보관소, 차종별 적재·재고), `GET /api/sim/gbfs/gbfs.json`, `system_information.json`, `vehicle_types.json`(`sim-kick-scooter`, `sim-e-bike`), `vehicle_status.json`(선택: `lat`, `lon`, `radius`. 조건이 없으면 거리의 차량 전부, 봉투에 `total`·`truncated`). GBFS v3.0 형식을 따르지만 실제 운영사 피드가 아닙니다. 요청 한도는 `/api/sim/*` 경로마다 따로 분당 60회입니다(mvp 서버도 같음). 금액·범칙금·견인은 모두 가정값이며 실제 법령·조례 금액과 다를 수 있습니다.

`AUTH_DATABASE_PATH`, `ETA_OBSERVATION_DATABASE_PATH`, `ETA_CONTEXT_MODEL_PATH`, `ETA_JOURNEY_MODEL_PATH`는 폐기되었습니다. 해당 데이터는 Cloud SQL을 사용합니다. 기존 SQLite 데이터/JSON 모델 파일이 자동 이관된 것으로 간주하지 말고 실제 데이터 이관 계획을 세웁니다.

## 선택: PowerShell 스크립트 배포

아래 예제는 계획 출력만 합니다. 프로젝트, 리소스 이름, 버전을 실제 값으로 바꿉니다. 비밀 본문은 CLI 인수에 넣지 않습니다.

```powershell
$deployment = @{
  ProjectId = 'your-project-id'
  Region = 'asia-northeast3'
  Service = 'jigakmap-api'
  ArtifactRepository = 'jigakmap'
  ImageTag = 'release-20261029-1'
  InstanceConnectionName = 'your-project-id:asia-northeast3:jigakmap-db'
  ServiceAccount = 'jigakmap-api@your-project-id.iam.gserviceaccount.com'
  DbPasswordSecret = 'jigakmap-db-password:1'
  AuthEncryptionKeySecret = 'jigakmap-auth-encryption-key:1'
  SecretBindings = @{
    KAKAO_REST_API_KEY = 'jigakmap-kakao-rest-key:1'
    # 선택: 기본 키가 한도에 걸리거나 거부될 때 쓰는 예비 카카오 키입니다. 빼면 예비 키 없이 동작합니다.
    KAKAO_REST_API_KEY_FALLBACK = 'jigakmap-kakao-rest-key-spare:1'
    DATA_GO_KR_SERVICE_KEY = 'jigakmap-data-go-kr-key:1'
    # 선택: 다른 공공데이터포털 계정의 예비 키입니다. 버스 오퍼레이션 일일 한도를 다 쓰면 0시 KST까지 이 키로 넘깁니다.
    DATA_GO_KR_SERVICE_KEY_FALLBACK = 'jigakmap-data-go-kr-key-spare:1'
    # 필요한 서울 데이터/API/OAuth 비밀을 같은 방식으로 추가합니다.
  }
  MaxInstances = 10  # 시뮬레이터를 켜고 창 저장 버킷이 없으면 2 이하 권장
  MinInstances = -1  # 자동: 시뮬레이터를 켜면 1, 아니면 0
  SimulationWindowBucket = 'your-project-id-sim-windows'  # 시뮬레이터 창 저장소(서울 리전). 빈 값이면 볼륨 없음
  AllowUnauthenticated = $true
}
.\deploy\cloud-run.ps1 @deployment -PlanOnly
```

계획을 검토한 뒤 `-PlanOnly`를 제거하고 같은 스크립트를 실행합니다. 사용자 모바일/웹 앱이 직접 호출하는 공개 API 예제라 `AllowUnauthenticated`를 켰습니다. 이 설정은 Cloud Run IAM 호출 허용이며 계정 API의 애플리케이션 로그인/권한 검증은 그대로 적용됩니다. 비공개 서비스는 이 옵션을 생략하고 호출자 IAM 인증을 구성합니다.

스크립트는 Dockerfile을 Cloud Build에서 빌드하고 Artifact Registry에 올린 뒤, 동일 이미지로 Cloud Run migration Job을 배포합니다. Job의 명령은 `node dist/common/database/migrate.js`이며 단일 태스크 실행 결과를 기다립니다. 실패하면 새 서비스 배포를 중단합니다. 성공하면 Cloud SQL을 연결한 Cloud Run 서비스를 배포합니다. [Cloud Run Job 배포 CLI](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/deploy), [Job 실행과 대기](https://docs.cloud.google.com/run/docs/execute/jobs).

이 스크립트는 서비스보다 먼저 Job에서 마이그레이션을 적용하는 선택적인 경로입니다. 이후 서비스도 같은 잠금과 이력 확인을 수행하며 적용이 끝난 변경은 건너뜁니다. 기본 GitHub 배포에서는 서버가 시작 마이그레이션을 수행하므로 DB 사용자에 테이블 생성·변경 권한이 필요합니다.

## 운영 확인

- 빌드와 마이그레이션 결과, Cloud Run 시작 로그, 정상 응답 및 DB 읽기/쓰기를 확인합니다. 실제 외부 공급원 로그인과 API 응답은 유효한 키로 별도 확인합니다.
- 제공사 콘솔에 `https://실제-API-도메인/api/auth/google/callback`, `/api/auth/kakao/callback`, `/api/auth/apple/callback`을 정확히 등록합니다. Apple은 공개 HTTPS 도메인/Services ID가 필요합니다.
- 연결 수 예산은 서비스 인스턴스 수 × `DB_POOL_MAX`에 migration Job과 배포 중 구/신 리비전의 여유를 더해 정합니다. 예제 상한은 인스턴스 10개 × 풀 5개이며 실제 DB 사양에 맞춰 조정합니다.
- Cloud SQL 백업/PITR과 비밀 버전 보존을 구성합니다. 서비스 이미지를 되돌리는 것만으로 DB 스키마가 되돌아가지 않으므로 이후 마이그레이션은 이전 리비전과 호환되도록 작성합니다.
- 공개 FOSSGIS 보행 서버의 제한은 인스턴스 전체에서 공유되지 않습니다. 여러 Cloud Run 인스턴스를 운영하면 자체 OSRM endpoint와 적절한 호출량 제한을 사용합니다.
- 시뮬레이터를 켰다면 두 번째 배포 뒤 `GET /api/health`의 `simulation.source`가 `store`인지(저장된 창을 읽었는지), `simulation.windowStore`가 `configured`인지 확인합니다. 창 저장 버킷의 위치가 `ASIA-NORTHEAST3`인지도 확인합니다.
- 운영 모델(버스·지하철·따릉이)과 공휴일 달력은 직접 올리지 않고 자동 갱신 Job이 서울 버킷에 쓰며 서비스는 그 버킷을 읽기 전용 `/models`로 붙여 manifest를 따릅니다. 만들기·배포·경보·롤백은 `docs/MODEL-REFRESH.md`, 배포 스크립트는 `deploy/model-refresh-job.sh`(기본은 계획 출력만), 서비스에 붙이는 인자는 `cloud-run.ps1 -ModelBucket`입니다. 확인은 `GET /api/health`의 `modelRefresh.status`(`ok`가 정상)입니다.
- 외부 검증 모델을 쓰려면 검증된 파일을 컨테이너/읽기 전용 볼륨에 별도 제공하고 해당 절대 경로를 설정합니다. 기본 이미지는 임의 모델을 포함하지 않습니다. 학습 관측값과 contextual/journey 모델의 정상 저장 위치는 PostgreSQL입니다.

## 시작 실패 진단

Cloud Run의 `PORT=8080` 시작 실패 메시지와 함께 앱의 `exit(1)`이 기록되면 애플리케이션 시작 로그를 확인합니다. 시작 오류는 `event=startup-failed` JSON으로 기록하며 `phase`로 환경변수 검증, 의존성 초기화, 애플리케이션 초기화, 포트 수신을 구분합니다. 환경변수 오류에는 `fields`, 알려진 PostgreSQL/네트워크 오류에는 `code`와 조치 안내를 표시합니다. 비밀번호, 암호화 키, SQL 매개변수와 원본 오류 객체는 진단 로그에 넣지 않습니다.

- `AUTH_TOKEN_ENCRYPTION_KEY`는 임의 문자열이 아니라 정확히 32바이트 난수를 Base64로 인코딩한 값입니다. `example.env`의 생성 명령을 사용하고 배포 간 같은 키를 입력합니다. 기존 DB에서 이미 사용한 유효한 키는 보존합니다.
- `CORS_ORIGINS`에는 `https://app.example.com`처럼 출처만 입력합니다. 마지막 `/`나 경로가 있으면 거부됩니다. 네이티브 앱 전용이면 변수를 빈 문자열로 등록하며, 생략하면 localhost 기본값이 적용되어 production 검증에서 거부됩니다.
- 네이티브 앱의 `AUTH_PUBLIC_BASE_URL`에는 실제 Cloud Run HTTPS 주소를 입력합니다. 웹을 사용하지 않아도 현재 `AUTH_WEB_RETURN_URL` 검증에는 HTTPS 주소가 필요하므로 같은 API 주소에 `/`를 붙여 사용할 수 있습니다. 네이티브 로그인은 `jigakjido://auth`로 복귀합니다.
- `DB_NAME`은 Cloud SQL 인스턴스 ID와 별개입니다. 인스턴스의 데이터베이스 목록에 실제로 생성된 이름과 일치해야 합니다.
- `42P01`은 필요한 테이블이 없다는 뜻입니다. 시작 마이그레이션 로그, 실제 DB_NAME과 등록된 마이그레이션을 확인합니다. API 서비스 명령과 인수는 비워 기본 `node dist/main.js`를 사용합니다.

## TypeORM 전환과 기존 DB 채택

서비스는 TypeORM DataSource와 EntitySchema를 사용하며 스키마 자동 동기화를 끕니다. TypeORM 내장 `migrationsRun` 대신 Nest의 DataSource factory에서 잠금이 있는 공통 마이그레이션 실행기를 호출합니다. 마이그레이션을 완료한 DataSource만 서비스에 제공하므로 학습 저장소 등 초기 DB 조회보다 테이블 준비가 먼저 끝납니다. 기존 DB 접속 환경변수와 Cloud SQL socket 경로는 동일합니다. 계정·학습·공통 저장소는 ORM Repository/QueryBuilder와 EntityManager 트랜잭션을 사용합니다.

서버 시작 시 새 TypeORM 마이그레이션을 적용합니다. 수동 `npm run migration:run` 또는 기존 Cloud Run migration Job도 같은 실행기를 사용할 수 있습니다. 최초 설치는 스냅샷의 QueryRunner Table API로 스키마를 만들고, 기존 SQL 버전 DB는 `schema_migrations`의 `001-initial` checksum과 필수 테이블을 먼저 확인합니다. 확인이 끝나면 기존 데이터를 유지한 채 `orm_locks`와 `typeorm_migrations` 이력을 추가합니다. 이력이 없거나 checksum이 다른 기존 DB에는 적용하지 않습니다.

검사·DDL·이력 기록은 하나의 트랜잭션에서 수행하고, 기존 배포와 동일한 PostgreSQL advisory lock을 TypeORM QueryBuilder로 획득해 여러 인스턴스의 시작과 수동 실행을 직렬화합니다. 실패하면 DDL과 이력 모두 롤백됩니다. 런타임 인증·학습·요청 제한의 동시성은 최대 1,024개 잠금 버킷과 ORM의 pessimistic row lock으로 보호합니다. 각 작업은 같은 EntityManager를 끝까지 사용합니다.

보관된 SQL 세 개는 기존 배포 checksum을 계산하는 읽기 전용 호환성 자산입니다. 새 스키마 생성에 실행하지 않으며 이미지에서 제거하지 않습니다. 최초 채택 마이그레이션의 자동 rollback은 기존 데이터 보호를 위해 막혀 있습니다. 이후 변경은 새 TypeORM 마이그레이션으로 추가합니다.
