import type { Register } from 'claude-code'

const HEB = /[֐-׿]/
const LAT = /[A-Za-z]/
const DIGIT = /[0-9]/
const RLM = '‏'
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' }

// Strong direction for bracket resolution; digits count as R (UAX#9 N1).
const strong = (c: string) => (HEB.test(c) || DIGIT.test(c) ? 'R' : LAT.test(c) ? 'L' : null)

// The terminal reorders RTL runs but never mirrors brackets, so mirror each
// pair that resolves RTL (UAX#9 N0, simplified): Hebrew inside, or Latin
// inside with no Latin just before the opening bracket.
export function mirror(s: string): string {
  const ch = [...s]
  const open: number[] = []
  const flip = new Set<number>()
  const before = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (strong(ch[j])) return strong(ch[j])
    return 'R'
  }
  ch.forEach((c, i) => {
    if ('([{<'.includes(c)) return void open.push(i)
    if (!')]}>'.includes(c)) return
    const o = open.pop()
    if (o === undefined) return void flip.add(i)
    const inside = ch.slice(o + 1, i).map(strong)
    const rtl = inside.includes('R') || !(inside.includes('L') && before(o) === 'L')
    if (rtl) flip.add(o), flip.add(i)
  })
  open.forEach(i => flip.add(i))
  return ch.map((c, i) => (flip.has(i) ? MIRROR[c] : c)).join('')
}

export function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

export function wrap(s: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (let word of s.split(/\s+/).filter(Boolean)) {
    while ([...word].length > width) {
      if (line) out.push(line), (line = '')
      out.push([...word].slice(0, width).join(''))
      word = [...word].slice(width).join('')
    }
    if (!line) line = word
    else if ([...line].length + 1 + [...word].length <= width) line += ' ' + word
    else out.push(line), (line = word)
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}

type Row = { text: string; bold: boolean }
type Chunk = { md: string } | { rows: Row[] }

// Splits a reply into markdown chunks (code, tables, non-Hebrew lines) drawn
// as usual, and Hebrew lines turned into pre-wrapped rows to right-align.
export function layout(text: string, columns: number): Chunk[] {
  const width = Math.max(20, columns - 6)
  const chunks: Chunk[] = []
  let md: string[] = []
  let inFence = false
  const flush = () => {
    if (md.join('').trim()) chunks.push({ md: md.join('\n') })
    md = []
  }
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) inFence = !inFence
    if (inFence || /^\s*```/.test(raw) || /^\s*\|/.test(raw) || !HEB.test(raw)) {
      md.push(raw)
      continue
    }
    flush()
    const m = /^(\s*)(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?(.*)$/.exec(raw)!
    const heading = !!m[2] && m[2].startsWith('#')
    const marker = !m[2] || heading ? '' : /^[-*+]/.test(m[2]) ? '• ' : m[2].trim() + ' '
    const prefix = m[1] + marker
    const pad = ' '.repeat([...prefix].length)
    const rows = wrap(mirror(stripInline(m[3])), width - pad.length).map((piece, i) => {
      // A row whose first strong letter is Latin would turn LTR; pin it RTL.
      const firstStrong = [...piece].map(strong).find(Boolean)
      return { text: (firstStrong === 'L' ? RLM : '') + (i ? pad : prefix) + piece, bold: heading }
    })
    const last = chunks[chunks.length - 1]
    if (last && 'rows' in last) last.rows.push(...rows)
    else chunks.push({ rows })
  }
  flush()
  return chunks
}

// A typed prompt as rows: Hebrew lines wrapped and mirrored for RTL, other lines as typed.
export function promptRows(text: string, width: number): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!HEB.test(line)) { out.push(line); continue }
    for (const piece of wrap(mirror(line.replace(/\[Image #\d+\]\s*/g, '')), Math.max(10, width))) {
      const firstStrong = [...piece].map(strong).find(Boolean)
      out.push((firstStrong === 'L' ? RLM : '') + piece)
    }
  }
  return out
}

const BLOCK = '#373737'

export const register: Register = on => {
  // A sent prompt in the transcript: Claude's own highlighted block (background,
  // grey `❯` first, text in its own colour), the Hebrew rows right-aligned in it.
  // The sticky-prompt wrapper finds sent messages by exactly that shape, so it
  // must stay: background, then the glyph at the row's start.
  // ponytail: the dark theme's block colour; a light theme would want #f0f0f0
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer' || !HEB.test(e.props.text)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const rows = promptRows(e.props.text, (e.viewport?.columns ?? 80) - 6)
    return (
      <Box flexDirection="column" width="100%" backgroundColor={BLOCK}>
        {rows.map((r, j) => (
          <Box key={`u${j}`} width="100%" backgroundColor={BLOCK}>
            <Text color="subtle" backgroundColor={BLOCK}>{j ? '  ' : '❯ '}</Text>
            <Box flexGrow={1} justifyContent="flex-end" backgroundColor={BLOCK}>
              <Text color="text" backgroundColor={BLOCK}>{r || ' '}</Text>
            </Box>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary || !HEB.test(e.props.text)) return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const chunks = layout(e.props.text, e.viewport?.columns ?? 80)
    return (
      <Box flexDirection="column" width="100%">
        {chunks.map((c, i) =>
          'md' in c ? (
            <Markdown key={`md${i}`} text={c.md} />
          ) : (
            <Box key={`r${i}`} flexDirection="column" width="100%">
              {c.rows.map((r, j) => (
                <Box key={`r${i}.${j}`} width="100%" justifyContent="flex-end">
                  <Text bold={r.bold}>{r.text || ' '}</Text>
                </Box>
              ))}
            </Box>
          ),
        )}
      </Box>
    )
  })
}
