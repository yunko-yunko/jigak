# 지각지도 API

기존 `C:/jigak_old/perception-map/mvp/server`의 서버 기능을 TypeScript + NestJS로 이관한 백엔드입니다. 목적별 모듈과 `controller → service → repository` 진입 경로를 두고, 입력 계약은 `dto`, 업무 규칙은 `domain`, 공통 알고리즘과 인프라는 `common`에 배치했습니다. 영속 데이터는 TypeORM EntitySchema·Repository·EntityManager를 통해 PostgreSQL에 저장하며 GCP Cloud Run + Cloud SQL 배포 파일을 제공합니다.

## 실행

Node.js **24.11 이상**, npm, 로컬 PostgreSQL 또는 Docker가 필요합니다.

```powershell
Copy-Item example.env .env
npm ci
docker compose up -d postgres
npm run build
npm run start:dev
```

기본 API 주소는 `http://localhost:8080/api`입니다. 빌드한 서버는 `npm start`로 실행합니다. API까지 Docker로 실행하려면 `.env` 작성 후 `docker compose up --build`를 사용합니다. 서버는 DB에 연결한 뒤 TypeORM 마이그레이션을 자동 적용하고 API를 시작합니다. 빈 DB도 최초 시작 시 테이블을 생성하며, 재시작 시 이미 적용된 마이그레이션은 건너뜁니다.

```powershell
npm run typecheck
npm test
npm run env:deployment
```

소스·설정·문서의 포맷은 `npm run format`으로 정리하고 `npm run format:check`로 확인합니다. 들여쓰기는 공백 2칸, 줄 길이는 100자, 줄 끝은 LF를 사용합니다. 적용된 DB의 checksum을 유지해야 하는 마이그레이션 SQL과 해시로 검증하는 원본 CSV, 생성물과 비밀 파일은 포맷 대상에서 제외합니다.

`example.env`에는 각 환경변수의 설명이 있습니다. 로컬 Compose 비밀번호는 개발 전용이며 운영 값은 Cloud Run 콘솔의 환경변수 또는 Secret Manager로 공급합니다. 소셜 로그인 제공사와 외부 API는 자격 증명이 설정된 경우에만 사용할 수 있습니다.

## 구현 범위

| 모듈       | 기능                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `places`   | 카카오 장소 검색, 역지오코딩                                                                                                     |
| `routing`  | 경로 검색/별칭 API, 중간 환승, 보행/달리기/자전거/택시/자동차 비교, 공유 이동수단 연결, 도착시간·위험 평가, 호출 예산, gzip 응답 |
| `realtime` | 버스·지하철 도착, 주변 정류소, 따릉이/TAGO PM/GBFS, 날씨, 경로 도로 소통·돌발 조회                                               |
| `auth`     | Google·카카오·Apple OAuth, PKCE·단일 사용 ticket, 웹 쿠키/CSRF·네이티브 Bearer 인증, 동의, 세션, 탈퇴, 설정·저장 이동, 문의      |
| `learning` | 동의한 실측 이동 수집/삭제, 서명 수집증, contextual/whole journey 학습·검증·저장·예측                                            |
| `models`   | 검증된 공개 버스 모델과 공개 자전거 shadow 모델의 상태                                                                           |
| `health`   | 기존 기능/공급원 상태, 프로세스 생존 및 DB 준비 상태                                                                             |

공급원 파서·네트워크 어댑터·그래프·학습 수학은 `src/common/engine`, 서버가 사용하는 순수 도메인/타입/예상시간 규칙은 `src/common/shared`에 있습니다. 주차 조회와 시간표 처리는 경로 탐색에 연결되어 있습니다. 킥보드 경로는 검증된 라우팅 공급원과 대여 정책이 있어야 활성화되며, 재고 키만으로 이동 경로를 생성하지 않습니다.

기존 32개 HTTP method/path 계약과 신규 상태 확인 2개를 제공합니다. 전체 API 목록과 기능별 이관 위치는 [이관 분석](docs/MIGRATION.md)에 있습니다.

## TypeORM 저장소와 마이그레이션

`src/common/database/data-source.ts`에서 연결을 구성하고, 업무별 EntitySchema는 `src/modules/auth/repository/entities`와 `src/modules/learning/repository/entities`에 둡니다. 공통 요청 제한과 잠금 엔티티는 `src/common/database/entities`에 있습니다. `DatabaseService`는 ORM Repository와 EntityManager 트랜잭션을 제공하며 직접 SQL 실행 인터페이스는 제공하지 않습니다. `pg`는 TypeORM의 PostgreSQL 드라이버로만 사용합니다.

운영·개발 모두 `synchronize: false`, `migrationsRun: false`입니다. Nest의 DataSource 생성 과정에서 DB 연결 → PostgreSQL advisory lock 획득 → 명시적인 TypeORM 마이그레이션 → API 시작 순서로 실행합니다. TypeORM 기본 자동 실행 대신 잠금이 있는 공통 실행기를 사용하며, 실패하면 연결을 정리하고 서버 시작을 중단합니다. 수동 실행이 필요하면 `npm run migration:run`도 사용할 수 있습니다. `typeorm_migrations` 이력으로 중복 적용을 막고, 기존 SQL 버전의 `schema_migrations`와 checksum이 확인되면 기존 테이블·계정·세션·학습 기록을 그대로 채택합니다. `.sql` 파일 세 개는 이 호환성 검증용 보관본이며 새 서버의 스키마 생성에는 실행하지 않습니다. 내용을 수정하거나 제거하지 않습니다.

새 엔티티 변경의 마이그레이션은 개발 DB에서 생성합니다.

```powershell
npm run migration:generate -- src/common/database/migrations/AddNewFeature
```

생성된 클래스를 `src/common/database/migrations/index.ts`의 `TYPEORM_MIGRATIONS`에 등록하고, 변경 내용을 검토한 뒤 빌드·테스트합니다. 최초 채택 마이그레이션은 데이터 보호를 위해 자동 되돌리기를 거부하므로 복구용 스키마 변경은 별도 전진 마이그레이션으로 작성합니다.

## 배포

- [주석이 있는 환경변수 예제](example.env)
- [Cloud Run / Cloud SQL 배포 안내](docs/DEPLOYMENT.md)
- [배포 환경변수 YAML 예제](deploy/cloud-run.env.example.yaml)
- [PowerShell 배포 스크립트](deploy/cloud-run.ps1)
- [Dockerfile](Dockerfile)

기본 배포는 Cloud Run 콘솔의 GitHub 저장소 연결을 사용합니다. 빌드 유형은 Dockerfile로 선택하고 환경변수와 Cloud SQL 연결을 설정합니다. push → Cloud Build 빌드 → Cloud Run 시작 시 마이그레이션 → API 실행으로 진행되므로 직접 이미지 주소를 지정하거나 별도 migration Job을 만들 필요가 없습니다. DB 사용자는 마이그레이션에 필요한 테이블 생성·변경 권한을 가져야 합니다.

`npm run env:deployment`는 필요한 배포 환경변수 이름과 설명을 출력합니다. Cloud SQL 연결에는 `DB_HOST=/cloudsql/프로젝트:리전:인스턴스`를 사용합니다. Cloud Run의 `PORT`는 컨테이너 포트 설정에서 주입하므로 배포 env 파일에 추가하지 않습니다. 기존 PowerShell 스크립트와 수동 마이그레이션 명령은 선택적인 별도 배포 도구입니다.

계정·관측값·학습 모델·요청 제한 카운터는 DB를 공유합니다. 공급원 응답 캐시와 공개 보행 서버의 요청 간격 제한은 프로세스 단위입니다. 여러 인스턴스에서는 자체 OSRM 공급원과 서비스 전체 호출량 정책을 사용해야 합니다. `TRUST_PROXY_HOPS` 기본값은 `0`이며 실제 프록시 구성을 확인한 후 설정합니다.

## 검증과 남은 운영 설정

핵심 엔진의 레거시 회귀 테스트 20개 파일, 210개 사례를 보존했습니다. OAuth와 PostgreSQL 저장소/학습 동작을 검증하는 별도 테스트도 포함합니다. 테스트의 모의 공급원 응답과 PGlite 검증을 실제 외부 API·Cloud SQL 인증 성공으로 표시하지 않습니다.

실제 GCP 리소스 생성과 배포, 유효한 API 키를 사용한 공급원 호출, 실제 사용자 소셜 로그인은 수행하지 않았습니다. 기존 SQLite 데이터와 학습 체크포인트는 자동 가져오기하지 않습니다. 공개 모델은 명시적으로 제공한 검증 파일만 사용하며, Python 등 기존 `mvp/scripts`의 오프라인 학습 파이프라인은 이번 서버 이관 범위에 포함하지 않습니다. 달력 데이터의 누락·검토기한 만료 시 시간표 요일을 임의 확정하지 않습니다.
