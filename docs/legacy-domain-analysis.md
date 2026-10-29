# 기존 서버 도메인 분석

분석 대상은 `C:/jigak_old/perception-map/mvp/server`이며 서버에서 참조하는 `mvp/src`의 순수 TypeScript 도메인도 포함한다. 새 서버는 해당 알고리즘을 `src/common/engine`과 `src/common/shared`로 옮겨 공급자 파싱·시간 계산·그래프 탐색·학습 검증을 보존한다.

## 기능과 경계

| 기능                           | 기존 소스                                                                                                                               | 새 도메인 경계                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 장소 검색·역지오코딩·기본 경로 | `kakao.ts`                                                                                                                              | 장소/경로 모듈의 공급자 repository                                                       |
| 복합 경로·도보·대여 연결       | `multimodal.ts`, `mixed-mode-bridges.ts`, `scooter-bridge.ts`, `intermediate-transit.ts`, `rental-access.ts`                            | 경로 service와 common 순수 경로 엔진                                                     |
| 전체 여정 그래프 탐색          | `journey-graph.ts`, `min-priority-queue.ts`, `acquisition-priority.ts`                                                                  | 경로 domain: 검증된 연결만 탐색, 시간·목표에 맞춘 우선순위                               |
| 공급자 호출 예산·재사용        | `call-budget.ts`, `supplier-http.ts`, `connectivity/query-reuse.ts`                                                                     | 요청 단위 common 정책: 실패·재시도도 호출 예산 소비                                      |
| 보행 연결·역사 환승            | `connectivity/pedestrian.ts`, `station-transfers.ts`, `data/*`                                                                          | 보행/환승 공급자 repository, CSV는 읽기 전용 배포 자산                                   |
| 버스·지하철 도착               | `realtime/{bus,seoulSubway,service,names,http}.ts`                                                                                      | 실시간 모듈: 자료 시각·방면·노선·정류장 검증                                             |
| 지하철 시간표·운행일           | `realtime/{subwayTimetable,service-calendar}.ts`, `transit-enrichment.ts`                                                               | 시간표와 실시간 도착을 구분한 운행 가능성 검증                                           |
| 주변 대중교통                  | `realtime/nearby-transit.ts`                                                                                                            | 위치별 정류장·역 탐색과 도착 정보 결합                                                   |
| 대여 이동수단                  | `realtime/mobility.ts`, `intelligence/{gbfs,rental-availability}.ts`                                                                    | 공공 PM·따릉이·운영사 GBFS 및 이용 가능성                                                |
| 날씨·혼잡·교통·주차            | `realtime/{weather,seoulTraffic,seoulAreas,routeTraffic,route-conditions,parking}.ts`                                                   | 실시간 모듈과 경로 보정: 최신성·위치 일치·자료 근거 검증                                 |
| 도착 시간 평가·순위            | `intelligence/{arrival,planningTiming,segmentTiming,learning-features,journey-features,journey-reference}.ts`, 공유 domain/intelligence | 경로 domain: 시간 구간·마감 시각·준비 시간·보수적 지연 보정                              |
| 기록 기반 구간 ETA             | `contextual-model.ts`, `contextual-training.ts`, `calibration.ts`, `training.ts`                                                        | 학습 domain: 시간순 분할·독립 여정·보정/검증 표본·유효 기간·성능 기준을 유지             |
| 기록 기반 전체 여정 ETA        | `journey-model.ts`                                                                                                                      | 학습 domain: 정확히 같은 기준 세대, 서비스 일수, 미관측 경로 평가, 보수적 순위 보정      |
| 공개자료 버스 모델             | `public-bus-{model,service,timing,window,shadow,refresh}.ts`, `historical-context.ts`                                                   | 모델 domain 및 체크포인트 repository: 지원 범위·만료·재평가 날짜·출처 해시 검증          |
| 공개자료 이동수단 연구         | `public-mobility-model.ts`, `spatial-{bus,transit,bicycle}-model.ts`, `spatial-bicycle-service.ts`                                      | 연구/모델 domain: shadow 결과를 운영 경로에 자동 적용하지 않음                           |
| 공급자 도착 수집               | `arrival-collector.ts`                                                                                                                  | 제한된 관측 루프 유틸리티: 동일 차량 방문의 예측·도착을 연결, 개인정보 없는 학습 행 생성 |
| 계정·소셜 로그인·문의          | `auth/{router,oauth,security,store,types}.ts`                                                                                           | 인증/계정/문의 모듈, Cloud SQL repository, 암호화·PKCE·nonce·CSRF 유지                   |

## 영속 상태 이전

계정·수집 기록·자동 학습 모델처럼 런타임에 변경되는 로컬 SQLite와 JSON 상태는 Cloud SQL PostgreSQL로 이전한다. 선택적인 residual 보정·공개 버스·따릉이 연구 체크포인트는 검증된 읽기 전용 배포 자산으로 제공할 수 있다. Cloud Run의 임시 파일시스템을 변경 가능한 데이터의 영속 저장소로 사용하지 않는다.

| 기존 상태                                            | 보존할 데이터·규칙                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts.sqlite`                                    | 사용자, 소셜 ID/암호화 grant, 세션 토큰 해시, OAuth 상태 암호문, 일회성 로그인 ticket, 환경설정, 저장/최근 여정, 문의                         |
| `eta-observations.sqlite`                            | 서명 비밀키, 구간 관측, 전체 여정 관측, 삭제한 ticket tombstone                                                                               |
| `contextual-eta.json` / `journey-eta.json`           | 검증된 모델 JSON, 세대/revision, 학습 시도 표본 수, 비활성 사유, shadow 후보 메타데이터                                                       |
| 공개 버스 모델·따릉이 shadow `model/report/protocol` | 선택적인 읽기 전용 공급자/연구 체크포인트와 출처 검증 자료; 컨테이너 이미지 또는 읽기 전용 마운트로 제공하며 운영 적용 여부를 유지            |
| 공개 버스 갱신 journal·rollback receipt              | 별도 오프라인 모델 갱신 도구가 관리하는 사전 평가 날짜·보고서 해시·원본 해시·이전 체크포인트 등의 감사 자료; API 서버의 런타임 DB 상태와 구분 |

구간 관측은 90일/50,000행, 전체 여정은 90일/10,000행으로 제한한다. 수집 ticket은 24시간 유효하며 완료 시각·중복 제출·동의 버전·시간 순서를 검사한다. 전체 여정은 확장 동의 `eta-learning-v2`가 필요하다. 이름·좌표·계정 ID·원시 센서는 학습 특징에 저장하지 않고 경로 그룹은 서버 HMAC으로 익명화한다.

새 학습 repository는 공통 비밀키를 DB에서 한 번 생성하고 모든 인스턴스가 공유한다. 제출·삭제·학습 모델 게시가 같은 PostgreSQL advisory transaction lock을 사용한다. 삭제는 관측 삭제와 두 모델 무효화를 같은 transaction에서 처리하여 다른 인스턴스가 삭제한 자료로 모델을 다시 게시하는 경합을 방지한다. 경로 요청 시작 시 작은 revision만 읽고 변경이 있을 때 모델 JSON을 다시 불러와 다른 인스턴스의 모델 변경·삭제를 반영한다.

## 백그라운드 동작

기존 `index.ts`/`app.ts`에는 영구 `setInterval` 스케줄러가 없다. 실시간 공급자는 요청 시 캐시를 확인하고 필요할 때 호출한다. 모델 파일 재확인은 요청 시 최대 30초 간격이었다. 자동 학습은 유효한 제출로 독립 기록이 50개 이상이고 직전 시도보다 10개 이상 증가했을 때 동기적으로 시도하며 학습 실패가 기록 저장을 실패시키지 않는다.

`arrival-collector.ts`는 외부 호출자가 시작하는 유한 수집 루프다. 공개자료 수집·모델 훈련/갱신 함수도 서버 부팅 시 자동 실행되지 않는다. Cloud Run에서 지속 수집이 필요하면 별도 Job/Scheduler 호출로 실행해야 하며 API 서버의 요청 처리와 수집 정책을 구분한다.

## 기존 환경변수

서버 실행: `PORT`, `HOST`, `CORS_ORIGINS`. 경로: `KAKAO_REST_API_KEY`, `PEDESTRIAN_ROUTING_ENABLED`, `PEDESTRIAN_OSRM_URL`, `PEDESTRIAN_USER_AGENT`, `ROUTE_INTERMEDIATE_HUBS`, `ROUTE_CALL_LIMIT`, `ROUTE_METRICS_ENABLED`. 공공자료: `DATA_GO_KR_SERVICE_KEY`, `SEOUL_OPEN_API_KEY`, `SEOUL_CITY_DATA_API_KEY`, `SEOUL_BIKE_API_KEY`, `SEOUL_PARKING_API_KEY`, `MOBILITY_GBFS_FEEDS`.

인증: `AUTH_PUBLIC_BASE_URL`, `AUTH_WEB_RETURN_URL`, `AUTH_TOKEN_ENCRYPTION_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `KAKAO_LOGIN_REST_API_KEY`, `KAKAO_LOGIN_CLIENT_SECRET`, `KAKAO_LOGIN_OIDC`, `APPLE_SERVICE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`.

변경 가능한 상태를 가리키던 `AUTH_DATABASE_PATH`, `ETA_OBSERVATION_DATABASE_PATH`, `ETA_CONTEXT_MODEL_PATH`, `ETA_JOURNEY_MODEL_PATH`는 Cloud SQL 연결 설정으로 대체한다. `ETA_MODEL_PATH`, `ETA_PUBLIC_BUS_MODEL_PATH`, `ETA_PUBLIC_BICYCLE_SHADOW_DIRECTORY`는 선택적인 읽기 전용 배포 자산 경로로 유지한다. 새 서버의 실제 배포 변수와 주석은 루트 `example.env`와 배포 문서를 기준으로 한다.

## 현재 영속성 구현

기존 서버 분석에 나온 SQLite/직접 SQL 저장소는 현재 구현의 실행 경로가 아닙니다. 새 서버는 TypeORM EntitySchema, Repository/QueryBuilder, EntityManager 트랜잭션을 사용합니다. 기존 테이블과 API 계약을 유지하며 런타임 동시성은 ORM pessimistic 행 잠금으로 조정합니다. 스키마 변경은 명시적인 TypeORM 마이그레이션으로만 적용하고, 옛 SQL 파일은 기존 DB의 checksum을 검증하는 보관본으로만 읽습니다.
