import { test, expect } from 'claude-code/testing'
import { layout, mirror, wrap } from './register'

test('brackets around Hebrew mirror, code-like brackets stay', () => {
  expect(mirror('חלק (ב׳) כאן')).toBe('חלק )ב׳( כאן')
  expect(mirror('קוראים f(x) כאן')).toBe('קוראים f(x) כאן')
  expect(mirror('גרסה (version 2) כאן')).toBe('גרסה )version 2( כאן')
})

test('wrap keeps every row within width', () => {
  for (const r of wrap('אחת שתיים שלוש ארבע חמש שש שבע', 10)) expect([...r].length <= 10).toBe(true)
})

test('Hebrew lines become rows, code stays markdown', () => {
  const c = layout('## כותרת\n- פריט עם **מודגש** ו-English\n```\nconst x = 1\n```\n1. שלב ראשון', 80)
  expect(c).toEqual([
    { rows: [{ text: 'כותרת', bold: true }, { text: '• פריט עם מודגש ו-English', bold: false }] },
    { md: '```\nconst x = 1\n```' },
    { rows: [{ text: '1. שלב ראשון', bold: false }] },
  ])
})

test('draws right-aligned rows on the terminal', async $ => {
  const m = await $.ui.mount({
    plugin: 'hebrew-rtl', surface: 'terminal', component: 'AssistantMessage',
    props: { text: 'שלום עולם', isFirstOfReply: true },
  })
  expect((await m.findAll({ type: 'Text', text: 'שלום עולם' })).length).toBe(1)
})

import { promptRows } from './register'

test('a sent Hebrew prompt becomes right-aligned rows; English lines stay as typed', () => {
  expect(promptRows('שלום (עולם)\nnpm run dev', 40)).toEqual(['שלום )עולם(', 'npm run dev'])
  for (const r of promptRows('אחת שתיים שלוש ארבע חמש שש שבע שמונה', 12)) expect([...r].length <= 12).toBe(true)
})

test('draws a sent Hebrew prompt right-aligned with its marker', async $ => {
  const m = await $.ui.mount({
    plugin: 'hebrew-rtl', surface: 'terminal', component: 'UserMessage',
    props: { text: 'תתקן את הקלט', origin: { kind: 'composer' }, isExpanded: true },
  })
  expect((await m.findAll({ type: 'Text', text: 'תתקן את הקלט' })).length).toBe(1)
  expect((await m.findAll({ type: 'Text', text: ' ❯' })).length).toBe(1)
})

