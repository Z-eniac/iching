DEBUG build
===========
/health  : 서버 상태 확인
/echo    : 프론트에서 보낸 페이로드 에코
/api/read: AI 해석 (Responses API → 실패 시 Chat Completions 폴백)

로그에서 어떤 단계에서 실패했는지 확인하세요.
- 401/403: 키 권한/프로젝트 문제
- 429: 크레딧/요금제/한도 초과
- ECONN/ETIMEOUT: 네트워크/방화벽 문제

실행:
  npm install
  node server.mjs
