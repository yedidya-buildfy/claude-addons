---
name: conversation-summary
description: Produce a plain-language wrap-up of the current chat session focused on real-world impact, not technical play-by-play. Trigger when the user asks for a "summary", "recap", "wrap-up", "what did we do", "what have we done in this chat", "סיכום", "סכם לי", or types /conversation-summary. Output is structured prose (not bullet lists) with concrete before/after examples using actual values from the session — names of files, IDs, quoted strings, page names — so the reader can see the change, not just hear about it.
when_to_use: Whenever the user asks for an end-of-session recap. The summary is for the user (a non-engineer operator) reading the dashboard, not for another engineer auditing the diff. The goal is "what changed in real life" before "what changed in code". Also fires on the slash command /conversation-summary.
disable-model-invocation: false
---

# Conversation summary

When this skill fires, write a plain-language summary of what happened in the chat. The reader is the **operator**, not an engineer reviewing your diff. They want to know what's different in their world now — not the names of the functions you changed.

## Voice and shape

- Write in flowing paragraphs grouped under H2 / H3 headers, not bullet lists. Bullets are for the "what changed in code, for the record" section at the end and for tables where structure is genuinely needed.
- Plain language but don't dumb it down. The operator is smart, just not in your stack. Explain the technical move, then immediately say what it means in their world.
- Quote real values from the session — actual file paths, commit SHAs, table names, page names, customer comment strings, environment variables, IDs. Concreteness over abstraction. If the user saw a Hebrew customer comment that was misclassified, quote the Hebrew comment in the summary so they recognize it.
- If the user came in with a hypothesis that turned out to be wrong, acknowledge it once, briefly, without rubbing it in. Move on to the actual diagnosis.
- Be honest about what was *not* done. Side issues that came up but weren't the focus, edge cases left open, follow-ups worth flagging — say so explicitly under "Outstanding".

## Required structure

Write these sections in this order. Skip a section if it genuinely doesn't apply (e.g. no commits → skip the codebase section), but never invent content to fill it.

### 1. The problem you came in with

One paragraph. What did the user report? What did they think the cause was? Quote their wording where useful.

### 2. What we found out

The actual diagnosis. If it differed from the user's hypothesis, name the gap directly. This is where surprises go — "you suspected X, and X was fine; the real issue was Y". Often there's more than one root cause hiding behind the original symptom — separate them numbered.

### 3. What we built/did to fix [each problem]

One H3 sub-section per real fix. Inside each:
- The concrete moves (new system user, new poller, new env var, prompt rule, etc.).
- A one-line "the technical surprise" callout if there was a non-obvious gotcha worth surfacing.

### 4. What's actually different now

The most important section. Before / after framing in **real-life terms**.
- "Before today, you had X comments visible. Now you have Y."
- "Before, customer asks 'קישור' → permanently deleted, you lose the sale. Now, → flagged for you to answer."
- Use real numbers from the session. Use real quoted user content. If the operator can't see themselves in this section, the summary failed.

### 5. What about [adjacent thing]?

Optional. If something obviously adjacent came up and wasn't the focus, address it in one short sub-section so the user doesn't wonder. Examples: "What about Instagram ads?" "What about pages we don't poll?"

### 6. What changed in the codebase, for the record

Tight technical reference. Commit SHAs, files touched, env vars added, migrations applied, doc paths updated. One line each. This is where you can get terse — the operator skips it, the next engineer reads it.

### 7. Outstanding stuff worth knowing

Honest. What we didn't fix, what we deliberately left, what's worth a follow-up conversation. Includes side observations the user should be aware of (e.g. "Meta's own auto-spam filter is hiding a lot of stuff before we see it"). Don't pad — if there's nothing outstanding, omit the section.

## Length

Aim for 600–900 words. Long enough that the operator can scan and rebuild context tomorrow without re-reading the chat; short enough that they actually read it. If the chat was small, the summary should be smaller — match the work.

## Things to avoid

- Don't say "we successfully shipped X" — flat statements about "what happened" are stronger than self-congratulatory framing.
- Don't list every file you read or every command you ran. The operator doesn't care about your search path.
- Don't promise future behaviour you can't guarantee ("from now on the AI will never make a mistake again"). Use "the new prompt protects X from being misclassified" — accurate.
- Don't bury the answer in a wall of headers. Section 4 ("What's actually different now") is where the value lives. Make sure it's strong.
- Don't use emojis. The user's repo policy bans them.

## A worked example to match style against

The summary that prompted creation of this skill — for a Drive Buddy session that fixed missing ad comments — followed exactly this structure: *problem you came in with* → *what we found* (token was fine, two real problems hiding) → *what we built* (system user + poller + prompt rules) → *what's actually different now* (concrete before/after with quoted Hebrew comments and real numbers — "Before: ~20 comments total. After: every new ad comment within 2 minutes") → *what about Instagram ads* (Meta reports zero, wiring's in place anyway) → *what changed in the codebase* (two commit SHAs + one-line each) → *outstanding* (the missing-order auto-hide pattern is still happening, worth a separate conversation).

When in doubt, lean toward more concrete examples and fewer abstract claims. The operator should finish reading and feel like they could explain to a colleague what changed today, in one minute, without saying "the moderator" or "the poller".
