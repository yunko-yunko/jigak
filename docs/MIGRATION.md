# 서버 기능 분석과 이관 내역

## 분석 대상과 구조

사용자 요청의 기존 서버는 실제 워크스페이스에서 `C:/jigak_old/perception-map/mvp/server`에 있습니다. 그 디렉터리의 실행 코드와 서버가 참조하는 `mvp/src/domain`, `mvp/src/intelligence`, `mvp/src/journey/realtimeFreshness`를 분석해 이관했습니다. 프런트엔드 화면, Expo 네이티브 기능, `mvp/scripts`의 데이터 취득/전처리/Python 학습 명령은 서버 디렉터리 밖의 별도 범위입니다.

```text
src/
  main.ts                          Nest 부트스트랩, 종료 처리
  app.module.ts                    업무 모듈 결합
  modules/
    auth/                          계정·인증·설정·저장 이동·문의
    learning/                      실측 관측값과 contextual/journey 학습
    places/                        장소 검색·역지오코딩
    routing/                       복합 경로 검색
    realtime/                      도착·인벤토리·날씨·도로 소통
    models/                        외부 검증 모델 상태
    health/                        기능 상태·생존·DB 준비
  common/
    config/                        환경변수 검증
    database/                      TypeORM DataSource·트랜잭션·마이그레이션
    dto/                           공통 입력 검사
    http/                          CORS·본문 한도·오류 변환·요청 제한
    providers/                     공급원 어댑터 구성과 캐시 생명주기
    engine/                        기존 서버 알고리즘·공급원 파서·학습 수학
    shared/                        서버가 참조하는 순수 도메인·타입·시간 규칙
```

업무 모듈은 `controller`, `service`, `repository`, `dto`, `domain`으로 역할을 나눕니다. 입력이 없는 상태 조회는 별도 입력 DTO를 만들지 않습니다. controller는 HTTP 변환, service는 사용 사례와 검증, repository는 DB/외부 공급원 접근, domain은 프레임워크에 독립적인 규칙을 담당합니다. `common/engine`은 기존 공급원 연동과 검증된 계산 로직을 보존하는 영역이고, `common/shared`는 이 엔진이 사용하는 공통 도메인 코드입니다.

## 기능별 대응

| 기존 구현                                                                            | 새 위치                                        | 보존한 동작                                                                                             |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `server/index.ts`                                                                    | `main.ts`, `common/config`, `common/providers` | 환경변수 검증, 공급원 구성, HTTP 수신, 종료 시 TypeORM DataSource 종료                                  |
| `server/app.ts` 경로 처리                                                            | `modules/routing/domain/route-search.ts`       | 최초 후보 취득, 복합 구간 확장, 시간표/실시간 보강, 그래프 비교, ETA/위험 순위, 검색 완전성 진단        |
| `server/app.ts` DTO/HTTP                                                             | 각 모듈 `dto`, `controller`, `common/http`     | 엄격한 입력 검사, 본문 한도, 오류 응답, CORS, 응답 인코딩                                               |
| `kakao.ts`                                                                           | `common/engine/kakao.ts`, `modules/places`     | 장소 검색, 역지오코딩, 공급원 경로와 실제 geometry 파싱                                                 |
| `connectivity/pedestrian.ts`, `provider.ts`                                          | 같은 상대 경로의 `common/engine`               | foot 프로필 검증, OSRM 대안, endpoint/snap 검증, 캐시, 시간 제한, 프로세스 내 공개 API 호출 간격/동시성 |
| `connectivity/query-reuse.ts`                                                        | 같은 상대 경로의 `common/engine`               | 동일 좌표 질의 재사용, 실제 HTTP 호출과 캐시 조회의 예산 구분                                           |
| `connectivity/station-transfers.ts`, `data/*`                                        | 같은 상대 경로의 `common/engine`               | 확인된 역내 환승 연결만 사용, CSV와 메타데이터 보존                                                     |
| `call-budget.ts`, `acquisition-priority.ts`                                          | `common/engine`                                | 요청당 호출 예산, 예약 슬롯, 후보 취득 순서                                                             |
| `multimodal.ts`, `rental-access.ts`, `mixed-mode-bridges.ts`, `scooter-bridge.ts`    | `common/engine`                                | 보행/달리기·자전거·대여·택시·자동차·주차·환승 연결과 각 구간의 검증                                     |
| `intermediate-transit.ts`, `transit-enrichment.ts`                                   | `common/engine`                                | 중간 허브 탐색, 실제 승강장/정류소 접근, 대기와 출발 연결                                               |
| `journey-graph.ts`, `min-priority-queue.ts`                                          | `common/engine`                                | 시간 의존 그래프 탐색, 자원 제약, required mode 도달성, 탐색 한도·최적성 진단                           |
| `realtime/bus.ts`, `seoulSubway.ts`, `service.ts`, `nearby-transit.ts`               | `common/engine/realtime`, `modules/realtime`   | TAGO/서울 버스와 지하철 도착, 진행 방향·타임스탬프·오류 검증, 공급원별 실패 격리                        |
| `realtime/subwayTimetable.ts`, `service-calendar.ts`                                 | `common/engine/realtime`                       | 첫차/막차/운행일 검사, 확인된 시간표 연결과 달력 유효기한                                               |
| `realtime/mobility.ts`, `intelligence/gbfs.ts`                                       | `common/engine`, `modules/realtime`            | 따릉이 재고, TAGO 공유 PM, GBFS v2/v3, 배터리·예약·신선도·공개 HTTPS URL 검증                           |
| `realtime/seoulTraffic.ts`, `routeTraffic.ts`, `route-conditions.ts`                 | `common/engine/realtime`                       | 진행 차로별 소통 매칭, 버스 지연, 경로 주변 돌발, 병렬 시간표/도로 보강                                 |
| `realtime/weather.ts`, `parking.ts`                                                  | `common/engine/realtime`                       | 기상청 격자·실황 검증, 공영 주차장 위치/운영/요금/재고 연결                                             |
| `intelligence/arrival.ts`, `planningTiming.ts`, `segmentTiming.ts`, `calibration.ts` | `common/engine/intelligence`                   | 도착/준비시간·위험 평가, 구간 설명, 중복 시간 보정 방지, 검증 residual 보정                             |
| `auth/oauth.ts`, `security.ts`, `types.ts`                                           | `modules/auth/domain`                          | 제공사 OAuth/OIDC, PKCE/nonce, 암호화·서명·토큰 규칙                                                    |
| `auth/router.ts`                                                                     | `modules/auth/controller`, `service`, `dto`    | 로그인, 교환, 쿠키/CSRF/Bearer, 동의, 설정, 저장 이동, 세션, 탈퇴, 문의 HTTP 계약                       |
| `auth/store.ts`                                                                      | `modules/auth/repository`                      | SQLite → TypeORM/PostgreSQL, 만료 정리, 사용자·제공사·세션·문의 저장, 단일 사용 capability              |
| `intelligence/observation-store.ts`                                                  | `modules/learning/domain`, `repository`        | 서명 수집증, 동의·완료·중복·시간 순서 검사, 관측값/전체 이동 저장, 삭제 capability                      |
| `intelligence/learning-service.ts`                                                   | `modules/learning/service`, `controller`       | 실측 데이터 학습, 검증 통과 모델만 활성화, 코호트/기준 모델 세대 보호, 상태와 삭제                      |
| contextual/journey/공개 버스/공간 모델·훈련 계산                                     | `common/engine/intelligence`                   | TypeScript 학습/추론 함수, 분할·품질/유효기간·지리 범위/특성/해시 검사                                  |
| `public-bus-service.ts`, `spatial-bicycle-service.ts`                                | `common/engine/intelligence`, `modules/models` | 읽기 전용 검증 체크포인트 로딩, 공개 버스의 보수적 구간 반영, 자전거 shadow 상태                        |
| `search-performance.ts`, `route-response.ts`, `supplier-http.ts`                     | `common/engine`, `common/http`                 | 검색 단계 지표/Server-Timing, gzip, 안전한 공급원 오류·본문 정리                                        |

실행 파일 대조에서 `app.ts`, `index.ts`, 기존 `auth/*`는 위 계층으로 분해/대체했습니다. 나머지 서버 TypeScript 파일은 `common/engine`에 대응 파일을 두었습니다. `learning-service.ts`, `observation-store.ts`는 PostgreSQL 구현으로 연결하는 호환 export입니다. `errors.ts`도 공통 오류 타입을 재수출합니다. 원본 파일과의 비교에서 62개 엔진 구현은 import/export 경로 변경 외의 계산 로직을 보존했습니다.

## API 목록

경로 앞에는 전역 `/api` 접두사가 붙습니다. 기존 계약 32개에 `health/live`, `health/ready` 2개를 추가했습니다. `:provider`는 `kakao`, `google`, `apple` 중 하나입니다.

| 번호 | Method | 경로                           | 용도                            |
| ---- | ------ | ------------------------------ | ------------------------------- |
| 1    | GET    | `/api/health`                  | 공급원 기능/모델/운영 달력 상태 |
| 2    | GET    | `/api/models/public-bus`       | 검증 공개 버스 모델 상태        |
| 3    | GET    | `/api/models/public-bicycle`   | 공개 자전거 shadow 모델 상태    |
| 4    | GET    | `/api/places`                  | 장소 검색                       |
| 5    | GET    | `/api/places/reverse`          | 역지오코딩                      |
| 6    | GET    | `/api/realtime/mobility`       | 공유 이동수단 인벤토리          |
| 7    | GET    | `/api/realtime/transit/nearby` | 주변 정류소/역과 도착 정보      |
| 8    | GET    | `/api/realtime/conditions`     | 출발지 날씨                     |
| 9    | POST   | `/api/realtime/arrivals`       | 실제 탑승 후보 도착 정보        |
| 10   | POST   | `/api/traffic/route`           | 지정 도로 구간의 소통/돌발      |
| 11   | POST   | `/api/routes/search`           | 복합 경로 탐색                  |
| 12   | POST   | `/api/routes`                  | 경로 탐색 호환 별칭             |
| 13   | GET    | `/api/auth/providers`          | 로그인 제공사와 동의 버전       |
| 14   | GET    | `/api/auth/:provider/start`    | 외부 인가 페이지로 이동         |
| 15   | GET    | `/api/auth/:provider/callback` | OAuth callback                  |
| 16   | POST   | `/api/auth/:provider/callback` | form POST callback, Apple 지원  |
| 17   | POST   | `/api/auth/exchange`           | ticket + verifier → 세션        |
| 18   | GET    | `/api/auth/me`                 | 계정과 현재 세션                |
| 19   | PATCH  | `/api/auth/me`                 | 표시 이름 변경                  |
| 20   | POST   | `/api/auth/consents`           | 필수/선택 동의 저장             |
| 21   | GET    | `/api/auth/sessions`           | 내 활성 세션 목록               |
| 22   | DELETE | `/api/auth/sessions/:id`       | 세션 폐기                       |
| 23   | POST   | `/api/auth/logout`             | 현재 세션 폐기/쿠키 제거        |
| 24   | DELETE | `/api/auth/account`            | 재인증/제공사 해제 후 계정 삭제 |
| 25   | GET    | `/api/account/preferences`     | 이동 설정 조회                  |
| 26   | PATCH  | `/api/account/preferences`     | 이동 설정 저장                  |
| 27   | GET    | `/api/account/trips`           | 저장/최근 이동 조회             |
| 28   | PUT    | `/api/account/trips`           | 저장/최근 이동 저장             |
| 29   | POST   | `/api/support`                 | 회원/비회원 문의 접수           |
| 30   | GET    | `/api/learning/status`         | 수집 수량/학습 준비/모델 상태   |
| 31   | POST   | `/api/learning/observations`   | 동의한 완료 이동 제출           |
| 32   | DELETE | `/api/learning/observations`   | 수집증 또는 삭제 token으로 삭제 |
| 33   | GET    | `/api/health/live`             | 신규: 프로세스 생존             |
| 34   | GET    | `/api/health/ready`            | 신규: DB 질의 가능 여부         |

기본 오류 응답은 `{ "error": { "code": "...", "message": "..." } }`이며 공급원 원문/키/토큰을 포함하지 않습니다. 시각 필드는 기존 계약처럼 epoch milliseconds를 사용합니다. 위치·노선·시간 범위 등 DTO의 상세 제한은 각 모듈의 `dto`에 있습니다. 웹 인증 변경 요청에는 허용 Origin과 `X-CSRF-Token`이 필요합니다. 네이티브는 Bearer token을 사용합니다.

## PostgreSQL로 변경한 영속성

계정/동의/세션/OAuth state/ticket/저장 이동/문의, ETA 관측값/전체 이동/수집증 비밀/삭제 표식/학습 시도 상태/모델, 요청 제한 카운터를 PostgreSQL에 저장합니다. OAuth state와 ticket 소비, 세션 상한은 TypeORM 트랜잭션과 pessimistic 행 잠금으로 보호합니다. 최초 소셜 계정 생성·ETA 제출/삭제/훈련·요청 제한은 공통 잠금 버킷과 동일한 EntityManager로 여러 Cloud Run 인스턴스 사이를 조정합니다.

contextual/journey 모델은 `eta_models`에 저장하고 `eta_learning_state.revision`으로 변경을 확인합니다. 경로 검색 전 refresh를 수행하여 다른 인스턴스의 모델 변경/삭제가 다음 검색에 반영되도록 했습니다. 삭제 시 해당 관측값을 학습한 두 모델을 무효화하고 재학습을 요구합니다. 수집증은 동일 DB의 난수 비밀을 사용하므로 인스턴스가 바뀌어도 검증할 수 있습니다.

기존 계정 SQLite와 관측 SQLite, JSON 모델을 자동으로 가져오지 않습니다. 실제 기존 데이터 이관에는 계정/식별자/암호화된 grant/세션/수집증 비밀/동의 버전의 호환성을 확인하는 별도 작업이 필요합니다. 기존 암호화 키를 임의 재생성하면 저장된 제공사 토큰을 복호화할 수 없습니다.

## 환경변수와 기본값

전체 설정과 설명은 [example.env](../example.env), 배포 절차는 [DEPLOYMENT.md](DEPLOYMENT.md)에 있습니다.

| 항목                                                  | 기본값/제약                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `NODE_ENV`, `HOST`, `PORT`                            | `development`, `0.0.0.0`, `8080`; Cloud Run에서는 `NODE_ENV=production`, PORT 자동 주입 |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`            | `127.0.0.1`, `5432`, `jigakmap`, `jigakmap`; Cloud Run DB_HOST는 Cloud SQL socket       |
| `DB_PASSWORD`                                         | 비어 있지 않은 값 필수; 운영 Secret Manager                                             |
| `DB_POOL_MAX`, `DB_SSL`                               | `5`(1~50), `false`; socket은 proxy 암호화 사용                                          |
| `TRUST_PROXY_HOPS`                                    | `0`(0~5); Express가 신뢰할 프록시 hop 수를 실제 배포 토폴로지에 맞춰 설정               |
| `ROUTE_INTERMEDIATE_HUBS`, `ROUTE_CALL_LIMIT`         | `2`(0~2), `28`(1~32)                                                                    |
| `PEDESTRIAN_ROUTING_ENABLED`, `ROUTE_METRICS_ENABLED` | `true`, `false`                                                                         |
| `CORS_ORIGINS`                                        | 로컬 `http://localhost:8081,http://127.0.0.1:8081`; 운영은 정확한 HTTPS 출처            |
| `AUTH_PUBLIC_BASE_URL`, `AUTH_WEB_RETURN_URL`         | `http://localhost:8080`, `http://localhost:8081/`; 운영 HTTPS 필수                      |
| `AUTH_TOKEN_ENCRYPTION_KEY`                           | 운영 필수, 32바이트 Base64                                                              |
| 공급원 API/OAuth 키                                   | 기본 비활성; 지도 키와 로그인 키는 별도                                                 |
| 외부 모델 경로 3개                                    | 빈 값이면 명시적 외부 모델 비활성                                                       |

`AUTH_DATABASE_PATH`, `ETA_OBSERVATION_DATABASE_PATH`, `ETA_CONTEXT_MODEL_PATH`, `ETA_JOURNEY_MODEL_PATH`는 더 이상 사용하지 않습니다.

공유 DB의 API 요청 제한은 검색 30회/분, learning/공개 조회 60회/분이며 인증의 제한된 endpoint는 60회/15분입니다. IP 식별에는 Express가 검증된 proxy 설정으로 계산한 `request.ip`를 사용합니다. 기본 `TRUST_PROXY_HOPS=0`은 forwarding header를 신뢰하지 않으므로 프록시 뒤에서 여러 사용자가 같은 주소로 합산될 수 있습니다. 실제 토폴로지를 확인하지 않고 임의 forwarding header를 신뢰하도록 바꾸지 않습니다.

이 DB 기반 사용자 요청 제한과 공급원별 요청 속도는 별개입니다. 공급원 응답 캐시·장애 차단 상태·GBFS/공개 버스 모델 카운터·공개 FOSSGIS 요청 간격/동시성은 프로세스 범위입니다. 여러 Cloud Run 인스턴스에서 공급원 전체 한도를 보장하려면 자체 OSRM 또는 별도의 공유 호출량 정책이 필요합니다.

## 모델·시간표의 운영 조건

- `ETA_MODEL_PATH`는 유효한 residual 보정 JSON 파일입니다. parser의 버전·표본·검증 성능·유효기간을 통과해야 사용하며 잘못된 명시 설정은 시작 오류가 될 수 있습니다.
- `ETA_PUBLIC_BUS_MODEL_PATH`는 읽기 전용 공개 버스 체크포인트입니다. parser/기간/지역/문맥 게이트를 만족하는 경우에만 적용하고 공급원의 원래 상한 ETA를 줄이지 않습니다. 경로·키를 설정했다는 이유만으로 모델을 활성화하지 않습니다.
- `ETA_PUBLIC_BICYCLE_SHADOW_DIRECTORY`에는 서로 해시와 protocol이 맞는 `model.json`, `report.json`, `protocol.json`이 있어야 합니다. 이 모델은 연구 상태이며 경로 ETA/추천을 대체하지 않습니다.
- contextual/journey 모델의 TypeScript 훈련 함수와 상태/추론은 보존했습니다. `mvp/scripts`의 원천 데이터 수집, Python 준비/학습, 배치 스케줄과 외부 체크포인트 생산은 이관했다고 주장하지 않습니다. 새 이미지에는 과거 개인 데이터나 학습 체크포인트를 포함하지 않습니다.
- 한국 운행일 달력과 서울 역내 환승 CSV는 빌드 시 복사하는 실행 자산입니다. 현재 달력 파일의 검토기한은 `2026-11-15T00:00:00+09:00`입니다. 이는 기존 검토 메타데이터이며 이번 이관에서 공휴일 근거를 새로 검증한 표시가 아닙니다. 파일 누락·손상·연도 불일치·검토기한 만료 시 운행 요일/시간표를 임의 추정하지 않고 미확인으로 처리합니다. `GET /api/health`의 `operatingData.serviceCalendar`에서 상태를 확인합니다.
- 저장 데이터가 없으면 모델을 학습 완료로 표시하지 않습니다. 관측 수량 기준만 충족해도 품질·분할/코호트 게이트를 통과하지 못하면 비활성 상태를 유지합니다.

## 검증 범위와 실제 운영에서 확인할 항목

Node.js 24.11 이상에서 `npm ci` → `npm run build` → `npm run migration:run` → `npm start` 순서로 운영 실행물을 준비합니다. `npm run typecheck`, `npm test`로 타입과 회귀 테스트를 검증합니다. 빌드는 TypeScript ESM과 SQL/JSON/CSV 실행 자산을 `dist`에 생성합니다.

20개 레거시 핵심 엔진 테스트 파일에 포함된 210개 사례를 보존했고, 별도 OAuth/계정/학습 PostgreSQL 테스트를 추가했습니다. 회귀 테스트는 그래프 최적성/도달성, 대기·자원 제약, 보행 geometry와 HTTP 수명주기, 호출 예산, 인벤토리/GBFS, 도로 지연·공급원 신선도, 공개 버스 보정과 공간 모델의 수치 재현을 다룹니다. 테스트용 수치 fixture는 학습 완료 데이터나 운영 모델로 사용하지 않습니다.

실제 GCP 리소스 생성/배포, Cloud SQL 실접속, 실제 공급원 인증/조회와 사용자의 Google·카카오·Apple 로그인은 실행하지 않았습니다. 단위/통합 테스트의 모의 응답과 PGlite 기반 저장소 검증은 이 운영 확인을 대신하지 않습니다. 외부 문의 발송/답변, 푸시 전달, 제공사 앱 심사, Apple 서버 알림은 기존에도 연결되지 않은 기능이며 이번 이관에서 구현 완료로 표시하지 않습니다.

## SQL 직접 실행에서 TypeORM으로 변경

계정 8개·학습 6개·공통 요청 제한·잠금 엔티티를 EntitySchema로 명시했습니다. DB의 snake_case 이름은 유지하며 bigint 시간/카운터는 안전 정수 transformer로 변환합니다. API/도메인 DTO와 ORM 레코드는 분리합니다. 직접 `pg.Pool`, `client.query()`를 사용하던 코드와 테스트용 수동 SQL 저장소 어댑터는 제거했습니다. 학습 revision과 두 체크포인트는 하나의 LEFT JOIN QueryBuilder 조회로 읽어 일관된 스냅샷을 유지합니다.

TypeORM 초기 마이그레이션은 현재 엔티티에서 매번 재생성하지 않는 고정 Table 스냅샷입니다. 기존 SQL 배포의 checksum과 데이터를 보존하고 신규 이력은 `typeorm_migrations`에 저장합니다. 기존 SQL 보관본은 checksum 확인에만 사용합니다. 자세한 실행·생성·기존 DB 채택 절차는 README와 DEPLOYMENT.md를 따릅니다.
