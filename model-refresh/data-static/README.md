# 모델 자동 갱신의 고정 입력

공공버스·공간버스·지하철 학습이 매번 읽는 작은 고정 파일 둘입니다. 바이트가 그대로 학습 입력 해시에 들어가므로 **손으로 고치거나 포맷하지 않습니다**(`.prettierignore`에 등록).

| 파일 | 바이트 | sha256 | 출처 | 이용 조건 |
|---|---|---|---|---|
| `topis-road-priors-2026-08-09.json` | 15,015 | `c54092af7b945ef8f9a59c19652c5b359933bc79f5fa0e928f5f3caff4b6ddd2` | 서울시 TOPIS 월별 도로 소통 속도(2026-08, 2026-09 공개 파일)를 요일 유형·시간대별 거리 가중 조화평균으로 묶은 집계값. 원본 파일 해시와 집계 규칙은 `topis-road-priors-2026-08-09.json.manifest.json` | 서울시 공공데이터(TOPIS) 개방 자료에서 만든 집계값입니다. 원본 행은 담지 않습니다 |
| `spatial-transit-stations.csv` | 38,362 | `f6a1eb4282660041ce791ef9391848f320a3b8f7ea7ffbd4365372ea6e5b1608` | 서울시 T-DATA 「역사 좌표」(data_id=36, 784행, 2026-10-29 수집). 수집 기록은 `spatial-transit-stations.source.json` | CC BY. 서울시 T-DATA·TAIMS 출처 표시가 필요합니다 |

## 러너가 읽는 순서

`model-refresh/scripts/model-refresh/pipelines.ts`의 `stageStaticInputs`가 아래 순서로 찾고, **위 sha256과 같은 파일만** 씁니다. 해시가 다른 파일은 경고(`static-input-mismatch`)를 남기고 건너뜁니다.

1. 스토어 `static/<이름>` (`init`이 씀. 버킷 수명주기 규칙 `raw/` 21일 삭제의 영향을 받지 않음)
2. 스토어 `raw/context/<이름>` (예전 `init`이 쓰던 자리. 21일 뒤 지워질 수 있음)
3. 이 폴더의 커밋된 사본 (Job 이미지에도 들어감)

그래서 버킷이 비어 있어도 Job은 이 사본으로 동작합니다. 파일을 바꿔야 할 때는 새 이름(예: `topis-road-priors-2026-10-11.json`)으로 더하고 `pipelines.ts`의 이름·해시 상수를 함께 바꿉니다.
