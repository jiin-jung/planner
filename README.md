<p align="center">
  <img src="src-tauri/icons/icon.png" width="96" alt="Planner" />
</p>

<h1 align="center">Planner</h1>

<p align="center">개인 일정 관리를 위한 미니멀 맥 플래너</p>

---

## 다운로드

1. [Releases](https://github.com/jiin-jung/planner/releases/latest)에서 `Planner_x.x.x_aarch64.dmg` 받기
2. dmg를 열고 **Planner**를 응용 프로그램 폴더로 끌어다 놓기
3. 터미널에서 한 번 실행

   ```bash
   xattr -cr /Applications/Planner.app
   ```

> 업데이트할 때도 같은 방법으로 덮어쓰면 되고, 데이터는 그대로 유지됩니다.

<details>
<summary>설치가 안 될 때</summary>

**"손상되었기 때문에 열 수 없습니다"**

3번 명령어를 실행하지 않은 경우예요. Spotlight(`⌘ Space`)에서 **터미널**을 열고, 명령어를 붙여 넣은 뒤 Enter를 누르세요.

**"Apple은 악성 코드가 없음을 확인할 수 없습니다" / "확인되지 않은 개발자"**

1. 경고 창에 뜨는 안내에서 **개인정보 보호 및 보안**으로 이동하는 버튼 누르기
   (버튼이 없으면 **시스템 설정 → 개인정보 보호 및 보안**으로 직접 이동)
2. 아래로 내려 보안 항목의 *"Planner이(가) 차단되었습니다"* 옆 **그래도 열기** 클릭
3. 다시 뜨는 창에서 **열기** → 암호 또는 Touch ID 입력

한 번만 하면 다음부터는 바로 열려요.

**실행이 안 돼요**

Apple Silicon(M1 이상) 맥 전용이에요. ** → 이 Mac에 관하여 → 칩**에서 확인할 수 있어요.

**알림이 안 와요**

앱의 ⚙︎ 설정 → **테스트 알림**을 한 번 누른 뒤, **시스템 설정 → 알림 → Planner**에서 알림을 허용하세요.

</details>

## 기능

- **보기** — 주 · 월 · 년, 주간 목록 / 시간표
- **반복 일정** — 매주 · 격주 · 매월 n번째, 회차별 메모 모아보기
- **빠른 추가** — `내일 3시 헬스 @학교` 한 줄로 입력
- **카드** — 자주 쓰는 일정을 날짜로 드래그
- **준비 · 할 일** — 일정별 체크리스트, 메모의 `- [ ]` 는 할 일로
- **마감** — D-day 표시와 전날 · 당일 알림
- **위젯** — 메뉴바 미니 창을 📌 고정해 화면에 띄워 두기
- **알림 · 백업** — 시작 전 알림, 자동 백업, iCloud Drive 저장, `.ics` 내보내기

## 단축키

| 키 | 동작 | 키 | 동작 |
|---|---|---|---|
| `⌘K` | 빠른 추가 | `⌘F` | 검색 |
| `⌘Z` | 실행 취소 | `v` | 주간 돌아보기 |
| `w` `m` `y` | 주 · 월 · 년 | `c` | 카드 보관함 |
| `←` `→` | 이동 | `t` | 오늘 |

## 개발

```bash
npm install
npm run dev                  # 실행
npm run release -- 0.4.5     # 버전 올리고 릴리스 (GitHub Actions가 dmg 빌드)
```

Tauri 2 · Vanilla JS · Rust · [MIT License](LICENSE)
