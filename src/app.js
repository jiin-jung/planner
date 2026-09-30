// 전역 이름 충돌 방지 (Tauri는 window.isTauri 등을 미리 정의함)
(() => {
"use strict";

// ═════════════════════════ 환경 ═════════════════════════
const IN_TAURI = !!(window.__TAURI__ && window.__TAURI__.core);
const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const WINDOW_LABEL =
  window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ||
  (location.search.includes("mini") ? "mini" : "main");
const IS_MINI = WINDOW_LABEL === "mini";
const LS_KEY = "planner-data-v1";

const errText = (e) => (typeof e === "string" ? e : e?.message || JSON.stringify(e));

// ═════════════════════════ 날짜 유틸 ═════════════════════════
const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
const WEEK_HEAD = ["월", "화", "수", "목", "금", "토", "일"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const NTH_NAMES = { 1: "첫째", 2: "둘째", 3: "셋째", 4: "넷째", "-1": "마지막" };
const ICS_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const COLORS = ["#3b6df0", "#16a37a", "#e08a1e", "#d64575", "#8a5cf0", "#6b7280"];

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const timeRange = (s, e) => (s ? (e ? `${s} – ${e}` : s) : "종일");
const todayStr = () => ymd(new Date());
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMin = (x) => { x = Math.max(0, Math.min(x, 23 * 60 + 59)); return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`; };
const fmtDate = (ds) => { const d = parseYmd(ds); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAY_NAMES[d.getDay()]})`; };
const addMinutes = (t, mins) => { const [h, m] = t.split(":").map(Number); const x = Math.min(h * 60 + m + mins, 23 * 60 + 59); return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`; };

// ═════════════════════════ 데이터 ═════════════════════════
const DEFAULT_SETTINGS = { notify: true, lead: 10, weeklyReview: true, theme: "system" };
let data = { recurring: [], events: [], todos: [], cards: [], settings: { ...DEFAULT_SETTINGS } };
let ready = false;      // 불러오기 성공 전에는 저장 금지 (기존 파일 덮어쓰기 방지)
let saveTimer = null;

const normalize = (d) => ({
  recurring: [], events: [], todos: [], cards: [], ...d,
  settings: { ...DEFAULT_SETTINGS, ...(d?.settings || {}) },
});

const store = {
  async load() {
    const raw = IN_TAURI ? await invoke("load_data") : localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  async save() {
    const raw = JSON.stringify(data);
    try {
      if (IN_TAURI) await invoke("save_data", { data: raw, day: todayStr() });
      else localStorage.setItem(LS_KEY, raw);
    } catch (e) {
      showError("저장 실패: " + errText(e));
    }
  },
};

// 실행 취소: 변경 직전 상태를 스택에 쌓아 둠 (최대 50단계)
let snapshot = null;
const undoStack = [], redoStack = [];

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { saveTimer = null; await store.save(); syncReminders(); broadcast(); }, 200);
}
// 다른 창(메인 ↔ 위젯)에 변경 알림
function broadcast() {
  if (IN_TAURI && window.__TAURI__.event) window.__TAURI__.event.emit("data-changed", WINDOW_LABEL).catch(() => {});
}
function persist() {
  if (!ready) { showError("데이터를 아직 불러오지 못해서 저장하지 않았어요."); return; }
  const now = JSON.stringify(data);
  if (snapshot !== null && snapshot !== now) {
    undoStack.push(snapshot);
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
  }
  snapshot = now;
  scheduleSave();
}
function restore(from, to, msg) {
  if (!ready) return;
  if (!from.length) return toast(from === undoStack ? "되돌릴 작업이 없어요" : "다시 실행할 작업이 없어요");
  to.push(JSON.stringify(data));
  snapshot = from.pop();
  data = normalize(JSON.parse(snapshot));
  scheduleSave(); render();
  if ($("#recurringDialog")?.open) renderRecurringList();
  toast(msg);
}
const undo = () => restore(undoStack, redoStack, "되돌렸어요 · ⌘⇧Z 다시 실행");
const redo = () => restore(redoStack, undoStack, "다시 실행했어요");
function handleEditCommand(cmd) {
  const a = document.activeElement;
  if (a && /INPUT|TEXTAREA/.test(a.tagName)) return document.execCommand(cmd);   // 입력칸은 글자 단위 되돌리기
  if ([...document.querySelectorAll("dialog")].some((d) => d.open)) return;
  cmd === "redo" ? redo() : undo();
}
async function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await store.save(); syncReminders(); broadcast(); }
}

// ═════════════════════════ 반복 규칙 ═════════════════════════
function occursOn(r, ds, dow) {
  if (r.weekday !== dow) return false;
  if (r.startDate && ds < r.startDate) return false;
  if (r.endDate && ds > r.endDate) return false;
  if ((r.skips || []).includes(ds)) return false;
  const freq = r.freq || "weekly";
  if (freq === "biweekly") {
    const a = mondayOf(parseYmd(r.startDate || ds)), b = mondayOf(parseYmd(ds));
    return Math.round((b - a) / (7 * 864e5)) % 2 === 0;
  }
  if (freq === "monthly") {
    const d = parseYmd(ds), day = d.getDate(), nth = Number(r.nth || 1);
    if (nth === -1) return day + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return Math.ceil(day / 7) === nth;
  }
  return true;
}

function recLabel(r) {
  const day = DAY_NAMES[r.weekday];
  if (r.freq === "biweekly") return `격주 ${day}`;
  if (r.freq === "monthly") return `매월 ${NTH_NAMES[r.nth || 1]} ${day}`;
  return `매주 ${day}`;
}
const recBadge = (r) => (r.freq === "biweekly" ? "격주" : r.freq === "monthly" ? "매월" : "매주");

const prepToChecks = (prep) => (prep || []).map((text) => ({ text, done: false }));
const occChecks = (r, ds) => (r.checks && r.checks[ds]) || prepToChecks(r.prep);

function itemsFor(ds) {
  const dow = parseYmd(ds).getDay();
  const rec = data.recurring
    .filter((r) => occursOn(r, ds, dow))
    .map((r) => ({ kind: "recurring", ref: r, date: ds, title: r.title, start: r.start, end: r.end, color: r.color, place: r.place, note: (r.notes || {})[ds], checks: occChecks(r, ds) }));
  const ev = data.events
    .filter((e) => e.date === ds || (e.endDate && e.date <= ds && ds <= e.endDate))
    .map((e) => {
      const n = e.endDate && e.endDate > e.date ? daysBetween(e.date, e.endDate) + 1 : 1;
      const i = n > 1 ? daysBetween(e.date, ds) + 1 : 1;
      return { kind: "event", ref: e, date: ds, title: e.title, color: e.color, place: e.place, note: e.note, checks: e.checks || [], deadline: !!e.deadline,
        start: i === 1 ? e.start : "", end: i === n ? e.end : "", span: n > 1 ? { i, n } : null };
    });
  const items = [...rec, ...ev].sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  // 시간 겹침 표시
  const mins = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const timed = items.filter((it) => it.start && !it.span).map((it) => ({ it, s: mins(it.start), e: it.end ? mins(it.end) : mins(it.start) + 60 }));
  for (const a of timed) for (const b of timed)
    if (a !== b && a.s < b.e && b.s < a.e) (a.it.conflicts ||= []).push(b.it.title);
  return items;
}

// 끝나지 않았고, 뒤를 잇는 시리즈가 없는 정기 회의 (분할된 경우 최신 것만)
const activeSeries = () => data.recurring.filter((r) =>
  (!r.endDate || r.endDate >= todayStr()) &&
  !(r.endDate && data.recurring.some((o) => o !== r && o.title === r.title && o.startDate > r.endDate)));

// 체크리스트 저장 (정기 회의는 회차별로 저장)
function setChecks(kind, ref, date, checks) {
  if (kind === "recurring") { ref.checks = ref.checks || {}; ref.checks[date] = checks; }
  else ref.checks = checks;
}

// ═════════════════════════ DOM 유틸 ═════════════════════════
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
};

// 빈 값(null/false)이 "null" 글자로 찍히지 않도록 전역에서 걸러냄
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const fn of ["replaceChildren", "append", "prepend"]) {
    const orig = proto[fn];
    proto[fn] = function (...kids) { return orig.apply(this, kids.filter((k) => k != null && k !== false)); };
  }
}

function showError(msg) {
  let bar = document.getElementById("errorBar");
  if (!bar) {
    bar = el("div", { id: "errorBar", class: "error-bar", onclick: () => bar.remove() });
    document.body.prepend(bar);
  }
  bar.textContent = "⚠️ " + msg + "  (클릭해서 닫기)";
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

// ═════════════════════════ 빠른 입력 파서 ═════════════════════════
// 예) "수 19시 운영진 회의 @7호관", "내일 3시 멘토링", "10/20 캡스톤 제출 마감",
//     "매주 목 20:00-22:00 스터디", "매월 첫째 금 18시 총회", "다음주 화 오후 2시 반 면담 1시간"
const DOW_MAP = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const NTH_MAP = { 첫째: 1, 첫: 1, 둘째: 2, 셋째: 3, 넷째: 4, 마지막: -1, "1": 1, "2": 2, "3": 3, "4": 4 };

function parseQuick(input, now = new Date()) {
  let t = " " + String(input || "").replace(/\s+/g, " ").trim() + " ";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = { kind: "event", title: "", date: null, dateExplicit: false, start: "", end: "", place: "", deadline: false };
  const take = (re, fn) => { const m = t.match(re); if (!m) return false; t = t.slice(0, m.index) + " " + t.slice(m.index + m[0].length); fn(m); return true; };
  const setDate = (d) => { out.date = ymd(d); out.dateExplicit = true; };

  take(/\s@(\S+)/, (m) => (out.place = m[1]));
  take(/\s!(?=\s)|\s!(?=\S)/, () => (out.deadline = true));
  if (/마감|제출|데드라인|D-?day/i.test(t)) out.deadline = true;

  // 반복
  take(/\s(매주|격주)\s*([월화수목금토일])(?:요일)?(?=\s)/, (m) => {
    out.kind = "recurring"; out.freq = m[1] === "격주" ? "biweekly" : "weekly"; out.weekday = DOW_MAP[m[2]];
  });
  if (out.kind === "event")
    take(/\s매월\s*(첫째|첫|둘째|셋째|넷째|마지막|[1-4])\s*(?:번\s*)?(?:째\s*)?(?:주\s*)?([월화수목금토일])(?:요일)?(?=\s)/, (m) => {
      out.kind = "recurring"; out.freq = "monthly"; out.nth = NTH_MAP[m[1]]; out.weekday = DOW_MAP[m[2]];
    });

  // 날짜
  if (out.kind === "event") {
    take(/\s(오늘|내일|모레|글피)(?=\s)/, (m) => setDate(addDays(today, { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[1]])));
    out.date || take(/\s(\d{1,3})\s*일\s*(?:뒤|후)(?=\s)/, (m) => setDate(addDays(today, +m[1])));
    out.date || take(/\s(\d{4})-(\d{1,2})-(\d{1,2})(?=\s)/, (m) => setDate(new Date(+m[1], m[2] - 1, +m[3])));
    const md = (mo, da) => { let d = new Date(today.getFullYear(), mo - 1, da); if (d < addDays(today, -30)) d = new Date(today.getFullYear() + 1, mo - 1, da); return d; };
    out.date || take(/\s(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*[~-]\s*(?:(\d{1,2})\s*월\s*)?(\d{1,2})\s*일(?=\s)/, (m) => {
      const a = md(+m[1], +m[2]); setDate(a);
      let b = new Date(a.getFullYear(), (m[3] ? +m[3] : +m[1]) - 1, +m[4]); if (b < a) b = new Date(b.getFullYear() + 1, b.getMonth(), b.getDate());
      out.endDate = ymd(b);
    });
    out.date || take(/\s(\d{1,2})[\/.](\d{1,2})\s*[~-]\s*(?:(\d{1,2})[\/.])?(\d{1,2})(?=\s)/, (m) => {
      const a = md(+m[1], +m[2]); setDate(a);
      let b = new Date(a.getFullYear(), (m[3] ? +m[3] : +m[1]) - 1, +m[4]); if (b < a) b = new Date(b.getFullYear() + 1, b.getMonth(), b.getDate());
      out.endDate = ymd(b);
    });
    out.date || take(/\s(\d{1,2})\s*월\s*(\d{1,2})\s*일(?=\s|까지)/, (m) => setDate(md(+m[1], +m[2])));
    out.date || take(/\s(\d{1,2})[\/.](\d{1,2})(?=\s|까지)/, (m) => setDate(md(+m[1], +m[2])));
    out.date || take(/\s(이번\s*주|다음\s*주|다다음\s*주)?\s*([월화수목금토일])(?:요일)?(?=\s|까지)/, (m) => {
      const dow = DOW_MAP[m[2]];
      const offset = (dow + 6) % 7;                      // 월=0 … 일=6
      if (m[1]) {
        const weeks = m[1].startsWith("다다음") ? 2 : m[1].startsWith("다음") ? 1 : 0;
        setDate(addDays(mondayOf(today), weeks * 7 + offset));
      } else {
        let d = addDays(mondayOf(today), offset);
        if (d < today) d = addDays(d, 7);                 // 지난 요일이면 다음 주
        setDate(d);
      }
    });
    out.date || take(/\s(\d{1,2})\s*일(?=\s|까지)/, (m) => {
      let d = new Date(today.getFullYear(), today.getMonth(), +m[1]);
      if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, +m[1]);
      setDate(d);
    });
  }

  // 시간 (오전/오후 없으면 1~7시는 오후로 봄)
  const toHM = (period, h, m) => {
    h = +h; m = +(m || 0);
    if (/오후|저녁|밤/.test(period || "") && h < 12) h += 12;
    else if (/오전|아침|새벽/.test(period || "") && h === 12) h = 0;
    else if (!period && h >= 1 && h <= 7) h += 12;
    if (h > 23 || m > 59) return null;
    return `${pad(h)}:${pad(m)}`;
  };
  const P = "(오전|오후|아침|점심|저녁|밤|새벽)?\\s*";
  const range = new RegExp(`\\s${P}(\\d{1,2})(?::(\\d{2})|\\s*시\\s*(?:(\\d{1,2})\\s*분|(반))?)?\\s*(?:~|-|부터)\\s*${P}(\\d{1,2})(?::(\\d{2})|\\s*시\\s*(?:(\\d{1,2})\\s*분|(반))?)?\\s*(?:까지)?(?=\\s)`);
  const single = new RegExp(`\\s${P}(\\d{1,2})(?::(\\d{2})|\\s*시\\s*(?:(\\d{1,2})\\s*분|(반))?)(?=\\s|에|부터)`);
  const mm = (a, b) => (b ? 30 : a || 0);
  const ok = take(range, (m) => {
    const p1 = m[1], p2 = m[6] || p1;
    const s1 = toHM(p1, m[2], m[3] || mm(m[4], m[5]));
    let e1 = toHM(p2, m[7], m[8] || mm(m[9], m[10]));
    if (s1 && e1 && e1 <= s1 && !m[6]) e1 = toHM("오후", m[7], m[8] || mm(m[9], m[10]));   // "3-5시" → 15-17
    out.start = s1 || ""; out.end = e1 || "";
  });
  if (!ok) take(single, (m) => { out.start = toHM(m[1], m[2], m[3] || mm(m[4], m[5])) || ""; });
  if (out.start && !out.end) {
    let dur = 60;
    take(/\s(\d+(?:\.\d+)?)\s*시간(?:\s*(\d+)\s*분)?(?:\s*동안)?(?=\s)/, (m) => (dur = Math.round(+m[1] * 60) + +(m[2] || 0)));
    take(/\s(\d+)\s*분(?:\s*동안)?(?=\s)/, (m) => (dur = +m[1]));
    out.end = addMinutes(out.start, dur);
  }

  out.title = t.replace(/\s+/g, " ").replace(/^\s*(에|부터)\s+/, "").trim();
  if (out.kind === "event" && !out.date) out.date = ymd(today);
  if (out.kind === "recurring") out.startDate = ymd(mondayOf(today));
  return out;
}

function describeQuick(q) {
  if (!q.title) return "제목을 입력하세요";
  const when = q.kind === "recurring" ? recLabel(q) : q.endDate ? `${fmtDate(q.date)} ~ ${fmtDate(q.endDate)}` : fmtDate(q.date);
  return [q.deadline ? "⚑ Due" : null, when, q.start ? timeRange(q.start, q.end) : "종일", q.title, q.place ? `@${q.place}` : null].filter(Boolean).join(" · ");
}

function createFromQuick(q) {
  const base = { title: q.title, start: q.start, end: q.end, place: q.place, color: COLORS[q.kind === "recurring" ? 0 : q.deadline ? 3 : 0] };
  if (q.kind === "recurring") {
    data.recurring.push({ id: uid(), skips: [], notes: {}, checks: {}, prep: [], ...base, weekday: q.weekday, freq: q.freq, nth: q.nth || 1, startDate: q.startDate });
  } else {
    data.events.push({ id: uid(), ...base, date: q.date, endDate: q.endDate || "", note: "", checks: [], deadline: q.deadline });
  }
  persist();
  if (q.kind === "event" && !IS_MINI) { cursor = parseYmd(q.date); }
  render();
  toast(`추가했어요: ${describeQuick(q)}`);
  if (q.kind === "event") warnConflict(q.date, q.title);
}

function attachQuick(input, preview) {
  const update = () => {
    const v = input.value.trim();
    preview.hidden = !v;
    if (v) preview.textContent = "↵ " + describeQuick(parseQuick(v)) + "   ⌘↵ 자세히";
  };
  input.addEventListener("input", update);
  input.addEventListener("blur", () => setTimeout(() => (preview.hidden = true), 150));
  input.addEventListener("focus", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; update(); input.blur(); return; }
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    const q = parseQuick(input.value);
    if (!q.title) return;
    if (e.metaKey || e.ctrlKey) {            // 편집 창에서 이어서 수정
      fillForm({ kind: q.kind, ref: null, date: q.date });
      form.title.value = q.title; form.place.value = q.place;
      setTime(form.start, q.start); setTime(form.end, q.end); endTouched = !!q.end;
      if (q.kind === "recurring") { form.weekday.value = String(q.weekday); form.freq.value = q.freq; form.nth.value = String(q.nth || 1); syncFreqFields(); form.startDate.value = q.startDate; }
      else { form.date.value = q.date; form.endDate.value = q.endDate || ""; form.deadline.checked = q.deadline; }
    } else createFromQuick(q);
    input.value = ""; update();
  });
}

// ═════════════════════════ 메모 → 할 일 ═════════════════════════
// 메모에 "- [ ] 할 일" 로 쓰면 할 일 목록에 등록, "- [x]" 면 완료 처리. 줄에 날짜가 있으면 그 날로.
function syncNoteTodos(note, src, date) {
  let created = 0;
  for (const line of String(note || "").split("\n")) {
    const m = line.match(/^\s*(?:[-*]\s*)?\[\s*([xX✓v]?)\s*\]\s*(.+)$/);
    if (!m) continue;
    const q = parseQuick(m[2]);
    const text = (q.dateExplicit ? q.title : m[2].trim()) || m[2].trim();
    const done = !!m[1];
    const existing = data.todos.find((t) => t.src === src && t.text === text);
    if (existing) { existing.done = done; continue; }
    data.todos.push({ id: uid(), date: q.dateExplicit ? q.date : date, text, done, src });
    created++;
  }
  if (created) setTimeout(() => toast(`메모에서 할 일 ${created}개를 만들었어요`), 60);
}

// ═════════════════════════ D-day ═════════════════════════
function dday(ds) {
  const diff = Math.round((parseYmd(ds) - parseYmd(todayStr())) / 864e5);
  return diff === 0 ? "D-DAY" : diff > 0 ? `D-${diff}` : `D+${-diff}`;
}
function upcomingDeadlines(limitDays = 60) {
  const today = todayStr(), until = ymd(addDays(new Date(), limitDays));
  return data.events.filter((e) => e.deadline && e.date >= today && e.date <= until).sort((a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")));
}
function ddayChips(max = 6) {
  return upcomingDeadlines().slice(0, max).map((e) =>
    el("button", { class: "dday-chip" + (e.date === todayStr() ? " now" : ""), style: `--c:${e.color || COLORS[3]}`, title: `${fmtDate(e.date)} ${timeRange(e.start, e.end)}`,
      onclick: () => { if (!IS_MINI) goTo("week", parseYmd(e.date)); openItem({ kind: "event", ref: e, date: e.date }); } },
      el("strong", {}, dday(e.date)), " ", e.title));
}

// ═════════════════════════ 드래그 앤 드롭 ═════════════════════════
let dragging = null; // { kind: event|recurring|todo, ref, date }

function draggable(node, payload) {
  node.draggable = true;
  node.addEventListener("dragstart", (e) => {
    dragging = { ...payload, copy: e.altKey };
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", payload.kind);
    node.classList.add("dragging");
  });
  node.addEventListener("dragend", () => { node.classList.remove("dragging"); dragging = null; clearDrop(); });
  return node;
}
const clearDrop = () => document.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
function dropTarget(node, ds) {
  node.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragging.kind === "card" || dragging.kind === "reccard" || dragging.copy || e.altKey ? "copy" : "move";
    node.classList.add("drop");
  });
  node.addEventListener("dragleave", (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove("drop"); });
  node.addEventListener("drop", (e) => {
    e.preventDefault(); clearDrop();
    if (dragging) moveTo({ ...dragging, copy: dragging.copy || e.altKey }, ds);
    dragging = null;
  });
  return node;
}

const eventFrom = (src, ds, extra = {}) => ({
  id: uid(), title: src.title, start: src.start || "", end: src.end || "", place: src.place || "", color: src.color || COLORS[0], date: ds, ...extra,
});

// 시간표에서 놓은 시각으로 시작 시간 변경 (길이는 유지)
function applyTime(obj, time) {
  if (!time) return obj;
  const dur = obj.start && obj.end ? toMin(obj.end) - toMin(obj.start) : 60;
  obj.start = time; obj.end = fromMin(toMin(time) + Math.max(dur, 15));
  return obj;
}
// 여러 날 일정은 드래그한 날 기준으로 통째로 이동
function shiftEvent(e, fromDs, toDs) {
  const delta = daysBetween(fromDs, toDs);
  e.date = ymd(addDays(parseYmd(e.date), delta));
  if (e.endDate) e.endDate = ymd(addDays(parseYmd(e.endDate), delta));
}

function moveTo({ kind, ref, date, copy }, ds, time) {
  // 카드 → 새 일정
  if (kind === "card") {
    data.events.push(applyTime(eventFrom(ref, ds, { note: ref.note || "", checks: prepToChecks(ref.prep), fromCard: ref.id }), time));
    toast(`'${ref.title}'을(를) ${fmtDate(ds)}에 추가했어요`);
    persist(); render(); return warnConflict(ds, ref.title);
  }
  // 정기 회의 카드 → 그 날 한 번 더 (보강 회의)
  if (kind === "reccard") {
    data.events.push(applyTime(eventFrom(ref, ds, { checks: prepToChecks(ref.prep), fromRecurring: ref.id }), time));
    toast(`'${ref.title}'을(를) ${fmtDate(ds)}에 한 번 더 추가했어요`);
    persist(); render(); return warnConflict(ds, ref.title);
  }
  // ⌥ 누르고 드래그 → 복사
  if (copy) {
    if (kind === "todo") data.todos.push({ id: uid(), date: ds, text: ref.text, done: false });
    else if (kind === "event") {
      const c = { ...structuredClone(ref), id: uid(), checks: (ref.checks || []).map((x) => ({ ...x, done: false })) };
      shiftEvent(c, date, ds); applyTime(c, time); data.events.push(c);
    }
    else if (kind === "recurring") data.events.push(applyTime(eventFrom(ref, ds, { checks: prepToChecks(ref.prep), fromRecurring: ref.id }), time));
    toast(`${fmtDate(ds)}에 복사했어요`);
    persist(); render(); return kind === "todo" || warnConflict(ds, ref.title);
  }
  if (date === ds && (!time || kind === "todo")) return;
  if (kind === "todo") {
    ref.date = ds;
  } else if (kind === "event") {
    shiftEvent(ref, date, ds);
    applyTime(ref, time);
  } else if (kind === "recurring") {
    // 정기 회의는 그 회차만 옮김: 원래 날짜는 건너뛰고 새 날짜에 단발 일정 생성
    ref.skips = [...new Set([...(ref.skips || []), date])];
    const note = (ref.notes || {})[date];
    const checks = occChecks(ref, date);
    if (ref.notes) delete ref.notes[date];
    if (ref.checks) delete ref.checks[date];
    data.events.push(applyTime(eventFrom(ref, ds, { note, checks, fromRecurring: ref.id }), time));
    toast(`'${ref.title}' 이번 회차만 ${date === ds ? time + "로" : fmtDate(ds) + "로"} 옮겼어요`);
  }
  persist(); render();
  if (kind !== "todo") warnConflict(ds, ref.title);
}

function warnConflict(ds, title) {
  const hit = itemsFor(ds).find((it) => it.title === title && it.conflicts);
  if (hit) setTimeout(() => toast(`⚠ ${fmtDate(ds)} '${title}'이(가) '${hit.conflicts[0]}'와(과) 시간이 겹쳐요`), 50);
}

// ═════════════════════════ 렌더링 ═════════════════════════
let cursor = new Date();
let weekStart = mondayOf(cursor);
let view = "week";
try { view = localStorage.getItem("planner-view") || "week"; } catch {}

let deckOpen = true;
try { deckOpen = localStorage.getItem("planner-deck") !== "0"; } catch {}

function renderDeck() {
  const deck = $("#deck");
  deck.hidden = view === "year";
  deck.classList.toggle("collapsed", !deckOpen);
  if (view === "year") return;
  if (!deckOpen) {   // 접힌 상태: 왼쪽에 얇은 탭만
    deck.replaceChildren(el("button", { class: "deck-tab", title: "Templates 열기 (c)", onclick: toggleDeck }, "›"));
    return;
  }
  const cardEl = (kind, ref, sub) => draggable(
    el("div", { class: "deck-card", style: `--c:${ref.color || COLORS[0]}`,
      onclick: () => (kind === "card" ? fillForm({ kind: "card", ref, date: null }) : fillForm({ kind: "recurring", ref, date: null })) },
      el("div", { class: "deck-title" }, ref.title),
      el("div", { class: "deck-sub" }, sub),
      ref.prep?.length ? el("div", { class: "deck-sub" }, `Prep ${ref.prep.length}`) : null),
    { kind, ref, date: null });
  const recs = activeSeries();
  deck.replaceChildren(
    el("div", { class: "deck-head" },
      el("span", { class: "deck-title-row" },
        el("button", { class: "deck-collapse", title: "접기 (c)", onclick: toggleDeck }, "‹"),
        el("strong", {}, "Templates")),
      el("button", { class: "icon-btn small", title: "새 Template", onclick: () => fillForm({ kind: "card", ref: null, date: null }) }, "+")),
    el("div", { class: "deck-hint" }, "자주 쓰는 일정 · 날짜로 끌어 놓기"),
    ...(data.cards.length
      ? data.cards.map((c) => cardEl("card", c, timeRange(c.start, c.end) + (c.place ? ` · ${c.place}` : "")))
      : [el("button", { class: "deck-card ghost", style: `--c:${COLORS[1]}`, title: "눌러서 예시 Template 만들기", onclick: () => {
          fillForm({ kind: "card", ref: null, date: null });
          form.title.value = "헬스"; setTime(form.start, "19:00"); setTime(form.end, "20:00"); endTouched = true;
          pickedColor = COLORS[1]; renderColors();
        } },
          el("div", { class: "deck-title" }, "헬스"),
          el("div", { class: "deck-sub" }, "19:00 – 20:00 · 예시"),
          el("div", { class: "deck-sub" }, "+ 눌러서 만들기"))]),
    el("div", { class: "deck-head sub" },
      el("button", { class: "deck-link", title: "Routines 목록 · 회차 Notes", onclick: () => { renderRecurringList(); recDlg.showModal(); } },
        el("strong", {}, "Routines"), el("span", { class: "muted" }, " ›"))),
    recs.length ? null : el("div", { class: "deck-hint" }, "+ Routine 으로 반복 일정 추가"),
    ...recs.map((r) => cardEl("reccard", r, `${recLabel(r)} ${r.start || ""}`)));
}

function renderDday() {
  const bar = $("#ddayBar");
  const chips = ddayChips();
  bar.hidden = !chips.length;
  bar.replaceChildren(el("span", { class: "muted small" }, "Due"), ...chips);
}

function render() {
  if (IS_MINI) return renderMini();
  renderDeck();
  renderDday();
  weekStart = mondayOf(cursor);
  const main = $("#week");
  main.className = view;
  main.replaceChildren();
  document.querySelectorAll(".seg button[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $("#weekMode").hidden = view !== "week";
  document.querySelectorAll("#weekMode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === weekMode));
  const y = cursor.getFullYear(), m = cursor.getMonth();

  if (view === "week") {
    const end = addDays(weekStart, 6);
    const sameMonth = weekStart.getMonth() === end.getMonth();
    $("#weekLabel").textContent =
      `${weekStart.getFullYear()}년 ${weekStart.getMonth() + 1}월 ${weekStart.getDate()}일 – ` +
      (sameMonth ? `${end.getDate()}일` : `${end.getMonth() + 1}월 ${end.getDate()}일`);
    weekMode === "grid" ? renderWeekGrid(main) : renderWeek(main);
  } else if (view === "month") {
    $("#weekLabel").textContent = `${y}년 ${m + 1}월`;
    renderMonth(main, y, m);
  } else {
    $("#weekLabel").textContent = `${y}년`;
    renderYear(main, y);
  }
}

function goTo(v, date) {
  view = v;
  if (date) cursor = date;
  try { localStorage.setItem("planner-view", view); } catch {}
  render();
}

// ── 공통: 일정 카드
function itemCard(it) {
  const checks = it.checks || [];
  const doneN = checks.filter((c) => c.done).length;
  return draggable(
    el("div", { class: "item" + (it.conflicts ? " conflict" : "") + (it.deadline ? " deadline" : ""), style: `--c:${it.color || COLORS[0]}`, onclick: () => openItem(it) },
      el("div", { class: "item-time" }, it.span ? `${it.span.i}/${it.span.n}일차${it.start ? " · " + it.start + "~" : it.end ? " · ~" + it.end : ""}` : timeRange(it.start, it.end),
        it.conflicts ? el("span", { class: "warn", title: `시간 겹침: ${it.conflicts.join(", ")}` }, " ⚠") : null),
      el("div", { class: "item-title" + (it.note ? " has-note" : "") }, it.title),
      (it.kind === "recurring" || it.place || checks.length || it.deadline)
        ? el("div", { class: "item-meta" },
            it.deadline ? el("span", { class: "badge dl" }, `⚑ ${dday(it.date)}`) : null,
            it.kind === "recurring" ? el("span", { class: "badge" }, recBadge(it.ref)) : null,
            checks.length ? el("span", { class: "badge" + (doneN === checks.length ? " ok" : "") }, `Prep ${doneN}/${checks.length}`) : null,
            it.place ? el("span", {}, it.place) : null)
        : null,
      checks.length && doneN < checks.length
        ? el("div", { class: "item-checks" }, ...checks.map((c, i) => {
            const cb = el("input", { type: "checkbox", onclick: (e) => e.stopPropagation() });
            cb.checked = c.done;
            cb.addEventListener("change", () => {
              const next = checks.map((x, j) => (j === i ? { ...x, done: cb.checked } : { ...x }));
              setChecks(it.kind, it.ref, it.date, next);
              persist(); render();
            });
            return el("label", { class: "chk" + (c.done ? " done" : ""), onclick: (e) => e.stopPropagation() }, cb, el("span", {}, c.text));
          }))
        : null),
    { kind: it.kind, ref: it.ref, date: it.date });
}

// ── 공통: 할 일 목록
function todoList(ds, { withCarry = false } = {}) {
  const box = el("div", { class: "todos" });
  if (withCarry) {
    const overdue = data.todos.filter((t) => !t.done && t.date < ds);
    if (overdue.length)
      box.append(el("button", { class: "carry", onclick: () => carryOver(ds) }, `↪ 밀린 To-do ${overdue.length}개 가져오기`));
  }
  for (const t of data.todos.filter((t) => t.date === ds)) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = t.done;
    cb.addEventListener("change", () => { t.done = cb.checked; persist(); render(); });
    box.append(draggable(
      el("div", { class: "todo" + (t.done ? " done" : "") }, cb, el("span", {}, t.text),
        el("button", { class: "x", title: "삭제", onclick: () => { data.todos = data.todos.filter((x) => x !== t); persist(); render(); toast("삭제됨 · ⌘Z"); } }, "×")),
      { kind: "todo", ref: t, date: ds }));
  }
  const input = el("input", { class: "todo-input", placeholder: "+ To-do" });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && input.value.trim()) {
      data.todos.push({ id: uid(), date: ds, text: input.value.trim(), done: false });
      persist(); render();
      document.querySelector(`[data-date="${ds}"] .todo-input`)?.focus();
    }
  });
  box.append(input);
  return box;
}

function carryOver(ds) {
  let n = 0;
  for (const t of data.todos) if (!t.done && t.date < ds) { t.date = ds; n++; }
  persist(); render();
  toast(`밀린 할 일 ${n}개를 ${ds === todayStr() ? "오늘" : fmtDate(ds)}로 옮겼어요`);
}

// ── 주간 시간표
let weekMode = "list";
try { weekMode = localStorage.getItem("planner-weekmode") || "list"; } catch {}
const HOUR_PX = 48;
let gridScroll = null;

// 겹치는 일정은 나란히 배치
function layoutBlocks(items) {
  const evs = items.map((it) => ({ it, s: toMin(it.start), e: Math.max(toMin(it.end || fromMin(toMin(it.start) + 60)), toMin(it.start) + 20) }))
    .sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], clusterEnd = -1;
  const flush = () => { const lanes = Math.max(...cluster.map((x) => x.lane)) + 1; cluster.forEach((x) => (x.lanes = lanes)); cluster = []; };
  for (const ev of evs) {
    if (cluster.length && ev.s >= clusterEnd) flush();
    const used = new Set(cluster.filter((x) => x.e > ev.s).map((x) => x.lane));
    let lane = 0; while (used.has(lane)) lane++;
    ev.lane = lane; cluster.push(ev); clusterEnd = Math.max(clusterEnd, ev.e);
  }
  if (cluster.length) flush();
  return evs;
}

function renderWeekGrid(main) {
  main.className = "week-grid";
  const today = todayStr();
  const days = [...Array(7)].map((_, i) => addDays(weekStart, i));
  const head = el("div", { class: "wg-row wg-head" }, el("div", { class: "wg-gutter" }),
    ...days.map((d) => {
      const ds = ymd(d), dow = d.getDay();
      return el("div", { class: "wg-dayhead" + (ds === today ? " today" : "") + (dow === 0 || dow === 6 ? " weekend" : "") },
        el("span", { class: "day-name" }, DAY_NAMES[dow]), el("span", { class: "day-num" }, String(d.getDate())),
        el("button", { class: "day-add", title: "이 날 일정 추가", onclick: () => openNew("event", ds) }, "+"));
    }));
  const allday = el("div", { class: "wg-row wg-allday" }, el("div", { class: "wg-gutter small muted" }, "종일"),
    ...days.map((d) => {
      const ds = ymd(d);
      const its = itemsFor(ds).filter((it) => !it.start || it.span);
      return dropTarget(el("div", { class: "wg-allcell", "data-date": ds },
        ...its.map((it) => draggable(
          el("div", { class: "m-chip" + (it.deadline ? " dl" : ""), style: `--c:${it.color || COLORS[0]}`, onclick: () => openItem(it) },
            it.deadline ? el("span", { class: "warn" }, "⚑ ") : null,
            it.span ? el("span", { class: "m-time" }, `${it.span.i}/${it.span.n} `) : null, it.title),
          { kind: it.kind, ref: it.ref, date: ds })),
        todoList(ds, { withCarry: ds === today })), ds);
    }));

  const body = el("div", { class: "wg-body", style: `height:${24 * HOUR_PX}px` },
    el("div", { class: "wg-hours" }, ...[...Array(24)].map((_, h) => el("div", { class: "wg-hour", style: `top:${h * HOUR_PX}px` }, h ? `${pad(h)}:00` : ""))));
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  for (const d of days) {
    const ds = ymd(d);
    const col = el("div", { class: "wg-col" + (ds === today ? " today" : ""), "data-date": ds });
    const minAt = (clientY) => Math.round(((clientY - col.getBoundingClientRect().top) / HOUR_PX) * 60 / 15) * 15;
    // 빈 곳 클릭 → 그 시각에 새 일정
    col.addEventListener("click", (e) => {
      if (e.target !== col) return;
      const t = fromMin(Math.floor(minAt(e.clientY) / 30) * 30);
      fillForm({ kind: "event", ref: null, date: ds });
      setTime(form.start, t); setTime(form.end, fromMin(toMin(t) + 60)); endTouched = false;
    });
    // 드롭 → 그 날짜·시각으로
    col.addEventListener("dragover", (e) => { if (!dragging) return; e.preventDefault(); col.classList.add("drop"); });
    col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("drop"); });
    col.addEventListener("drop", (e) => {
      e.preventDefault(); clearDrop();
      if (!dragging) return;
      const payload = { ...dragging, copy: dragging.copy || e.altKey };
      dragging = null;
      const offset = payload.grabOffsetMin || 0;
      moveTo(payload, ds, payload.kind === "todo" ? null : fromMin(Math.max(0, minAt(e.clientY) - offset)));
    });
    for (const b of layoutBlocks(itemsFor(ds).filter((it) => it.start && !it.span))) {
      const it = b.it;
      const block = el("div", {
        class: "wg-block" + (it.deadline ? " deadline" : ""),
        style: `--c:${it.color || COLORS[0]};top:${(b.s / 60) * HOUR_PX}px;height:${((b.e - b.s) / 60) * HOUR_PX - 2}px;left:calc(${(b.lane / b.lanes) * 100}% + 2px);width:calc(${100 / b.lanes}% - 4px)`,
        onclick: () => openItem(it),
      },
        el("div", { class: "wg-btime" }, timeRange(it.start, it.end)),
        el("div", { class: "wg-btitle" }, it.deadline ? "⚑ " : "", it.title),
        it.place ? el("div", { class: "wg-bmeta" }, it.place) : null,
        it.checks?.length ? el("div", { class: "wg-bmeta" }, `Prep ${it.checks.filter((c) => c.done).length}/${it.checks.length}`) : null);
      draggable(block, { kind: it.kind, ref: it.ref, date: ds });
      // 잡은 위치만큼 보정 (블록 윗부분 기준으로 시각 계산)
      block.addEventListener("dragstart", (e) => {
        if (dragging) dragging.grabOffsetMin = Math.round(((e.clientY - block.getBoundingClientRect().top) / HOUR_PX) * 60 / 15) * 15;
      });
      // 아래 가장자리 끌어서 길이 조절
      const handle = el("div", { class: "wg-resize", title: "끌어서 길이 조절" });
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        const startY = e.clientY, startH = block.offsetHeight;
        let newEnd = it.end;
        const onMove = (ev) => {
          const h = Math.max(HOUR_PX / 4, startH + ev.clientY - startY);
          block.style.height = h + "px";
          newEnd = fromMin(Math.round((b.s + (h / HOUR_PX) * 60) / 15) * 15);
          block.querySelector(".wg-btime").textContent = timeRange(it.start, newEnd);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
          if (!newEnd || newEnd === it.end) return;
          if (it.kind === "event") it.ref.end = newEnd;
          else {   // 정기 회의는 그 회차만 변경
            it.ref.skips = [...new Set([...(it.ref.skips || []), ds])];
            data.events.push(eventFrom(it.ref, ds, { end: newEnd, note: (it.ref.notes || {})[ds], checks: occChecks(it.ref, ds), fromRecurring: it.ref.id }));
            toast("이 회차만 시간을 바꿨어요");
          }
          persist(); render();
        };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
      });
      handle.addEventListener("click", (e) => e.stopPropagation());
      block.append(handle);
      col.append(block);
    }
    if (ds === today) col.append(el("div", { class: "wg-now", style: `top:${(nowMin / 60) * HOUR_PX}px` }));
    body.append(col);
  }
  const scroller = el("div", { class: "wg-scroll" }, body);
  main.append(head, allday, scroller);
  requestAnimationFrame(() => {
    scroller.scrollTop = gridScroll ?? Math.max(0, (Math.min(nowMin / 60, 20) - 1.5) * HOUR_PX, 7.5 * HOUR_PX * (nowMin / 60 < 7 ? 1 : 0));
  });
  scroller.addEventListener("scroll", () => (gridScroll = scroller.scrollTop));
}

// ── 주간 (목록)
function renderWeek(week) {
  const today = todayStr();
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const ds = ymd(d);
    const dow = d.getDay();
    const body = el("div", { class: "day-body" }, ...itemsFor(ds).map(itemCard), todoList(ds, { withCarry: ds === today }));
    week.append(dropTarget(
      el("section", { class: "day" + (ds === today ? " today" : "") + (dow === 0 || dow === 6 ? " weekend" : ""), "data-date": ds },
        el("div", { class: "day-head" },
          el("div", {}, el("div", { class: "day-name" }, DAY_NAMES[dow]), el("div", { class: "day-num" }, String(d.getDate()))),
          el("button", { class: "day-add", title: "이 날 일정 추가", onclick: () => openNew("event", ds) }, "+")),
        body),
      ds));
  }
}

// ── 월간
function renderMonth(main, y, m) {
  const today = todayStr();
  main.append(...WEEK_HEAD.map((n, i) => el("div", { class: "m-head" + (i >= 5 ? " weekend" : "") }, n)));
  const first = new Date(y, m, 1);
  const start = mondayOf(first);
  const last = new Date(y, m + 1, 0);
  const weeks = Math.ceil((((first.getDay() + 6) % 7) + last.getDate()) / 7);
  main.style.setProperty("--rows", weeks);
  const MAX = 3;
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const ds = ymd(d);
    const items = itemsFor(ds);
    const todos = data.todos.filter((t) => t.date === ds);
    main.append(dropTarget(
      el("div", { class: "m-cell" + (d.getMonth() !== m ? " out" : "") + (ds === today ? " today" : ""), onclick: () => goTo("week", d) },
        el("div", { class: "m-top" },
          el("span", { class: "m-num" }, String(d.getDate())),
          todos.length ? el("span", { class: "m-todo" }, `✓ ${todos.filter((t) => t.done).length}/${todos.length}`) : null),
        ...items.slice(0, MAX).map((it) => draggable(
          el("div", { class: "m-chip", style: `--c:${it.color || COLORS[0]}`, onclick: (e) => { e.stopPropagation(); openItem(it); } },
            it.conflicts ? el("span", { class: "warn" }, "⚠ ") : null,
            it.deadline ? el("span", { class: "warn" }, "⚑ ") : null,
            it.span && it.span.i > 1 ? el("span", { class: "m-time" }, "▸ ") : null,
            it.start ? el("span", { class: "m-time" }, it.start) : null, it.title,
            it.checks?.length ? el("span", { class: "m-time" }, ` ${it.checks.filter((c) => c.done).length}/${it.checks.length}`) : null),
          { kind: it.kind, ref: it.ref, date: ds })),
        items.length > MAX ? el("div", { class: "m-more" }, `+${items.length - MAX}개 더`) : null),
      ds));
  }
}

// ── 연간
function renderYear(main, y) {
  const today = todayStr(), now = new Date();
  for (let m = 0; m < 12; m++) {
    const first = new Date(y, m, 1);
    const lastDate = new Date(y, m + 1, 0).getDate();
    const grid = el("div", { class: "y-grid" }, ...WEEK_HEAD.map((n) => el("span", { class: "y-dow" }, n)));
    for (let i = 0; i < (first.getDay() + 6) % 7; i++) grid.append(el("span"));
    let monthCount = 0;
    for (let day = 1; day <= lastDate; day++) {
      const d = new Date(y, m, day), ds = ymd(d), its = itemsFor(ds), n = its.length;
      monthCount += n;
      grid.append(el("button", {
        class: `y-day l${Math.min(n, 3)}` + (ds === today ? " today" : "") + (its.some((x) => x.deadline) ? " dl" : ""),
        title: n ? `${ds} · 일정 ${n}개` : ds,
        onclick: () => goTo("week", d),
      }, String(day)));
    }
    main.append(el("section", { class: "y-month" + (y === now.getFullYear() && m === now.getMonth() ? " current" : "") },
      el("button", { class: "y-title", onclick: () => goTo("month", new Date(y, m, 1)) },
        `${m + 1}월`, monthCount ? el("span", { class: "muted" }, ` ${monthCount}`) : null),
      grid));
  }
}

// ── 메뉴바 미니 창 / 위젯
let widgetPinned = false;
function toggleWidget() {
  if (!IN_TAURI) return;
  invoke("set_widget", { pinned: !widgetPinned }).then((v) => {
    widgetPinned = v;
    document.body.classList.toggle("widget", v);
    render();
  }).catch((e) => showError(errText(e)));
}
if (IS_MINI && IN_TAURI) invoke("get_widget").then((v) => { widgetPinned = v; document.body.classList.toggle("widget", v); render(); }).catch(() => {});

function renderMini() {
  const main = $("#week");
  main.className = "mini-view";
  const ds = todayStr(), tomorrow = ymd(addDays(new Date(), 1));
  const todayItems = itemsFor(ds), tomorrowItems = itemsFor(tomorrow);
  const qi = el("input", { class: "quick-input", placeholder: "빠른 추가" });
  const qp = el("div", { class: "quick-preview", hidden: true });
  attachQuick(qi, qp);
  const chips = ddayChips(3);
  main.replaceChildren(...[
    el("div", { class: "mini-head", "data-tauri-drag-region": true },
      el("div", { "data-tauri-drag-region": true },
        el("div", { class: "muted small", "data-tauri-drag-region": true }, "Today"),
        el("div", { class: "mini-date", "data-tauri-drag-region": true }, fmtDate(ds))),
      el("div", { class: "mini-actions" },
        el("button", { class: "icon-btn small" + (widgetPinned ? " on" : ""), title: widgetPinned ? "위젯 고정 해제" : "위젯으로 고정 (항상 위에 떠 있기)", onclick: toggleWidget }, "📌"),
        el("button", { class: "icon-btn small", title: "플래너 열기", onclick: () => IN_TAURI && invoke("show_main") }, "↗"))),
    el("div", { class: "quick-wrap" }, qi, qp),
    chips.length ? el("div", { class: "dday-row" }, ...chips) : null,
    el("section", { class: "mini-sec", "data-date": ds },
      ...(todayItems.length ? todayItems.map(itemCard) : [el("div", { class: "muted small pad" }, "오늘 일정 없음")]),
      todoList(ds, { withCarry: true })),
    el("section", { class: "mini-sec" },
      el("div", { class: "muted small" }, `Tomorrow · ${fmtDate(tomorrow)}`),
      ...(tomorrowItems.length
        ? tomorrowItems.map((it) => el("div", { class: "mini-line", style: `--c:${it.color || COLORS[0]}` }, el("span", { class: "m-time" }, it.start || "종일"), it.title))
        : [el("div", { class: "muted small pad" }, "일정 없음")]))
  ].filter(Boolean));
}

// ═════════════════════════ 편집 다이얼로그 ═════════════════════════
const dlg = $("#itemDialog");
const form = $("#itemForm");
let editing = null;
let pickedColor = COLORS[0];

function renderColors() {
  $("#colorPicker").replaceChildren(...COLORS.map((c) =>
    el("button", { type: "button", class: "swatch" + (c === pickedColor ? " on" : ""), style: `--c:${c}`, onclick: () => { pickedColor = c; renderColors(); } })));
}
const syncFreqFields = () => { $("#nthField").hidden = form.freq.value !== "monthly"; };
form.freq.addEventListener("change", syncFreqFields);

// ── 24시간제 시간 입력: "13", "1300", "13:00", "9:30", "930" 모두 허용
function parseTime(str) {
  let t = String(str || "").trim().toLowerCase();
  if (!t) return "";
  const pm = /오후|pm/.test(t), am = /오전|am/.test(t);
  t = t.replace(/오전|오후|am|pm|\s/g, "").replace(/시/, ":").replace(/분/, "").replace(/\./, ":");
  let h, m;
  if (t.includes(":")) {
    const [a, b = "0"] = t.split(":");
    if (!/^\d{1,2}$/.test(a) || !/^\d{0,2}$/.test(b)) return null;
    h = +a; m = +(b || 0);
  } else {
    if (!/^\d{1,4}$/.test(t)) return null;
    if (t.length <= 2) { h = +t; m = 0; }
    else if (t.length === 3) { h = +t[0]; m = +t.slice(1); }
    else { h = +t.slice(0, 2); m = +t.slice(2); }
  }
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (h === 24 && m === 0) { h = 23; m = 59; }
  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}
function ampmLabel(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h < 12 ? "오전" : "오후"} ${h12}:${pad(m)}`;
}
function updateTimeHint(input) {
  const hint = form.querySelector(`.ampm[data-for="${input.name}"]`);
  const v = parseTime(input.value);
  input.classList.toggle("invalid", v === null);
  hint.textContent = v === null ? "잘못된 시간 (예: 13:00)" : ampmLabel(v);
  hint.classList.toggle("bad", v === null);
}
function setTime(input, v) { input.value = v || ""; updateTimeHint(input); }
let endTouched = false;

for (const input of form.querySelectorAll(".time-input")) {
  input.addEventListener("input", () => { if (input.name === "end") endTouched = true; updateTimeHint(input); });
  input.addEventListener("blur", () => {
    const v = parseTime(input.value);
    if (v !== null) setTime(input, v);
    // 시작을 정하면 종료가 비어있거나 시작보다 빠를 때 1시간 뒤로 자동 설정
    if (input.name === "start" && v) {
      const end = parseTime(form.end.value);
      if (!endTouched || !end || end <= v) setTime(form.end, addMinutes(v, 60));
    }
  });
  // ↑/↓ 30분, Shift+↑/↓ 5분
  input.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = parseTime(input.value) || (input.name === "end" && parseTime(form.start.value)) || "09:00";
    const [h, m] = cur.split(":").map(Number);
    const step = (e.shiftKey ? 5 : 30) * (e.key === "ArrowUp" ? 1 : -1);
    const total = (((h * 60 + m + step) % 1440) + 1440) % 1440;
    if (input.name === "end") endTouched = true;
    setTime(input, `${pad(Math.floor(total / 60))}:${pad(total % 60)}`);
    input.dispatchEvent(new Event("blur"));
  });
}

// ── 준비 체크리스트 편집 (instance: 체크 가능 / template: 기본 항목 목록)
let editChecks = [];
let checkMode = "instance";
function renderCheckEditor() {
  const list = $("#checkList");
  list.replaceChildren(...editChecks.map((c, i) => {
    const cb = el("input", { type: "checkbox" });
    cb.checked = c.done;
    cb.onchange = () => { c.done = cb.checked; renderCheckEditor(); };
    return el("li", { class: c.done ? "done" : "" },
      checkMode === "instance" ? cb : el("span", { class: "dot" }, "•"),
      el("span", { class: "grow" }, c.text),
      el("button", { type: "button", class: "x", title: "삭제", onclick: () => { editChecks.splice(i, 1); renderCheckEditor(); } }, "×"));
  }));
  const n = editChecks.length, d = editChecks.filter((c) => c.done).length;
  $("#checkCount").textContent = checkMode === "instance" && n ? `${d}/${n}` : "";
}
$("#checkInput").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  const v = e.target.value.trim();
  if (!v) return;
  editChecks.push({ text: v, done: false });
  e.target.value = "";
  renderCheckEditor();
});

function firstOccurrence(r) {
  const probe = { ...r, skips: [] };
  let d = parseYmd(r.startDate || todayStr());
  for (let i = 0; i < 800; i++, d = addDays(d, 1)) if (occursOn(probe, ymd(d), d.getDay())) return ymd(d);
  return null;
}

function fillForm({ kind, ref, date }) {
  editing = { kind, ref, date };
  const isRec = kind === "recurring", isCard = kind === "card";
  const isOcc = isRec && ref && date;          // 정기 회의의 특정 회차
  const v = ref || {};
  $("#dialogTitle").textContent = (ref ? "" : "New ") + (isCard ? "Template" : isRec ? (isOcc ? `Routine · ${fmtDate(date)}` : "Routine") : "Event");
  $("#recurringFields").hidden = !isRec;
  $("#eventFields").hidden = isRec || isCard;

  form.title.value = v.title || "";
  setTime(form.start, v.start || (isRec ? "19:00" : ""));
  setTime(form.end, v.end || (isRec ? "20:00" : ""));
  endTouched = !!v.end;
  form.place.value = v.place || "";
  form.date.value = v.date || date || todayStr();
  form.endDate.value = v.endDate || "";
  form.deadline.checked = !!v.deadline;
  form.weekday.value = String(v.weekday ?? (date ? parseYmd(date).getDay() : new Date().getDay()));
  form.freq.value = v.freq || "weekly";
  form.nth.value = String(v.nth || 1);
  form.startDate.value = v.startDate || ymd(date ? mondayOf(parseYmd(date)) : weekStart);
  syncFreqFields();
  pickedColor = v.color || COLORS[0];
  renderColors();

  // 수정 범위 (정기 회의 회차에서 열었을 때)
  $("#scopeBox").hidden = !isOcc;
  form.scope.value = "future";
  $("#startDateField").hidden = isOcc;

  // 메모: 일정·카드는 항상, 정기 회의는 회차에서만
  const showNote = !isRec || isOcc;
  $("#occurrenceBox").hidden = !showNote;
  $("#occLabel").textContent = isCard ? "메모 양식" : isRec ? "이번 회차 메모" : "메모";
  form.occNote.value = isRec ? ((ref?.notes || {})[date] || "") : (v.note || "");

  // 준비 체크리스트
  checkMode = isCard || (isRec && !isOcc) ? "template" : "instance";
  $("#checkLabel").textContent = checkMode === "template" ? "Default Prep" : "Prep";
  editChecks = checkMode === "template"
    ? (v.prep || []).map((text) => ({ text, done: false }))
    : (isOcc ? occChecks(ref, date) : v.checks || []).map((c) => ({ ...c }));
  $("#checkInput").value = "";
  renderCheckEditor();

  $("#saveAsCard").hidden = isCard;
  $("#openMinutesFromItem").hidden = !(isRec && ref);
  $("#deleteItem").hidden = !ref;
  dlg.showModal();
  form.title.focus();
}
const openNew = (kind, date) => fillForm({ kind, ref: null, date });
const openItem = (it) => fillForm({ kind: it.kind, ref: it.ref, date: it.date });

function readForm() {
  const start = parseTime(form.start.value), end = parseTime(form.end.value);
  if (start === null) { updateTimeHint(form.start); form.start.focus(); return null; }
  if (end === null) { updateTimeHint(form.end); form.end.focus(); return null; }
  if (start && end && end <= start) {
    form.end.classList.add("invalid");
    const hint = form.querySelector('.ampm[data-for="end"]');
    hint.textContent = "시작보다 늦어야 해요"; hint.classList.add("bad");
    form.end.focus(); return null;
  }
  const title = form.title.value.trim();
  if (!title) { form.title.focus(); return null; }
  return { title, start, end: start ? end : "", place: form.place.value.trim(), color: pickedColor };
}

// 정기 회의를 date 기준으로 둘로 나눔: 기존은 date 전날까지, 새 시리즈는 date부터
function splitSeries(r, date, changes) {
  const later = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => k >= date));
  const earlier = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => k < date));
  const next = {
    ...structuredClone(r), id: uid(), ...changes, startDate: date,
    skips: (r.skips || []).filter((x) => x >= date), notes: later(r.notes), checks: later(r.checks),
  };
  r.skips = (r.skips || []).filter((x) => x < date);
  r.notes = earlier(r.notes); r.checks = earlier(r.checks);
  r.endDate = ymd(addDays(parseYmd(date), -1));
  data.recurring.push(next);
  return next;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const { kind, ref, date } = editing;
  const base = readForm();
  if (!base) return;
  const note = form.occNote.value.trim();
  const checks = editChecks.filter((c) => c.text).map((c) => ({ text: c.text, done: !!c.done }));
  const prep = checks.map((c) => c.text);
  let conflictDate = null;

  if (kind === "card") {
    const card = { ...base, note, prep };
    if (ref) Object.assign(ref, card); else data.cards.push({ id: uid(), ...card });
  } else if (kind === "recurring") {
    const rule = { weekday: Number(form.weekday.value), freq: form.freq.value, nth: Number(form.nth.value) };
    if (!ref) {
      data.recurring.push({ id: uid(), skips: [], notes: {}, checks: {}, prep, ...base, ...rule, startDate: form.startDate.value || todayStr() });
    } else if (!date) {
      Object.assign(ref, base, rule, { prep, startDate: form.startDate.value || ref.startDate });
    } else {
      // 특정 회차에서 수정
      conflictDate = date;
      const changes = { ...base, ...rule };
      const changed = Object.keys(changes).some((k) => String(changes[k] ?? "") !== String(ref[k] ?? (k === "freq" ? "weekly" : k === "nth" ? 1 : "")));
      const saveOcc = (r) => {
        r.notes = r.notes || {}; r.checks = r.checks || {};
        if (note) r.notes[date] = note; else delete r.notes[date];
        r.checks[date] = checks;
        syncNoteTodos(note, `${r.id}@${date}`, date);
      };
      const scope = form.scope.value;
      if (!changed) saveOcc(ref);
      else if (scope === "once") {
        ref.skips = [...new Set([...(ref.skips || []), date])];
        if (ref.notes) delete ref.notes[date];
        if (ref.checks) delete ref.checks[date];
        const ev = eventFrom(base, date, { note, checks, fromRecurring: ref.id });
        data.events.push(ev);
        syncNoteTodos(note, ev.id, date);
      } else if (scope === "future" && date > (firstOccurrence(ref) || date)) {
        saveOcc(splitSeries(ref, date, changes));
        toast(`${fmtDate(date)}부터 바뀐 내용으로 적용했어요 (이전 회차는 그대로)`);
      } else {
        Object.assign(ref, changes);
        saveOcc(ref);
      }
      if (changed && rule.weekday !== ref.weekday) conflictDate = null;
    }
  } else {
    const endDate = form.endDate.value && form.endDate.value > form.date.value ? form.endDate.value : "";
    if (form.endDate.value && form.endDate.value < form.date.value) { form.endDate.classList.add("invalid"); return form.endDate.focus(); }
    form.endDate.classList.remove("invalid");
    Object.assign(base, { date: form.date.value, endDate, note, checks, deadline: form.deadline.checked });
    const id = ref?.id || uid();
    if (ref) Object.assign(ref, base); else data.events.push({ id, ...base });
    syncNoteTodos(note, id, base.date);
    conflictDate = base.date;
  }
  persist(); render(); dlg.close();
  if (conflictDate) warnConflict(conflictDate, base.title);
});

$("#cancelItem").onclick = () => dlg.close();
$("#openMinutesFromItem").onclick = () => { const r = editing.ref; dlg.close(); openMinutes(r); };

$("#saveAsCard").onclick = () => {
  const base = readForm();
  if (!base) return;
  const isEvent = editing.kind === "event";
  data.cards.push({ id: uid(), ...base, note: isEvent ? form.occNote.value.trim() : "", prep: editChecks.map((c) => c.text) });
  persist(); renderDeck();
  toast(`'${base.title}' Template을 만들었어요. 왼쪽 Templates에서 날짜로 끌어 놓으세요.`);
};

$("#deleteItem").onclick = () => {
  const { kind, ref, date } = editing;
  const scope = kind === "recurring" && date ? form.scope.value : "all";
  if (kind === "card") data.cards = data.cards.filter((c) => c !== ref);
  else if (kind === "event") data.events = data.events.filter((x) => x !== ref);
  else if (scope === "once") ref.skips = [...new Set([...(ref.skips || []), date])];
  else if (scope === "future" && date > (firstOccurrence(ref) || date)) {
    ref.endDate = ymd(addDays(parseYmd(date), -1));
    for (const k of ["notes", "checks"]) if (ref[k]) for (const d of Object.keys(ref[k])) if (d >= date) delete ref[k][d];
  } else data.recurring = data.recurring.filter((r) => r !== ref);
  persist(); render(); dlg.close();
  toast("삭제됨 · ⌘Z");
};

// ═════════════════════════ 정기 회의 관리 ═════════════════════════
const recDlg = $("#recurringDialog");
function renderRecurringList() {
  const items = activeSeries().sort((a, b) =>
    WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday) || (a.start || "").localeCompare(b.start || ""));
  $("#recurringList").replaceChildren(...(items.length
    ? items.map((r) =>
        el("li", { style: `--c:${r.color}`, onclick: () => { recDlg.close(); fillForm({ kind: "recurring", ref: r, date: null }); } },
          el("span", { class: "rec-dot" }),
          el("span", { class: "grow" }, el("strong", {}, r.title), r.place ? el("span", { class: "muted" }, ` · ${r.place}`) : null),
          el("span", { class: "muted" }, `${recLabel(r)} ${timeRange(r.start, r.end)}`),
          el("button", { class: "btn small", onclick: (e) => { e.stopPropagation(); recDlg.close(); openMinutes(r); } }, "Notes")))
    : [el("li", { class: "empty" }, "아직 Routine이 없어요")]));
}
$("#closeRecurring").onclick = () => recDlg.close();

// ═════════════════════════ 검색 ═════════════════════════
const searchDlg = $("#searchDialog");
const searchInput = $("#searchInput");

function search(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const hit = (...xs) => xs.some((x) => x && x.toLowerCase().includes(q));
  const out = [];
  for (const e of data.events)
    if (hit(e.title, e.place, e.note, ...(e.checks || []).map((c) => c.text))) out.push({ date: e.date, title: e.title, sub: e.note || e.place || timeRange(e.start, e.end), color: e.color, open: { kind: "event", ref: e, date: e.date } });
  for (const r of data.recurring) {
    if (hit(r.title, r.place)) out.push({ date: null, title: r.title, sub: `${recLabel(r)} ${timeRange(r.start, r.end)}`, color: r.color, open: { kind: "recurring", ref: r, date: null } });
    for (const [ds, note] of Object.entries(r.notes || {}))
      if (hit(note)) out.push({ date: ds, title: r.title, sub: note, color: r.color, open: { kind: "recurring", ref: r, date: ds } });
  }
  for (const t of data.todos)
    if (hit(t.text)) out.push({ date: t.date, title: (t.done ? "✓ " : "☐ ") + t.text, sub: "To-do", color: "#8a8a84", open: null });
  return out.sort((a, b) => (b.date || "9999").localeCompare(a.date || "9999")).slice(0, 100);
}

function renderSearch() {
  const q = searchInput.value;
  const res = search(q);
  $("#searchResults").replaceChildren(...(q.trim()
    ? res.length
      ? res.map((r) => el("li", { style: `--c:${r.color || COLORS[0]}`, onclick: () => {
          searchDlg.close();
          if (r.date) goTo("week", parseYmd(r.date));
          if (r.open) fillForm(r.open);
        } },
          el("span", { class: "rec-dot" }),
          el("span", { class: "grow" }, el("strong", {}, r.title), el("div", { class: "muted small clamp" }, r.sub)),
          el("span", { class: "muted small" }, r.date ? r.date : "정기")))
      : [el("li", { class: "empty" }, "결과가 없어요")]
    : [el("li", { class: "empty" }, "일정 제목, 장소, 회의 메모, 할 일을 검색해요")]));
}
searchInput.addEventListener("input", renderSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) $("#searchResults li:not(.empty)")?.click();
});
function openSearch() { searchInput.value = ""; renderSearch(); searchDlg.showModal(); searchInput.focus(); }
$("#openSearch").onclick = openSearch;
$("#closeSearch").onclick = () => searchDlg.close();

// ═════════════════════════ 알림 ═════════════════════════
function computeReminders() {
  const s = data.settings;
  if (!s.notify) return [];
  const lead = Number(s.lead) || 0, now = Date.now(), out = [];
  for (let i = 0; i < 3; i++) {
    const d = addDays(new Date(), i), ds = ymd(d);
    for (const it of itemsFor(ds)) {
      if (!it.start) continue;
      const [h, m] = it.start.split(":").map(Number);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
      if (start <= now) continue;
      out.push({
        key: `${it.ref.id}@${ds}@${it.start}@${lead}`,
        at: start - lead * 60000,
        title: it.title,
        body: `${lead ? `${lead}분 후 시작` : "지금 시작"} · ${timeRange(it.start, it.end)}${it.place ? " · " + it.place : ""}`,
      });
    }
  }
  // 일요일 21:00 주간 돌아보기
  if (s.weeklyReview) {
    const sunday = addDays(mondayOf(new Date()), 6);
    const at = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate(), 21, 0).getTime();
    if (at > now - 5 * 60000) out.push({ key: `review@${ymd(sunday)}`, at, title: "Weekly Review", body: reviewSummary(weekStats(mondayOf(new Date()))) + " · 플래너에서 ◔ 버튼" });
  }
  // 마감 일정: 전날 09:00, 당일 09:00
  for (const e of upcomingDeadlines(2)) {
    const d = parseYmd(e.date);
    for (const [offset, label] of [[-1, "Due tomorrow"], [0, "Due today"]]) {
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, 9, 0).getTime();
      if (at > now - 5 * 60000) out.push({ key: `dl@${e.id}@${e.date}@${offset}`, at, title: `⚑ ${label}: ${e.title}`, body: `${fmtDate(e.date)} ${timeRange(e.start, e.end)}` });
    }
  }
  return out;
}
function syncReminders() {
  if (!IN_TAURI || IS_MINI || !ready) return;
  invoke("set_reminders", { list: computeReminders() }).catch((e) => showError("알림 설정 실패: " + errText(e)));
}

// ═════════════════════════ 백업 / 내보내기 ═════════════════════════
async function saveFile(name, content, mime) {
  if (IN_TAURI) {
    const path = await invoke("export_file", { name, content });
    toast(`저장했어요: ${path}`);
  } else {
    const a = el("a", { href: URL.createObjectURL(new Blob([content], { type: mime })), download: name });
    a.click(); URL.revokeObjectURL(a.href);
  }
}
const stamp = () => { const d = new Date(); return `${ymd(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`; };

const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsDate = (ds) => ds.replace(/-/g, "");
const icsDT = (ds, t) => `${icsDate(ds)}T${t.replace(":", "")}00`;

function buildIcs() {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Planner//KO", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Planner"];
  const dtstamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const times = (ds, it) => {
    if (it.start) {
      const end = it.end && it.end > it.start ? it.end : addMinutes(it.start, 60);
      L.push(`DTSTART:${icsDT(ds, it.start)}`, `DTEND:${icsDT(ds, end)}`);
    } else {
      L.push(`DTSTART;VALUE=DATE:${icsDate(ds)}`, `DTEND;VALUE=DATE:${icsDate(ymd(addDays(parseYmd(ds), 1)))}`);
    }
  };
  for (const e of data.events) {
    L.push("BEGIN:VEVENT", `UID:${e.id}@planner`, `DTSTAMP:${dtstamp}`, `SUMMARY:${icsEsc(e.title)}`);
    if (e.place) L.push(`LOCATION:${icsEsc(e.place)}`);
    if (e.note) L.push(`DESCRIPTION:${icsEsc(e.note)}`);
    if (e.endDate && e.endDate > e.date) {
      if (e.start) L.push(`DTSTART:${icsDT(e.date, e.start)}`, `DTEND:${icsDT(e.endDate, e.end || "23:59")}`);
      else L.push(`DTSTART;VALUE=DATE:${icsDate(e.date)}`, `DTEND;VALUE=DATE:${icsDate(ymd(addDays(parseYmd(e.endDate), 1)))}`);
      L.push("END:VEVENT");
      continue;
    }
    times(e.date, e);
    L.push("END:VEVENT");
  }
  for (const r of data.recurring) {
    // 첫 회차 찾기 (건너뛴 날 포함해서 규칙상 첫 날짜)
    const first = firstOccurrence(r);
    if (!first) continue;
    const day = ICS_DAY[r.weekday];
    let rule = r.freq === "biweekly" ? `FREQ=WEEKLY;INTERVAL=2;BYDAY=${day}`
      : r.freq === "monthly" ? `FREQ=MONTHLY;BYDAY=${r.nth || 1}${day}`
      : `FREQ=WEEKLY;BYDAY=${day}`;
    if (r.endDate) rule += `;UNTIL=${icsDate(r.endDate)}T235959`;
    L.push("BEGIN:VEVENT", `UID:${r.id}@planner`, `DTSTAMP:${dtstamp}`, `SUMMARY:${icsEsc(r.title)}`);
    if (r.place) L.push(`LOCATION:${icsEsc(r.place)}`);
    times(first, r);
    L.push(`RRULE:${rule}`);
    for (const s of r.skips || []) if (s >= first) L.push(r.start ? `EXDATE:${icsDT(s, r.start)}` : `EXDATE;VALUE=DATE:${icsDate(s)}`);
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.join("\r\n") + "\r\n";
}

// ═════════════════════════ 주간 돌아보기 ═════════════════════════
function weekStats(monday) {
  const days = [...Array(7)].map((_, i) => ymd(addDays(monday, i)));
  const items = days.flatMap((ds) => itemsFor(ds).filter((it) => !it.span || it.span.i === 1));
  const meetings = items.filter((it) => it.kind === "recurring" || it.ref.fromRecurring);
  const checks = items.flatMap((it) => it.checks || []);
  const todos = data.todos.filter((t) => days.includes(t.date));
  const busiest = days.map((ds) => [ds, itemsFor(ds).length]).sort((a, b) => b[1] - a[1])[0];
  return {
    days, items, meetings,
    notesWritten: meetings.filter((it) => it.note).length,
    checksDone: checks.filter((c) => c.done).length, checksTotal: checks.length,
    unprepared: items.filter((it) => it.checks?.length && it.checks.some((c) => !c.done)),
    todosDone: todos.filter((t) => t.done).length, todosTotal: todos.length,
    leftover: todos.filter((t) => !t.done),
    busiest: busiest && busiest[1] ? busiest : null,
  };
}
function reviewSummary(st) {
  return `Routine ${st.meetings.length}회 · To-do ${st.todosDone}/${st.todosTotal} 완료` + (st.leftover.length ? ` · 남은 To-do ${st.leftover.length}개` : "");
}

const reviewDlg = $("#reviewDialog");
let reviewMonday = mondayOf(new Date());
function renderReview() {
  const st = weekStats(reviewMonday);
  const nextMon = addDays(reviewMonday, 7);
  const next = weekStats(nextMon);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "–");
  const line = (label, value, sub) => el("div", { class: "rv-line" }, el("span", { class: "muted" }, label), el("strong", {}, value), sub ? el("span", { class: "muted small" }, sub) : null);
  const itemRow = (it) => el("li", { style: `--c:${it.color || COLORS[0]}`, onclick: () => { reviewDlg.close(); goTo("week", parseYmd(it.date)); openItem(it); } },
    el("span", { class: "rec-dot" }), el("span", { class: "grow" }, it.title), el("span", { class: "muted small" }, fmtDate(it.date)));
  const end = addDays(reviewMonday, 6);
  $("#reviewTitle").textContent = `Weekly Review · ${reviewMonday.getMonth() + 1}월 ${reviewMonday.getDate()}일 – ${end.getMonth() + 1}월 ${end.getDate()}일`;
  $("#reviewBody").replaceChildren(...[
    el("div", { class: "rv-grid" },
      line("Events", `${st.items.length}개`, `Routine ${st.meetings.length}회`),
      line("Notes", `${st.notesWritten}/${st.meetings.length}`, "메모 남긴 회차"),
      line("Prep", pct(st.checksDone, st.checksTotal), `${st.checksDone}/${st.checksTotal} 항목`),
      line("To-do", pct(st.todosDone, st.todosTotal), `${st.todosDone}/${st.todosTotal} 완료`)),
    st.busiest ? el("p", { class: "muted small" }, `가장 바빴던 날: ${fmtDate(st.busiest[0])} (일정 ${st.busiest[1]}개)`) : null,
    st.unprepared.length ? el("h3", {}, "Prep이 덜 된 일정") : null,
    st.unprepared.length ? el("ul", { class: "rec-list" }, ...st.unprepared.map(itemRow)) : null,
    st.leftover.length ? el("h3", {}, `남은 To-do ${st.leftover.length}개`) : null,
    st.leftover.length ? el("ul", { class: "rec-list" }, ...st.leftover.map((t) => el("li", {}, el("span", { class: "grow" }, "☐ " + t.text), el("span", { class: "muted small" }, fmtDate(t.date))))) : null,
    st.leftover.length ? el("button", { class: "btn small", onclick: () => {
      const target = ymd(nextMon);
      st.leftover.forEach((t) => (t.date = target));
      persist(); render(); renderReview();
      toast(`남은 할 일을 ${fmtDate(target)}로 옮겼어요`);
    } }, `↪ 남은 To-do 다음 주 월요일로 옮기기`) : null,
    el("h3", {}, "Next Week"),
    el("p", { class: "small" }, `Events ${next.items.length}개 · Routine ${next.meetings.length}회 · To-do ${next.todosTotal}개`),
    ...(() => {
      const dls = next.items.filter((it) => it.deadline).concat(st.items.filter((it) => it.deadline && it.date >= todayStr()));
      return dls.length ? [el("h3", {}, "Due"), el("ul", { class: "rec-list" }, ...dls.map(itemRow))] : [];
    })()].filter(Boolean));
}
function openReview(monday = mondayOf(cursor)) { reviewMonday = monday; renderReview(); reviewDlg.showModal(); }
$("#openReview").onclick = () => openReview();
$("#reviewPrev").onclick = () => { reviewMonday = addDays(reviewMonday, -7); renderReview(); };
$("#reviewNext").onclick = () => { reviewMonday = addDays(reviewMonday, 7); renderReview(); };
$("#closeReview").onclick = () => reviewDlg.close();

// ═════════════════════════ 회의록 모아보기 ═════════════════════════
const minutesDlg = $("#minutesDialog");
let minutesOf = null;
function minutesEntries(r) {
  // 분할된 시리즈(같은 제목)와 그 회차에서 파생된 단발 일정까지 모두 모음
  const series = data.recurring.filter((x) => x === r || x.title === r.title);
  const ids = new Set(series.map((x) => x.id));
  const out = [];
  for (const x of series) {
    const dates = new Set([...Object.keys(x.notes || {}), ...Object.keys(x.checks || {})]);
    for (const ds of dates) {
      const checks = (x.checks || {})[ds] || [];
      if (!(x.notes || {})[ds] && !checks.some((c) => c.done)) continue;
      out.push({ date: ds, title: x.title, note: (x.notes || {})[ds] || "", checks, open: { kind: "recurring", ref: x, date: ds } });
    }
  }
  for (const e of data.events)
    if (ids.has(e.fromRecurring) && (e.note || (e.checks || []).some((c) => c.done)))
      out.push({ date: e.date, title: e.title, note: e.note || "", checks: e.checks || [], open: { kind: "event", ref: e, date: e.date }, extra: true });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
function renderMinutes() {
  const r = minutesOf, q = $("#minutesSearch").value.trim().toLowerCase();
  const entries = minutesEntries(r).filter((x) => !q || (x.note + " " + x.title).toLowerCase().includes(q));
  $("#minutesTitle").textContent = `${r.title} Notes`;
  $("#minutesList").replaceChildren(...(entries.length
    ? entries.map((x) => el("li", { onclick: () => { minutesDlg.close(); goTo("week", parseYmd(x.date)); fillForm(x.open); } },
        el("div", { class: "mn-head" },
          el("strong", {}, `${x.date.slice(0, 4)}년 ${fmtDate(x.date)}`),
          x.extra ? el("span", { class: "badge" }, x.title === r.title ? "변경된 회차" : x.title) : null,
          x.checks.length ? el("span", { class: "badge" }, `Prep ${x.checks.filter((c) => c.done).length}/${x.checks.length}`) : null),
        x.note ? el("div", { class: "mn-note" }, x.note) : el("div", { class: "muted small" }, "메모 없음")))
    : [el("li", { class: "empty" }, q ? "검색 결과가 없어요" : "아직 남긴 회의 메모가 없어요. 회차를 열어 '이번 회의 메모'를 적어 보세요.")]));
}
function openMinutes(r) { minutesOf = r; $("#minutesSearch").value = ""; renderMinutes(); minutesDlg.showModal(); }
$("#minutesSearch").addEventListener("input", renderMinutes);
$("#closeMinutes").onclick = () => minutesDlg.close();
$("#exportMinutes").onclick = () => {
  const r = minutesOf;
  const md = [`# ${r.title} Notes`, "", ...minutesEntries(r).reverse().flatMap((x) => [
    `## ${x.date} (${DAY_NAMES[parseYmd(x.date).getDay()]})${x.extra && x.title !== r.title ? ` — ${x.title}` : ""}`,
    ...(x.checks.length ? ["", "**Prep**", ...x.checks.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`)] : []),
    "", x.note || "_메모 없음_", ""])].join("\n");
  saveFile(`Notes_${r.title}_${stamp()}.md`, md, "text/markdown").catch((e) => showError(errText(e)));
};

// ═════════════════════════ 테마 ═════════════════════════
function applyTheme() {
  const t = data.settings.theme || "system";
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  if (IN_TAURI && !IS_MINI) invoke("set_theme", { theme: t }).catch(() => {});
}

// ═════════════════════════ 처음 실행 가이드 ═════════════════════════
const guideDlg = $("#guideDialog");
let guideStep = 0;

const demoChip = (text, color = COLORS[0], extra = "") =>
  el("div", { class: "g-chip " + extra, style: `--c:${color}` }, text);

function guideSlides() {
  const sample = "내일 3시 헬스 @학교";
  const actionBtn = (label, run) => {
    const b = el("button", { type: "button", class: "btn g-action" }, label);
    b.onclick = async () => {
      try { await run(); b.classList.add("done"); b.textContent = "✓ " + label; }
      catch (e) { showError(errText(e)); }
    };
    if (!IN_TAURI) { b.disabled = true; b.title = "앱에서만 동작해요"; }
    return b;
  };
  return [
    {
      title: "Planner에 오신 걸 환영해요",
      text: "개인 일정을 가볍게 관리하는 맥 플래너예요. 가장 빠른 방법은 한 줄로 입력하는 거예요.",
      visual: el("div", { class: "g-quick" },
        el("div", { class: "g-input" }, el("kbd", {}, "⌘K"), " ", sample),
        el("div", { class: "g-preview" }, "↵ " + describeQuick(parseQuick(sample)))),
    },
    {
      title: "반복되는 일정은 Routine",
      text: "+ Routine 에서 매주 · 격주 · 매월 n번째를 고를 수 있어요. 회차마다 메모를 남기고 ↻ 에서 모아볼 수 있어요.",
      visual: el("div", { class: "g-week" },
        ...["월", "화", "수", "목", "금"].map((d, i) =>
          el("div", { class: "g-day" }, el("span", { class: "muted small" }, d),
            i === 2 ? demoChip("19:00 스터디") : null,
            i === 0 || i === 3 ? demoChip("07:00 헬스", COLORS[1]) : null))),
    },
    {
      title: "자주 쓰는 일정은 Template",
      text: "왼쪽 Templates에 저장해 두고, 원하는 날짜로 끌어 놓으면 바로 일정이 생겨요. 기존 일정에서 Save as Template으로도 만들 수 있어요.",
      visual: el("div", { class: "g-drag" },
        el("div", { class: "g-deck" }, el("div", { class: "muted small" }, "Templates"), demoChip("헬스 19:00", COLORS[1])),
        el("div", { class: "g-target" }, el("span", { class: "muted small" }, "목"), demoChip("헬스 19:00", COLORS[1], "g-fly"))),
    },
    {
      title: "준비할 것과 할 일",
      text: "일정마다 Prep 체크리스트를 달 수 있어요. 메모에 - [ ] 로 쓰면 To-do로 자동으로 들어가요.",
      visual: el("div", { class: "g-card", style: `--c:${COLORS[0]}` },
        el("div", { class: "muted small" }, "14:00 – 15:00"),
        el("strong", {}, "캡스톤 발표"),
        el("div", { class: "g-check done" }, "☑ 슬라이드"),
        el("div", { class: "g-check" }, "☐ 노트북 충전"),
        el("div", { class: "g-memo" }, "- [ ] 발표 피드백 정리  →  To-do")),
    },
    {
      title: "마지막으로 설정해요",
      text: "필요한 것만 눌러 두세요. 나중에 ⚙︎ 설정에서 언제든 바꿀 수 있어요.",
      visual: el("div", { class: "g-actions" },
        actionBtn("알림 허용", () => invoke("test_notification")),
        actionBtn("로그인 시 자동 실행", () => invoke("set_autostart", { enabled: true })),
        actionBtn("위젯 띄우기 📌", () => invoke("set_widget", { pinned: true }))),
    },
  ];
}

function renderGuide() {
  const slides = guideSlides();
  const s = slides[guideStep];
  $("#guideSlide").replaceChildren(
    el("div", { class: "g-visual" }, s.visual),
    el("h2", {}, s.title),
    el("p", { class: "g-text" }, s.text));
  $("#guideDots").replaceChildren(...slides.map((_, i) =>
    el("button", { type: "button", class: "g-dot" + (i === guideStep ? " on" : ""), title: `${i + 1}/${slides.length}`, onclick: () => { guideStep = i; renderGuide(); } })));
  $("#guidePrev").hidden = guideStep === 0;
  const last = guideStep === slides.length - 1;
  $("#guideNext").textContent = last ? "시작하기" : "다음";
  $("#guideSkip").style.visibility = last ? "hidden" : "visible";
}
function openGuide() { guideStep = 0; renderGuide(); if (!guideDlg.open) guideDlg.showModal(); $("#guideNext").focus(); }
function finishGuide() {
  if (guideDlg.open) guideDlg.close();
  if (!data.settings.onboarded) { data.settings.onboarded = true; persist(); }
}
$("#guideNext").onclick = () => {
  if (guideStep >= guideSlides().length - 1) return finishGuide();
  guideStep++; renderGuide();
};
$("#guidePrev").onclick = () => { if (guideStep > 0) { guideStep--; renderGuide(); } };
$("#guideSkip").onclick = finishGuide;
guideDlg.addEventListener("cancel", (e) => { e.preventDefault(); finishGuide(); });
guideDlg.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") $("#guideNext").click();
  else if (e.key === "ArrowLeft") $("#guidePrev").click();
});
$("#openGuide").onclick = () => { setDlg.close(); openGuide(); };

// ═════════════════════════ 설정 ═════════════════════════
const setDlg = $("#settingsDialog");
function renderStorage(info) {
  const box = $("#storageBox");
  if (!IN_TAURI) { box.replaceChildren(el("p", { class: "muted small" }, "저장 위치 변경은 앱에서만 할 수 있어요.")); return; }
  const choose = (mode, strategy = "ask") => flush()
    .then(() => invoke("set_storage", { mode, strategy }))
    .then(async (inf) => {
      lastLoaded = null; ready = false; await reload();
      renderStorage(inf);
      toast(mode === "icloud" ? "이제 iCloud Drive에 저장해요" : "이제 이 맥에만 저장해요");
    })
    .catch((e) => {
      if (errText(e) === "EXISTS") {
        box.querySelector(".storage-ask")?.remove();
        box.append(el("div", { class: "storage-ask" },
          el("p", { class: "small" }, "선택한 위치에 이미 플래너 데이터가 있어요. 어느 쪽을 쓸까요?"),
          el("div", { class: "btn-row" },
            el("button", { class: "btn small", onclick: () => choose(mode, "use_target") }, "그곳에 있는 데이터 쓰기"),
            el("button", { class: "btn small", onclick: () => choose(mode, "overwrite") }, "지금 데이터로 덮어쓰기"))));
      } else showError(errText(e));
    });
  box.replaceChildren(
    el("div", { class: "seg small-seg" },
      el("label", {}, Object.assign(el("input", { type: "radio", name: "storage", value: "local" }), { checked: info.mode === "local", onchange: () => choose("local") }), " 이 맥에만"),
      el("label", { title: info.icloudAvailable ? "" : "iCloud Drive가 꺼져 있어요" },
        Object.assign(el("input", { type: "radio", name: "storage", value: "icloud" }), { checked: info.mode === "icloud", disabled: !info.icloudAvailable, onchange: () => choose("icloud") }), " iCloud Drive")),
    el("p", { class: "muted small path" }, info.path + "/planner.json"));
}

function openSettings() {
  $("#setNotify").checked = !!data.settings.notify;
  $("#setReview").checked = !!data.settings.weeklyReview;
  $("#setTheme").value = data.settings.theme || "system";
  if (IN_TAURI) invoke("get_storage").then(renderStorage).catch((e) => showError(errText(e)));
  else renderStorage({});
  const auto = $("#setAutostart");
  auto.disabled = !IN_TAURI;
  if (IN_TAURI) invoke("get_autostart").then((v) => (auto.checked = v)).catch(() => {});
  $("#setLead").value = String(data.settings.lead ?? 10);
  setDlg.showModal();
}
$("#openSettings").onclick = openSettings;
$("#closeSettings").onclick = () => setDlg.close();
$("#setNotify").onchange = (e) => { data.settings.notify = e.target.checked; persist(); };
$("#setAutostart").onchange = (e) => {
  invoke("set_autostart", { enabled: e.target.checked })
    .then((v) => { e.target.checked = v; toast(v ? "로그인할 때 메뉴바에서 자동으로 켜져요" : "자동 실행을 껐어요"); })
    .catch((err) => { e.target.checked = !e.target.checked; showError("자동 실행 설정 실패: " + errText(err)); });
};
$("#setReview").onchange = (e) => { data.settings.weeklyReview = e.target.checked; persist(); };
$("#setTheme").onchange = (e) => { data.settings.theme = e.target.value; applyTheme(); persist(); };
$("#setLead").onchange = (e) => { data.settings.lead = Number(e.target.value); persist(); };
$("#testNotify").onclick = () => {
  if (!IN_TAURI) return toast("알림은 앱에서만 동작해요");
  invoke("test_notification").then(() => toast("테스트 알림을 보냈어요")).catch((e) => showError(errText(e)));
};
$("#exportJson").onclick = () => saveFile(`planner-backup_${stamp()}.json`, JSON.stringify(data, null, 2), "application/json").catch((e) => showError(errText(e)));
$("#exportIcs").onclick = () => saveFile(`planner_${stamp()}.ics`, buildIcs(), "text/calendar").catch((e) => showError(errText(e)));
$("#importJson").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.recurring) || !Array.isArray(parsed.events)) throw new Error("플래너 백업 파일이 아니에요");
    await flush();
    await saveFile(`planner-before-import_${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
    data = normalize(parsed);
    persist(); render(); setDlg.close();
    toast(`가져왔어요 (정기 회의 ${data.recurring.length}개, 일정 ${data.events.length}개, 할 일 ${data.todos.length}개). 이전 데이터는 다운로드 폴더에 백업했어요.`);
  } catch (err) {
    showError("가져오기 실패: " + errText(err));
  }
};

// ═════════════════════════ 상단 버튼 / 단축키 ═════════════════════════
function shift(dir) {
  if (view === "week") cursor = addDays(cursor, 7 * dir);
  else if (view === "month") cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
  else cursor = new Date(cursor.getFullYear() + dir, 0, 1);
  render();
}
$("#prevWeek").onclick = () => shift(-1);
$("#nextWeek").onclick = () => shift(1);
$("#today").onclick = () => { cursor = new Date(); render(); };
document.querySelectorAll(".seg button[data-view]").forEach((b) => (b.onclick = () => goTo(b.dataset.view)));
document.querySelectorAll("#weekMode button").forEach((b) => (b.onclick = () => {
  weekMode = b.dataset.mode;
  try { localStorage.setItem("planner-weekmode", weekMode); } catch {}
  render();
}));
$("#addEvent").onclick = () => openNew("event", null);
if (!IS_MINI) attachQuick($("#quickInput"), $("#quickPreview"));
function toggleDeck() {
  deckOpen = !deckOpen;
  try { localStorage.setItem("planner-deck", deckOpen ? "1" : "0"); } catch {}
  render();
}
$("#addRecurring").onclick = () => openNew("recurring", null);

// 실행 취소: 앱에서는 메뉴(⌘Z)가 이벤트로 알려 줌, 브라우저에서는 키 입력으로
if (IN_TAURI && window.__TAURI__.event)
  window.__TAURI__.event.listen("menu", (e) => { if (document.hasFocus()) handleEditCommand(e.payload); });
document.addEventListener("keydown", (e) => {
  if (IN_TAURI || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
  const a = document.activeElement;
  if (a && /INPUT|TEXTAREA/.test(a.tagName)) return;
  e.preventDefault();
  e.shiftKey ? redo() : undo();
});

document.addEventListener("keydown", (e) => {
  const anyOpen = [...document.querySelectorAll("dialog")].some((d) => d.open);
  if (IS_MINI || anyOpen) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); return $("#quickInput").focus(); }
  if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); return openSearch(); }
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || e.metaKey || e.ctrlKey) return;
  const k = e.key;
  if (k === "ArrowLeft") shift(-1);
  else if (k === "ArrowRight") shift(1);
  else if (k === "t") $("#today").click();
  else if (k === "n") openNew("event", null);
  else if (k === "r") openNew("recurring", null);
  else if (k === "w") { if (view === "week") { weekMode = weekMode === "grid" ? "list" : "grid"; try { localStorage.setItem("planner-weekmode", weekMode); } catch {} render(); } else goTo("week"); }
  else if (k === "m") goTo("month");
  else if (k === "y") goTo("year");
  else if (k === "c") toggleDeck();
  else if (k === "v") openReview();
  else if (k === "k") { e.preventDefault(); $("#quickInput").focus(); }
  else if (k === "/") { e.preventDefault(); openSearch(); }
});

// ═════════════════════════ 시작 / 동기화 ═════════════════════════
window.addEventListener("error", (e) => showError(e.message));
window.addEventListener("unhandledrejection", (e) => showError(errText(e.reason)));

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("응답 없음(timeout)")), ms))]);

let lastLoaded = null;
async function reload() {
  if (saveTimer) return;                    // 저장 대기 중이면 내 변경이 우선
  if ([...document.querySelectorAll("dialog")].some((d) => d.open)) return;
  if (ready && /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
  try {
    const loaded = await withTimeout(store.load(), 3000);
    const raw = JSON.stringify(loaded);
    const changed = raw !== lastLoaded || !ready;
    lastLoaded = raw;
    if (changed && raw !== JSON.stringify(data)) { data = normalize(loaded || {}); render(); }
    if (!ready) {
      ready = true; render();
      if (!IS_MINI && !data.settings.onboarded) setTimeout(openGuide, 400);
    }
    applyTheme();
    if (changed) snapshot = JSON.stringify(data);
    syncReminders();
  } catch (e) {
    showError("데이터 불러오기 실패: " + errText(e));
  }
}

if (IS_MINI) document.body.classList.add("mini");
render();
reload();

// 다른 창(메뉴바 미니 창 ↔ 메인)에서 바뀐 내용 반영
window.addEventListener("focus", reload);
if (IN_TAURI && window.__TAURI__.event)
  window.__TAURI__.event.listen("data-changed", (e) => { if (e.payload !== WINDOW_LABEL) reload(); });
window.addEventListener("blur", flush);
document.addEventListener("visibilitychange", () => (document.hidden ? flush() : reload()));

// 날짜 변경 감지 + 주기적으로 알림 목록 갱신
let lastToday = todayStr();
setInterval(() => {
  const now = todayStr();
  if (now !== lastToday) { lastToday = now; render(); }
  reload();
}, IS_MINI ? 60 * 1000 : 5 * 60 * 1000);

})();
