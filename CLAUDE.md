# 기회레이더 작업 안내 (Claude Code용)

정부 지원사업·창업·청년정책·보조금·공공입찰·공모전 공고를 공공 API 5곳에서 모아 마감일 순으로 보여 주는 사이트입니다.
기획 전체(대상 사용자, 데이터 출처, 구조, 화면, 단계별 계획, 주의할 점)는 `README.md`에 있습니다. 작업 전에 먼저 읽으세요.

## 지금 상태 (2026-10-17)
- 완료: 화면(`index.html`), 공용 규칙(`rules.js`), 수집기(`collector/collect.mjs`), 알림(`collector/notify.mjs`), Cloudflare Worker 프록시(`worker/`), 매일 수집·알림·배포 워크플로 예시(`deploy/github-pages.yml`)
- 테스트 31개 통과 (`npm test`, 네트워크 없이 고정 데이터로 실행)
- **실제 API는 아직 한 번도 호출해 보지 않았습니다.** 응답 필드는 오픈소스 프로젝트에 공개된 실제 응답에 맞춘 것입니다. 인증키를 받으면 가장 먼저 `npm run collect`로 출처별 건수와 오류를 확인하세요.
- 워크플로는 아직 꺼져 있습니다 (`.github/workflows/`로 옮겨야 동작)

## 명령
```bash
npm test             # 변환 · 맞춤도 · 알림 테스트
npm run collect      # 공고 수집 → data/opportunities.json (BIZINFO_API_KEY, DATA_GO_KR_API_KEY, YOUTH_API_KEY)
npm run notify:dry -- --current data/opportunities.json --prev data/previous.json   # 알림 미리보기 (ALERTS_JSON 필요)
npm run serve        # 로컬 서버로 화면 보기
npm run worker:dev   # Worker 로컬 실행
```

## 구조와 규칙
- `collector/sources.mjs`: 출처별 호출과 **공통 형식** 변환. 수집기와 Worker가 함께 씁니다. 출처를 추가할 때는 `normalizeXxx` + `fetchXxx`를 만들고 `SOURCES`에 등록, 고정 데이터 테스트를 `sources.test.mjs`에 추가
- `rules.js`: 유형·대상·분야·지역·상태 분류와 내 조건 맞춤도 판정. 브라우저(`window.RadarRules`)와 Node(`require`)가 같이 쓰는 UMD 파일입니다. 판정 규칙은 여기에만 두고 화면이나 알림에 복사하지 않습니다
- `index.html`: 빌드 도구 없는 단일 페이지. 색은 `:root` 토큰으로만 쓰고 다크 모드 블록 두 곳을 함께 고칩니다. 데이터가 없으면 예시 데이터(기관명 ○○, '예시' 표시)로 동작
- 인증키·알림 설정(이메일, chat ID)은 브라우저나 커밋에 넣지 않고 환경 변수/저장소 Secrets에만 둡니다
- 사용자에게 보이는 글은 한국어, 짧고 평이한 문장

## 공공 API에서 이미 확인한 함정
- 기업마당: 검색어 파라미터 없음, `pageIndex` 필수, 오류도 HTTP 200 `{"reqErr"}`
- K-Startup: 필터는 `cond[필드::EQ|LIKE]` 형식만 적용됨
- 온통청년: 2025년 새 API(`/go/ythip/getPlcy`, `apiKeyNm`), 상세 URL은 `plcyNo`로 조립, 연속 호출 시 403 → 1초 간격
- 보조금24: 1만여 건 중 기한 있는 것은 5% 정도. 기본은 기한 있는 서비스만
- 나라장터: 경로에 `/ad/` 필수, 키워드 검색은 `...PPSSrch`에서만, 조회 기간 1개월 이내
- 공모전: 전용 공공 API 없음 → 제목 키워드 추출 + `data/contests.json` 직접 등록

## 다음 할 일 후보
1. 별도 저장소로 옮기고 워크플로 켜기 (Secrets 등록, Pages 소스를 GitHub Actions로)
2. 실제 인증키로 수집해 필드 매핑 점검, 실패 출처 수정
3. 맞춤도에 매출·직원 수·업종 조건 추가, 공고문 첨부파일(PDF·HWP)에서 자격 요건 추출
4. 출처 확대: 과기정통부 사업공고 API(공공데이터포털 15074634), 지자체 공고
