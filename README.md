# EditSfx

브라우저에서 동작하는 무료 사운드 편집기입니다. 게임 효과음이나 일반 오디오를 **자르고, 이어붙이고, 합성**하고, 피치·속도·음량·페이드 등 다양한 효과를 적용해 **MP3 / WAV**로 내보냅니다. 설치가 필요 없고, 올린 파일은 서버로 전송되지 않으며 모든 처리는 브라우저 안에서 이루어집니다.

테마는 Windows XP(Luna) 느낌으로, 순수 CSS만으로 구현했습니다(외부 이미지·상표 미사용).

---

## 주요 기능

- **개별 파일 편집** — 파형에서 구간을 드래그 선택해 자르기. 최소 길이 0.026초 보장.
- **이어붙이기** — 여러 소리를 순서대로 연결하고 각 소리 뒤 간격(초) 지정. 드래그로 순서 변경.
- **합성·믹스** — 같은 타임라인에 여러 소리를 겹치고 시작 시점·음량 조절.
- **세부 효과** — 피치(반음), 속도(타임 스트레치), 음량(dB), 페이드 인/아웃, 거꾸로 재생.
- **내보내기** — MP3(기본) 또는 WAV. MP3 인코더를 못 불러오면 자동으로 WAV로 대체.

---

## 폴더 구조

```
EditSfx/
├─ index.html          메인 편집기 + 소개/기능/사용법/FAQ
├─ about.html          사이트 소개(독립 페이지)
├─ privacy.html        개인정보처리방침
├─ 404.html            오류 페이지
├─ robots.txt          검색엔진 크롤링 안내
├─ sitemap.xml         사이트맵
├─ css/
│  └─ xp-theme.css     Windows XP 테마 전체
├─ js/
│  ├─ app.js           UI 컨트롤러(탭/버튼/파일 처리/재생/내보내기)
│  ├─ waveform.js      파형 캔버스 렌더 + 구간 선택
│  └─ engine/
│     ├─ dsp.js        순수 DSP 함수(게인/페이드/리샘플/타임스트레치/피치)
│     ├─ wav.js        WAV(16-bit PCM) 인코더
│     └─ audio-engine.js  Web Audio 래퍼(디코드/자르기/효과/이어붙이기/믹스/내보내기)
└─ assets/             (여유 폴더)
```

### 설계 원칙
- **빌드 도구 없음**: 일반 `<script>` 태그 + 전역 `window.EditSfx.*` 네임스페이스. 
- **엔진과 UI 분리**: `js/engine/`의 순수 함수는 화면과 무관하게 재사용·테스트 가능(Node에서 단위 테스트 완료). 새 기능은 보통 엔진에 함수 추가 → `app.js`에서 버튼·이벤트 연결 순서로 확장합니다.
- 스크립트 로드 순서(중요): `lamejs → dsp → wav → audio-engine → waveform → app`. `index.html` 하단에 이미 이 순서로 작성되어 있습니다.

---

<!-- <!-- <!-- ## GitHub Pages 배포 방법

1. 이 폴더 전체를 GitHub 저장소에 올립니다(예: 저장소 이름 `EditSfx`).
2. 저장소 **Settings → Pages**로 이동합니다.
3. **Build and deployment → Source**를 **Deploy from a branch**로 설정합니다.
4. **Branch**를 `main`(또는 사용 중인 브랜치), 폴더는 `/ (root)`로 지정하고 저장합니다.
5. 잠시 후 `https://<사용자명>.github.io/EditSfx/` 주소로 접속됩니다.

> 프로젝트 페이지가 아니라 사용자/조직 페이지(`<사용자명>.github.io` 저장소)로 올리면 주소에 `/EditSfx/`가 빠집니다. 그 경우 아래 도메인 치환에서 경로를 함께 맞춰주세요. -->

--- -->

## 배포 전 꼭 바꿔야 할 placeholder

코드 곳곳에 임시 도메인 `https://example.github.io/EditSfx/`가 들어 있습니다. 실제 주소로 일괄 치환하세요.

- `index.html` — `<link rel="canonical">`, Open Graph/Twitter URL, JSON-LD `url`
- `about.html`, `privacy.html` — `canonical`, Open Graph URL
- `robots.txt` — `Sitemap:` 줄
- `sitemap.xml` — 모든 `<loc>`

또한:
- **AdSense 연락처**: `privacy.html` 9번 항목의 운영자 연락처를 실제 값으로 채우세요(심사 시 권장).
- **AdSense 광고 코드**: 심사 승인 후 발급되는 스크립트를 `index.html` `<head>`에 추가하면 됩니다.

---

## 로컬에서 미리보기

브라우저 보안 정책상 파일을 더블클릭(`file://`)하면 일부 기능이 제한될 수 있습니다. 간단한 로컬 서버로 여는 것을 권장합니다.

```bash
# Python 3
python3 -m http.server 8000
# 그 후 http://localhost:8000/ 접속
```

--- -->

## 브라우저 호환성

Web Audio API와 Canvas를 사용합니다. 최신 데스크톱 Chrome / Edge / Firefox에서 가장 안정적으로 동작합니다. MP3 내보내기는 오픈소스 `lamejs` 인코더(CDN)를 사용하며, 차단된 환경에서는 자동으로 WAV로 대체됩니다.

---

## 라이선스 / 크레딧

- MP3 인코딩: [lamejs](https://github.com/zhuker/lamejs) (CDN 로드)
- 테마: Windows XP에서 영감을 받은 순수 CSS 구현(상표·이미지 미사용)
