# 2026-08-28 — 대문자를 담은 id 포맷을 컷 대상에 넣는다 (ULID·nanoid·prefixed key·JWT)

- **브랜치:** `fix/mixed-case-id-shapes` (`fix/172-ground-stable-url` 위에 스택, PR #178 후속)
- **문제:** #178까지의 id 판별은 **hex 알파벳만** 알았고, 구분자 없는 세그먼트에 대문자가 있으면
  camelCase 이름으로 단정했다. 그 결과 현대 앱이 기본으로 쓰는 id 생성기 결과물이 전부 컷을 빠져나가
  스킬에 박제됐다 — ULID, nanoid, `cs_test_…` 형태의 접두사+랜덤 꼬리 키, 실물 JWT. 3차 교차검증에서
  "각주가 아니라 후속 과제"로 지적된 항목.
- **구현 — 세 가지 인식기, 전부 형태 기반:**
  ① **ULID**: Crockford base32(I·L·O·U 제외) 26자 정확 매칭. ② **JWT**: base64url 3부분 점 구분,
  각 10자 이상. ③ **숫자 밀도**: 대문자를 포함하고 8자 이상인 영숫자 토큰에서 **숫자 비율이 1/4 이상**이면
  생성된 값으로 본다. 이 비율이 랜덤 토큰과 camelCase 라우트 이름을 가르는 축이다 —
  키 꼬리 `a1B2c3D4e5F6g7H8`는 50%, nanoid 블록 `V1StGXR8`는 25%인 반면
  `checkoutV2Submit`은 6%, `getS3BucketUrl2`는 13%다.
  **전부 소문자인 토큰은 이 규칙에서 제외**했다 — 가장 이름다운 형태고, 넣으면 `sha256sum`류가 잘린다.
- **남긴 구멍:** 8자 미만 base62 슬러그(`x7Kp2Qw`), 숫자가 너무 드문 긴 토큰(`AbcdefghijKlmnop1`).
  밀도로는 이름과 못 가른다. 코퍼스에 KNOWN GAP으로 명시.
- **검증:** typecheck·build·530 테스트(+5). 코퍼스에서 KNOWN GAP 4건(ULID·nanoid·prefixed key·JWT)을
  컷 기대값으로 옮기고, **이름 쪽 반례 4건**을 새로 넣었다 — `checkoutV2Submit`·`getS3BucketUrl2`·
  `sha256sum`·`user_profile_settings`가 살아남는지가 이 규칙의 안전선이다. 실앱 도그푸딩은 안 돌림.
- **state 변화:** #178 본문의 "대문자 포함 id" 한계 해소. substring 표현형에서 오는 문제
  (1세그먼트 prefix)는 그대로 남는다.
