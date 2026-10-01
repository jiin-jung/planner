// Run: node tests/editor.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../src/app.js`, 'utf8');
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
  view: 'week', deckOpen: true, data: { cards: [], recurring: [] },
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
context.routine = { weekday: 4, startDate: '2026-10-01', endDate: '2026-10-08' };
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
});
context.data.events = [];
context.data.recurring = [{ id: 'multi', title: 'Routine', weekdays: [3, 4], freq: 'weekly', start: '19:00', end: '20:00' }];
vm.runInContext(source.slice(source.indexOf('const icsEsc ='), source.indexOf('// ═════════════════════════ 주간 돌아보기')), context);
assert.match(vm.runInContext('buildIcs()', context), /RRULE:FREQ=WEEKLY;BYDAY=WE,TH/);
context.data.recurring[0].freq = 'monthly';
context.data.recurring[0].nth = 2;
assert.match(vm.runInContext('buildIcs()', context), /RRULE:FREQ=MONTHLY;BYDAY=2WE,2TH/);
let closed = false;
context.dlg = { close() { closed = true; } };
vm.runInContext(source.slice(source.indexOf('$("#closeItem").onclick'), source.indexOf('const syncFreqFields =')), context);
nodes['#closeItem'].onclick();
assert.equal(closed, true);
console.log('Calendar export and top close button passed');
