// Run: node tests/editor.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../src/app.js`, 'utf8');

const mergeContext = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const DEFAULT_SETTINGS'), source.indexOf('const store =')), mergeContext);
const normalized = JSON.parse(vm.runInContext(`JSON.stringify(normalize({ recurring: [{ id: 'r', weekday: 4 }], events: null, todos: null, cards: {} }))`, mergeContext));
assert.deepEqual(normalized.recurring[0].weekdays, [4]);
assert.equal(normalized.recurring[0].weekday, 4);
assert.deepEqual(normalized.events, []);
assert.deepEqual(normalized.todos, []);
assert.deepEqual(normalized.cards, []);
const merged = JSON.parse(vm.runInContext(`JSON.stringify(mergeData(
  { events: [{ id: 'a', title: 'base' }, { id: 'b', title: 'base' }, { id: 'c', title: 'base' }, { id: 'd', title: 'base' }] },
  { events: [{ id: 'a', title: 'local' }, { id: 'c', title: 'base' }, { id: 'd', title: 'base' }, { id: 'l', title: 'local add' }], settings: { theme: 'dark' } },
  { events: [{ id: 'a', title: 'remote' }, { id: 'b', title: 'remote' }, { id: 'c', title: 'remote' }, { id: 'r', title: 'remote add' }], settings: { theme: 'light' } }
))`, mergeContext));
assert.deepEqual(Object.fromEntries(merged.events.map(item => [item.id, item.title])), {
  a: 'local', c: 'remote', l: 'local add', r: 'remote add',
});
assert.equal(merged.settings.theme, 'dark');
console.log('Normalization and three-way merge passed');

const seriesContext = vm.createContext({
  data: { recurring: [] }, todayStr: () => '2026-09-30', uid: () => 'next',
  structuredClone, parseYmd: value => new Date(`${value}T00:00:00`),
  addDays: (date, days) => new Date(date.getTime() + days * 864e5),
  ymd: date => date.toISOString().slice(0, 10),
});
vm.runInContext(source.slice(source.indexOf('const sameSeries ='), source.indexOf('// 체크리스트 저장')), seriesContext);
seriesContext.data.recurring = [
  { id: 'old', seriesId: 'series', title: '같은 제목', startDate: '2026-09-01', endDate: '2026-10-01' },
  { id: 'next', seriesId: 'series', title: '바뀐 제목', startDate: '2026-10-02' },
  { id: 'other', title: '같은 제목', startDate: '2026-10-02' },
];
assert.deepEqual(Array.from(vm.runInContext('activeSeries().map(item => item.id)', seriesContext)), ['next', 'other']);
vm.runInContext(source.slice(source.indexOf('function splitSeries('), source.indexOf('form.addEventListener("submit"')), seriesContext);
seriesContext.routine = { id: 'root', title: '회의', startDate: '2026-09-01', skips: [], notes: {}, checks: {} };
seriesContext.data.recurring = [seriesContext.routine];
vm.runInContext(`splitSeries(routine, '2026-10-01', { title: '새 제목' })`, seriesContext);
assert.equal(seriesContext.routine.seriesId, 'root');
assert.equal(seriesContext.data.recurring[1].seriesId, 'root');
console.log('Split series identity passed');

const quickContext = vm.createContext({ setTimeout() {}, toast() {}, data: { todos: [] }, uid: () => 'new' });
vm.runInContext(source.slice(source.indexOf('const DAY_NAMES'), source.indexOf('// ═════════════════════════ 데이터')), quickContext);
vm.runInContext(source.slice(source.indexOf('const DOW_MAP'), source.indexOf('function describeQuick')), quickContext);
const now = new Date(2026, 8, 30, 9);
const quickCases = [
  ['수 19시 운영진 회의 @7호관', { title: '운영진 회의', date: '2026-09-30', start: '19:00', end: '20:00', place: '7호관' }],
  ['내일 3시 멘토링', { title: '멘토링', date: '2026-10-01', start: '15:00', end: '16:00' }],
  ['10/20 캡스톤 제출 마감', { title: '캡스톤 제출 마감', date: '2026-10-20', deadline: true }],
  ['매주 목 20:00-22:00 스터디', { kind: 'recurring', title: '스터디', weekday: 4, start: '20:00', end: '22:00' }],
  ['매월 첫째 금 18시 총회', { kind: 'recurring', title: '총회', weekday: 5, nth: 1, start: '18:00', end: '19:00' }],
  ['다음주 화 오후 2시 반 면담 1시간', { title: '면담', date: '2026-10-06', start: '14:30', end: '15:30' }],
  ['10/3-5 축제', { title: '축제', date: '2026-10-03', endDate: '2026-10-05' }],
  ['3-5시 회의', { title: '회의', date: '2026-09-30', start: '15:00', end: '17:00' }],
];
for (const [input, expected] of quickCases) {
  quickContext.input = input; quickContext.now = now;
  const actual = JSON.parse(vm.runInContext('JSON.stringify(parseQuick(input, now))', quickContext));
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, `${input}: ${key}`);
}
vm.runInContext(source.slice(source.indexOf('function syncNoteTodos('), source.indexOf('// ═════════════════════════ D-day')), quickContext);
quickContext.data.todos = [{ id: 'old', date: '2026-09-30', text: '삭제됨', done: false, src: 'note' }];
quickContext.note = '- [ ] 새 작업';
vm.runInContext(`syncNoteTodos(note, 'note', '2026-09-30')`, quickContext);
assert.deepEqual(quickContext.data.todos.map(todo => todo.text), ['새 작업']);
console.log('Quick parser examples and note todo cleanup passed');

const fields = {};
const form = new Proxy({}, { get: (_, key) => fields[key] ||= { value: '', focus() {}, classList: { add() {}, remove() {} } } });
const dayInputs = [1, 2, 3, 4, 5, 6, 0].map(value => ({ value: String(value), checked: false, focus() {} }));
fields.querySelectorAll = selector => selector.endsWith(':checked') ? dayInputs.filter(input => input.checked) : dayInputs;
fields.querySelector = () => dayInputs[0];
const nodes = {};
const context = vm.createContext({
  form, $: key => nodes[key] ||= {}, setTime() {}, todayStr: () => '2026-09-30',
  ymd: () => '2026-09-28', mondayOf() {}, weekStart: {}, syncFreqFields() {},
  parseYmd: value => new Date(`${value}T00:00:00`), COLORS: ['blue'], renderColors() {}, renderCheckEditor() {}, dlg: { showModal() {} },
});
vm.runInContext(source.slice(source.indexOf('const routineDays ='), source.indexOf('function occursOn(')), context);
vm.runInContext(source.slice(source.indexOf('function setWeekdays('), source.indexOf('$("#closeItem")')), context);
vm.runInContext(source.slice(source.indexOf('function fillForm('), source.indexOf('const openNew =')), context);
for (const [ref, date, expected] of [
  [null, '2026-10-03', '2026-10-03'],
  [null, null, '2026-09-30'],
  [{ date: '2026-10-03' }, null, '2026-10-03'],
  [{ date: '2026-10-03', endDate: '2026-10-05' }, null, '2026-10-05'],
]) {
  context.args = { kind: 'event', ref, date };
  vm.runInContext('fillForm(args)', context);
  assert.equal(form.endDate.value, expected);
}
let opened;
Object.assign(context, {
  view: 'week', deckOpen: true, data: { cards: [], recurring: [], todoSets: [] },
  activeSeries: () => [], toggleDeck() {},
  el: (tag, props, ...children) => ({ tag, props, children }),
  openNew: (...args) => { opened = args; },
});
nodes['#deck'] = { classList: { toggle() {} }, replaceChildren(...children) { this.children = children; } };
vm.runInContext(source.slice(source.indexOf('function renderDeck('), source.indexOf('function renderDday(')), context);
vm.runInContext('renderDeck()', context);
const heading = nodes['#deck'].children.find(node => node?.props.class === 'deck-head sub');
const add = heading.children.find(node => node.props.title === '새 Routine');
assert.ok(add);
add.props.onclick();
assert.deepEqual(opened, ['recurring', null]);
console.log('Editor dates and sidebar routine button passed');

context.args = { kind: 'recurring', ref: null, date: null };
vm.runInContext('fillForm(args)', context);
assert.equal(form.freq.value, 'weekly');
assert.equal(form.recEndDate.value, '');
context.args.ref = { startDate: '2026-10-01', endDate: '2026-10-31' };
vm.runInContext('fillForm(args)', context);
assert.equal(form.recEndDate.value, '2026-10-31');
vm.runInContext(source.slice(source.indexOf('function occursOn('), source.indexOf('function recLabel(')), context);
context.routine = { weekday: 4, weekdays: [4], startDate: '2026-10-01', endDate: '2026-10-08' };
assert.equal(vm.runInContext("occursOn(routine, '2026-10-08', 4)", context), true);
assert.equal(vm.runInContext("occursOn(routine, '2026-10-15', 4)", context), false);
let submit;
fields.addEventListener = (_, callback) => { submit = callback; };
Object.assign(context, { readForm: () => ({ title: 'Routine' }), uid: () => 'test',
  persist() {}, render() {}, toast() {}, dlg: { close() {} }, editChecks: [],
});
vm.runInContext(source.slice(source.indexOf('form.addEventListener("submit"'), source.indexOf('$("#cancelItem")')), context);
context.args.ref = null;
vm.runInContext('editing = args', context);
form.startDate.value = '2026-10-01';
form.recEndDate.value = '2026-09-30';
submit({ preventDefault() {} });
assert.equal(context.data.recurring.length, 0);
form.recEndDate.value = '2026-10-08';
submit({ preventDefault() {} });
assert.equal(context.data.recurring[0].endDate, '2026-10-08');
console.log('Routine defaults, end date, validation and inclusive cutoff passed');

context.routine = { weekdays: [3, 4], freq: 'weekly', startDate: '2026-10-01' };
assert.equal(vm.runInContext("occursOn(routine, '2026-10-07', 3)", context), true);
assert.equal(vm.runInContext("occursOn(routine, '2026-10-08', 4)", context), true);
assert.equal(vm.runInContext("occursOn(routine, '2026-10-09', 5)", context), false);
dayInputs.forEach(input => { input.checked = ['3', '4'].includes(input.value); });
submit({ preventDefault() {} });
assert.deepEqual(Array.from(context.data.recurring.at(-1).weekdays), [3, 4]);
const count = context.data.recurring.length;
dayInputs.forEach(input => { input.checked = false; });
submit({ preventDefault() {} });
assert.equal(context.data.recurring.length, count);
console.log('Multiple weekdays and empty selection validation passed');
Object.assign(context, {
  ICS_DAY: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'],
  firstOccurrence: () => '2026-10-07', addMinutes: () => '20:00',
  addDays: (date, days) => new Date(date.getTime() + days * 864e5), TextEncoder,
});
context.data.events = [];
context.data.recurring = [{ id: 'multi', title: 'Routine', weekdays: [3, 4], freq: 'weekly', start: '19:00', end: '20:00' }];
vm.runInContext(source.slice(source.indexOf('const icsEsc ='), source.indexOf('// ═════════════════════════ 주간 돌아보기')), context);
assert.match(vm.runInContext('buildIcs()', context), /RRULE:FREQ=WEEKLY;BYDAY=WE,TH/);
context.data.recurring[0].freq = 'monthly';
context.data.recurring[0].nth = 2;
assert.match(vm.runInContext('buildIcs()', context), /RRULE:FREQ=MONTHLY;BYDAY=2WE,2TH/);
context.data.recurring[0].freq = 'weekly';
context.data.recurring[0].start = '';
context.data.recurring[0].endDate = '2026-10-31';
context.data.recurring[0].title = '긴한글제목'.repeat(12);
const ics = vm.runInContext('buildIcs()', context);
assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=WE,TH;UNTIL=20261031\r\n/);
assert.match(ics, /\r\n /);
assert.ok(ics.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
let closed = false;
context.dlg = { close() { closed = true; } };
vm.runInContext(source.slice(source.indexOf('$("#closeItem").onclick'), source.indexOf('const syncFreqFields =')), context);
nodes['#closeItem'].onclick();
assert.equal(closed, true);
console.log('Calendar export and top close button passed');

const splitCtx = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const splitTodos ='), source.indexOf('function todoList(')), splitCtx);
assert.deepEqual(Array.from(vm.runInContext('splitTodos(s)', Object.assign(splitCtx, {
  s: '우유 사기\n- [ ] 과제 제출\n* 메일 답장\n• 세탁\n1. 운동\n- [x] 은행\n\n   \n2) 책 반납',
}))), ['우유 사기', '과제 제출', '메일 답장', '세탁', '운동', '은행', '책 반납']);
assert.deepEqual(Array.from(vm.runInContext('splitTodos("2026년 계획 세우기")', splitCtx)), ['2026년 계획 세우기']);
console.log('Bulk todo splitting passed');

// To-do 템플릿: 반복 요일에만 나오고, 완료·빼기는 날짜별. 예전 'To-do로' Routine은 템플릿으로 옮겨짐
const tsCtx = vm.createContext({ parseYmd: (v) => new Date(`${v}T00:00:00`), data: { todoSets: [
  { id: 's', title: '수업 루틴', items: ['대매체 수강', '독성학 퀴즈'], weekdays: [1, 3], startDate: '2026-11-16', done: { '2026-11-16': ['대매체 수강'] }, skip: { '2026-11-18': ['독성학 퀴즈'] } },
  { id: 'n', title: '장보기', items: ['우유'], weekdays: [] },
] } });
vm.runInContext(source.slice(source.indexOf('const setsOn ='), source.indexOf('// 끝나지 않았고')), tsCtx);
const on = (ds) => vm.runInContext(`setItemsOn('${ds}').map((x) => x.text + (x.done ? '✓' : ''))`, tsCtx);
assert.deepEqual(Array.from(on('2026-11-16')), ['대매체 수강✓', '독성학 퀴즈']);
assert.deepEqual(Array.from(on('2026-11-18')), ['대매체 수강']);
assert.deepEqual(Array.from(on('2026-11-17')), []);
assert.deepEqual(Array.from(on('2026-11-09')), []);   // 시작일 전에는 안 나옴
assert.equal(vm.runInContext("JSON.stringify(toggleIn({ a: ['x'] }, 'a', 'x', false))", tsCtx), '{}');
const migCtx = vm.createContext({ DEFAULT_SETTINGS: {} });
vm.runInContext(source.slice(source.indexOf('const COLLECTIONS ='), source.indexOf('let data =')) + source.slice(source.indexOf('const normalize ='), source.indexOf('function mergeData(')), migCtx);
const mig = vm.runInContext(`normalize({ recurring: [{ id: 'q', title: '퀴즈', todo: true, weekdays: [1], startDate: '2026-11-16', done: { '2026-11-16': true }, skips: ['2026-11-23'] }, { id: 'm', title: '회의', weekdays: [2] }] })`, migCtx);
assert.deepEqual(Array.from(mig.recurring, (r) => r.id), ['m']);
assert.deepEqual(JSON.parse(JSON.stringify(mig.todoSets)), [{ id: 'q', title: '퀴즈', items: ['퀴즈'], weekdays: [1], startDate: '2026-11-16', done: { '2026-11-16': ['퀴즈'] }, skip: { '2026-11-23': ['퀴즈'] } }]);
console.log('To-do templates and migration passed');
