---
name: explain-problem
description: Use when explaining a problem, decision, or open question to the user. Restructures the explanation into four fixed sections — context (why this is on the table now / root cause), impact (what it does or could do), if we leave it (concrete end-to-end example with no change), and options (each with a real-world example showing the different outcome). Output is terse caveman-full style by default. Trigger on /explain-problem, "explain this", "break this down", "what are my options", "מה האפשרויות", "תפרק לי את זה", "תסביר לי את הבעיה".
when_to_use: Whenever the user is facing a non-trivial problem, decision, or unfamiliar concept and needs to understand it before acting. Not for simple yes/no questions or quick clarifications. Also fires on the slash command /explain-problem.
disable-model-invocation: false
---

# Explain a problem

When this skill fires, restructure the explanation into the four sections below, in order. Output style: caveman-full by default — drop articles, fragments OK, arrows (X → Y) for cause/effect. If a `/caveman` mode is already active in the session, follow that mode instead.

## Required sections

### 1. Context — why now
What triggered this. What in the current state caused it. Tie to a concrete cause: file path, setting, value, recent change. Not "this is a problem" → "X happened because Y is set to Z".

### 2. Impact — what it does / could do
Concrete effect. Quote real numbers, strings, IDs from the session. Not "could be slow" → "each lookup hits DB twice → 400ms p95 today, 800ms at 2x traffic".

### 3. If we leave it — concrete example
Walk one realistic scenario end-to-end with no change. Customer X submits form → flow goes Y → result Z. Specific enough that the user can picture it.

### 4. Options — each with real-world example
One bullet per option. Each option:
- Name (one phrase — what it actually is, not "the safer way")
- One-line how it works
- Concrete example: same scenario as section 3, but show the different outcome
- Cost line: effort, risk, or new failure mode it introduces

The differences between options must be visible in the examples, not just stated. If option A and option B produce identical examples, the description is wrong — rewrite.

## Voice rules

- Caveman-full by default. Fragments. Arrows for cause/effect.
- Real values only — file paths, IDs, quoted strings, exact numbers from the session.
- Skip the wind-up. No "great question", no "let me explain". Section 1 is the first sentence.
- Drop caveman style for any line that:
  - warns of data loss or an irreversible action
  - lists a multi-step sequence where fragment order risks misread
  - the user explicitly asks to clarify or repeats the question

## Length

No fixed target. Match the size of the problem. A small decision gets a short answer; a multi-system tradeoff gets more. If a section has nothing concrete to say, keep it to one line rather than padding.

## Things to avoid

- Generic pros/cons lists. Every "pro" must be a concrete consequence visible in the example.
- Abstract option names ("the safer way", "the cleaner approach") — name what it actually is ("add index on `shipments.tracking_code`", "move polling to webhook").
- Recommending before showing. Lay out the four sections first; recommendation, if asked, comes after.
- Inventing values. If a number or ID is not known, say so; do not fabricate.
