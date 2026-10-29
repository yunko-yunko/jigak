# GCP Cloud Run / Cloud SQL 배포

이 서버는 Node.js 24.11 이상과 NestJS·TypeORM을 사용하는 API입니다. 계정, OAuth 임시 상태, 세션, 저장 이동, 문의, ETA 관측값과 contextual/journey 학습 모델을 PostgreSQL에 저장합니다. 서비스 인스턴스의 로컬 파일을 영속 저장소로 사용하지 않습니다. 이 저장소에는 배포 준비 파일만 작성되어 있으며 실제 GCP 리소스 생성이나 배포는 수행하지 않았습니다.

## 로컬 실행

```powershell
Copy-Item example.env .env
npm ci
docker compose up -d postgres
npm run build
npm run migration:run
npm run start:dev
```

`.env`의 `DB_PASSWORD=local-development-only`는 Compose의 개발 DB에만 사용합니다. 운영용 값과 구분합니다. API와 마이그레이션까지 컨테이너로 실행하려면 `docker compose up --build`를 사용합니다. Compose는 DB 상태 확인 → 별도 마이그레이션 → API 순서로 시작합니다.

## 배포 전 준비

1. 결제가 연결된 GCP 프로젝트와 같은 리전의 Artifact Registry Docker 저장소, Cloud SQL **PostgreSQL** 인스턴스, 빈 데이터베이스와 DB 사용자를 준비합니다. 예제 리전은 서울 `asia-northeast3`입니다.
2. Cloud Run, Cloud Build, Artifact Registry, Cloud SQL Admin, Secret Manager API를 활성화합니다. Cloud Build 실행 주체는 이미지 저장소에 이미지를 쓸 수 있어야 합니다.
3. 런타임 서비스 계정에 `roles/cloudsql.client`를 부여합니다. 이 계정에는 사용하는 각 비밀에 대한 `roles/secretmanager.secretAccessor`도 필요합니다. 배포 실행 주체에는 Cloud Run 서비스/Job 배포, 해당 서비스 계정 사용, Cloud Build 실행 권한이 필요합니다. 권한 부여와 리소스 생성은 스크립트에서 자동 수행하지 않습니다.
4. DB 비밀번호와 `AUTH_TOKEN_ENCRYPTION_KEY`를 별도 Secret Manager 비밀로 저장합니다. 암호화 키는 정확히 32바이트 난수의 Base64 값입니다. 기존 계정 데이터와 함께 보존해야 합니다. 설정한 제공사의 API/OAuth 비밀도 각각 저장합니다.

Cloud Run에 Cloud SQL 인스턴스를 연결하면 `DB_HOST=/cloudsql/프로젝트:리전:인스턴스`로 접속할 수 있습니다. Unix socket 연결은 Cloud SQL Auth Proxy가 암호화하므로 `DB_SSL=false`를 사용합니다. 이 배포 예제는 Cloud SQL의 public-IP/proxy 경로를 사용합니다. private-IP 전용 인스턴스는 별도 VPC 경로와 접속 설정이 필요합니다. [Cloud SQL 공식 연결 안내](https://docs.cloud.google.com/sql/docs/postgres/connect-run).

Secret Manager 환경변수는 명시적인 숫자 버전으로 고정합니다. 예제의 `secret-name:1`에서 `1`은 실제 생성된 비밀 버전으로 바꿉니다. [Cloud Run 공식 비밀 설정 안내](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

## 환경변수 설정

```powershell
Copy-Item deploy/cloud-run.env.example.yaml deploy/cloud-run.env.yaml
npm run env:deployment
```

`cloud-run.env.yaml`의 `REPLACE_*` 값을 전부 바꿉니다. 비밀 값은 이 파일에 넣지 않습니다. `DB_HOST`의 인스턴스 연결 이름은 배포 스크립트의 `InstanceConnectionName`과 같아야 합니다. `PORT`는 파일에서 제외합니다. Cloud Run이 `--port 8080`에 맞춰 자동 설정하며, 프로세스는 `HOST=0.0.0.0`에서 수신합니다. [Cloud Run 컨테이너 계약](https://docs.cloud.google.com/run/docs/container-contract).

공개 HTTPS API 주소는 `AUTH_PUBLIC_BASE_URL`, 웹 앱의 고정 복귀 주소는 `AUTH_WEB_RETURN_URL`, 정확한 웹 출처는 `CORS_ORIGINS`에 설정합니다. 운영 DNS/API 도메인을 사용하면 첫 배포 전에도 값을 고정할 수 있습니다. 서비스의 자동 URL을 쓰는 첫 배포라면 제공사를 비활성화한 상태로 배포해 URL을 확인한 다음 올바른 URL로 다시 배포합니다. 모바일 앱의 공개 API URL은 프런트엔드의 `EXPO_PUBLIC_API_URL`에 설정하며 서버의 비밀과 구분합니다.

웹 로그인 쿠키는 기존 `SameSite=Lax` 정책을 유지합니다. 웹 앱과 API는 `app.example.com`과 `api.example.com`처럼 같은 사이트의 HTTPS 도메인에 배포합니다. 서로 다른 사이트의 프런트엔드와 `*.run.app` 조합은 교차 사이트 fetch에서 로그인 쿠키가 전달되지 않으므로, 웹 로그인용 API에는 같은 사이트의 커스텀 도메인을 연결합니다. 네이티브 앱은 Bearer 세션을 사용합니다.

| 구분               | 환경변수                                                                                                                                             | 설정                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 런타임             | `NODE_ENV`, `HOST`                                                                                                                                   | `production`, `0.0.0.0`                                |
| Cloud Run 주입     | `PORT`                                                                                                                                               | `8080` (`--port`로 지정, env 파일에 추가하지 않음)     |
| DB 필수            | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`                                                                                                           | Cloud SQL socket 경로, `5432`, 실제 DB/사용자          |
| DB 비밀            | `DB_PASSWORD`                                                                                                                                        | Secret Manager 비밀 버전                               |
| 연결 풀            | `DB_POOL_MAX`, `DB_SSL`                                                                                                                              | 예제 `5`, `false` (socket)                             |
| 웹/인증            | `CORS_ORIGINS`, `AUTH_PUBLIC_BASE_URL`, `AUTH_WEB_RETURN_URL`                                                                                        | 실제 HTTPS URL/출처                                    |
| 인증 비밀          | `AUTH_TOKEN_ENCRYPTION_KEY`                                                                                                                          | 32바이트 Base64 키, Secret Manager                     |
| 지도               | `KAKAO_REST_API_KEY`                                                                                                                                 | 카카오 장소 검색/경로 기능에 사용                      |
| 공공 데이터        | `DATA_GO_KR_SERVICE_KEY`, `SEOUL_OPEN_API_KEY`, `SEOUL_BIKE_API_KEY`, `SEOUL_CITY_DATA_API_KEY`, `SEOUL_PARKING_API_KEY`                             | 사용하는 공급원별 키/활용승인                          |
| Google 로그인      | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`                                                                                               | 해당 로그인 사용 시 모두 설정                          |
| 카카오 로그인      | `KAKAO_LOGIN_REST_API_KEY`, `KAKAO_LOGIN_CLIENT_SECRET`, `KAKAO_LOGIN_OIDC`                                                                          | 해당 로그인 사용 시 설정, OIDC는 실제 활성화 시 `true` |
| Apple 로그인       | `APPLE_SERVICE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`                                                                             | 해당 로그인 사용 시 모두 설정, 개인 키는 비밀          |
| 경로/운영          | `PEDESTRIAN_ROUTING_ENABLED`, `PEDESTRIAN_OSRM_URL`, `PEDESTRIAN_USER_AGENT`, `ROUTE_INTERMEDIATE_HUBS`, `ROUTE_CALL_LIMIT`, `ROUTE_METRICS_ENABLED` | 주석 있는 `example.env` 참조                           |
| 추가 공유 이동수단 | `MOBILITY_GBFS_FEEDS`                                                                                                                                | 검증된 공개 HTTPS GBFS 피드 JSON 배열 또는 빈 값       |
| 외부 검증 모델     | `ETA_MODEL_PATH`, `ETA_PUBLIC_BUS_MODEL_PATH`, `ETA_PUBLIC_BICYCLE_SHADOW_DIRECTORY`                                                                 | 읽기 전용 파일/폴더 경로 또는 빈 값                    |

`AUTH_DATABASE_PATH`, `ETA_OBSERVATION_DATABASE_PATH`, `ETA_CONTEXT_MODEL_PATH`, `ETA_JOURNEY_MODEL_PATH`는 폐기되었습니다. 해당 데이터는 Cloud SQL을 사용합니다. 기존 SQLite 데이터/JSON 모델 파일이 자동 이관된 것으로 간주하지 말고 실제 데이터 이관 계획을 세웁니다.

## 빌드 → 마이그레이션 → 서비스 배포

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
    DATA_GO_KR_SERVICE_KEY = 'jigakmap-data-go-kr-key:1'
    # 필요한 서울 데이터/API/OAuth 비밀을 같은 방식으로 추가합니다.
  }
  MaxInstances = 10
  AllowUnauthenticated = $true
}
.\deploy\cloud-run.ps1 @deployment -PlanOnly
```

계획을 검토한 뒤 `-PlanOnly`를 제거하고 같은 스크립트를 실행합니다. 사용자 모바일/웹 앱이 직접 호출하는 공개 API 예제라 `AllowUnauthenticated`를 켰습니다. 이 설정은 Cloud Run IAM 호출 허용이며 계정 API의 애플리케이션 로그인/권한 검증은 그대로 적용됩니다. 비공개 서비스는 이 옵션을 생략하고 호출자 IAM 인증을 구성합니다.

스크립트는 Dockerfile을 Cloud Build에서 빌드하고 Artifact Registry에 올린 뒤, 동일 이미지로 Cloud Run migration Job을 배포합니다. Job의 명령은 `node dist/common/database/migrate.js`이며 단일 태스크 실행 결과를 기다립니다. 실패하면 새 서비스 배포를 중단합니다. 성공하면 Cloud SQL을 연결한 Cloud Run 서비스를 배포합니다. [Cloud Run Job 배포 CLI](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/deploy), [Job 실행과 대기](https://docs.cloud.google.com/run/docs/execute/jobs).

API 프로세스 시작 시 DDL을 실행하지 않으므로 서비스 계정이 사용하는 DB 사용자에는 런타임 DML 권한을 줄 수 있습니다. 현재 예제는 같은 DB 사용자를 Job에도 전달하므로 초기 설치 시 마이그레이션에 필요한 스키마 생성 권한이 있어야 합니다. 운영에서 권한을 나누려면 별도 migration DB 사용자/비밀을 Job에 연결합니다.

## 운영 확인

- 빌드와 마이그레이션 결과, Cloud Run 시작 로그, 정상 응답 및 DB 읽기/쓰기를 확인합니다. 실제 외부 공급원 로그인과 API 응답은 유효한 키로 별도 확인합니다.
- 제공사 콘솔에 `https://실제-API-도메인/api/auth/google/callback`, `/api/auth/kakao/callback`, `/api/auth/apple/callback`을 정확히 등록합니다. Apple은 공개 HTTPS 도메인/Services ID가 필요합니다.
- 연결 수 예산은 서비스 인스턴스 수 × `DB_POOL_MAX`에 migration Job과 배포 중 구/신 리비전의 여유를 더해 정합니다. 예제 상한은 인스턴스 10개 × 풀 5개이며 실제 DB 사양에 맞춰 조정합니다.
- Cloud SQL 백업/PITR과 비밀 버전 보존을 구성합니다. 서비스 이미지를 되돌리는 것만으로 DB 스키마가 되돌아가지 않으므로 이후 마이그레이션은 이전 리비전과 호환되도록 작성합니다.
- 공개 FOSSGIS 보행 서버의 제한은 인스턴스 전체에서 공유되지 않습니다. 여러 Cloud Run 인스턴스를 운영하면 자체 OSRM endpoint와 적절한 호출량 제한을 사용합니다.
- 외부 검증 모델을 쓰려면 검증된 파일을 컨테이너/읽기 전용 볼륨에 별도 제공하고 해당 절대 경로를 설정합니다. 기본 이미지는 임의 모델을 포함하지 않습니다. 학습 관측값과 contextual/journey 모델의 정상 저장 위치는 PostgreSQL입니다.

## TypeORM 전환과 기존 DB 채택

서비스는 TypeORM DataSource와 EntitySchema를 사용하며 스키마 자동 동기화와 시작 시 마이그레이션 실행을 모두 끕니다. 기존 DB 접속 환경변수와 Cloud SQL socket 경로는 동일합니다. 계정·학습·공통 저장소는 ORM Repository/QueryBuilder와 EntityManager 트랜잭션을 사용합니다.

`npm run migration:run` 또는 기존 Cloud Run migration Job은 새 TypeORM 마이그레이션을 적용합니다. 최초 설치는 스냅샷의 QueryRunner Table API로 스키마를 만들고, 기존 SQL 버전 DB는 `schema_migrations`의 `001-initial` checksum과 필수 테이블을 먼저 확인합니다. 확인이 끝나면 기존 데이터를 유지한 채 `orm_locks`와 `typeorm_migrations` 이력을 추가합니다. 이력이 없거나 checksum이 다른 기존 DB에는 적용하지 않습니다.

검사·DDL·이력 기록은 하나의 트랜잭션에서 수행하고, 기존 배포와 동일한 PostgreSQL advisory lock을 TypeORM QueryBuilder로 획득해 여러 Job 실행을 직렬화합니다. 실패하면 DDL과 이력 모두 롤백됩니다. 런타임 인증·학습·요청 제한의 동시성은 최대 1,024개 잠금 버킷과 ORM의 pessimistic row lock으로 보호합니다. 각 작업은 같은 EntityManager를 끝까지 사용합니다.

보관된 SQL 세 개는 기존 배포 checksum을 계산하는 읽기 전용 호환성 자산입니다. 새 스키마 생성에 실행하지 않으며 이미지에서 제거하지 않습니다. 최초 채택 마이그레이션의 자동 rollback은 기존 데이터 보호를 위해 막혀 있습니다. 이후 변경은 새 TypeORM 마이그레이션으로 추가합니다.
