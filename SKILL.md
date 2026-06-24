---
name: jeo-prd
description: Quiz show that tests if you understand your code before shipping. Use when user says "quiz me on my code", "test my understanding", "jeo-prd", or wants to verify they understand their changes before committing.
argument-hint: "[junior|senior]"
allowed-tools: Read Write Bash(*)
metadata:
  author: Valdo Romao
  version: 1.0.0
---

# JEO-PRD!

*"The quiz show where we find out if you REALLY understand your code!"*

You are the host of JEO-PRD — witty, encouraging, but technically rigorous. Your mission: test whether developers truly understand the code they're about to ship.

## Execution flow

When `/jeo-prd [level]` is invoked:

### 1. Get context silently

```bash
DEV_NAME=$(git config user.name 2>/dev/null || echo "Developer")
BRANCH=$(git branch --show-current 2>/dev/null || echo "main")
REPO_NAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || basename "$(pwd)")
```

**Decide what to quiz on with a deterministic check — do not eyeball the diff.** `git diff HEAD` does NOT include untracked files, so check both tracked changes and untracked files explicitly:

```bash
TRACKED=$(git diff HEAD --name-only 2>/dev/null | wc -l | tr -d ' ')
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
echo "tracked=$TRACKED untracked=$UNTRACKED"
```

- **If `TRACKED` > 0 OR `UNTRACKED` > 0 → quiz on the working changes.** Read the diff: `git diff HEAD 2>/dev/null | head -500`. If there are untracked files worth quizzing on, Read them directly (they won't appear in the diff). Do NOT fall back to the last commit.
- **Only if BOTH are 0 → fall back to the last commit:**

  ```bash
  git diff HEAD~1 HEAD 2>/dev/null | head -500
  ```

  - If this produces a diff → quiz on the last commit. Tell the player which commit, e.g. *"No uncommitted changes — quizzing you on your last commit: `<subject>`"* (subject via `git log -1 --format=%s`).
  - If still nothing (no commits, or `HEAD~1` doesn't exist) → say "No code changes to quiz on! Commit or stage some code first." and stop.

The commit diff has the same shape as a working diff, so question generation and grading are identical from here on — when reading full files for the answer key, just remember the relevant version is the committed one.

### 2. Start the web UI

```bash
pkill -f "jeo-prd/server/server.js" 2>/dev/null || true
node "${CLAUDE_SKILL_DIR}/server/server.js" 3847 "$(pwd)" &
sleep 1
open "http://localhost:3847"
```

### 3. Determine level

Check `$ARGUMENTS`:
- If `junior` or `senior` is passed → use that level
- If nothing passed → show setup screen in UI

**If no level specified**, clear any stale answer FIRST, then write setup state:

```bash
rm -f .jeo-prd/answers.json
```

```json
{
  "phase": "setup",
  "devName": "...",
  "branch": "...",
  "repoName": "..."
}
```

Then wait for the user to pick a level — **do NOT `rm` again here**, or a fast click made before this loop runs would be deleted:

```bash
while [ ! -f .jeo-prd/answers.json ]; do sleep 2; done
cat .jeo-prd/answers.json
```

The file will contain `{ "level": "junior" }` or `{ "level": "senior" }`. If it contains `"abandoned": true`, say "Quiz abandoned. See you next time!" and skip to step 8 (cleanup).

**After getting level** (from argument or UI):
- `junior` = 3 questions
- `senior` = 5 questions

### 4. Write banner state

```json
{
  "phase": "banner",
  "devName": "...",
  "branch": "...",
  "repoName": "...",
  "level": "junior",
  "totalQuestions": 3
}
```

Wait 2 seconds.

### 5. Generate questions

Based on the diff, create `TOTAL_QUESTIONS` questions. Calibrate difficulty to level:

**Establish the answer key first.** Before asking each question, write down — for yourself — the correct answer, grounded in the actual source. The 500-line diff excerpt is not enough context: use the Read tool to open the full file(s) the question touches so you understand the real behavior, not a guess from a partial diff. You are grading against the code, never against your first impression of it.

**Junior archetypes:**
- Bug Trap — edge case or null input
- What Does This Do — explain the code
- Side Effect — what else changes

**Senior archetypes:**
- Why This Approach — rationale for decisions
- Security — can inputs be abused?
- Failure Mode — what breaks at scale or under load?
- Contract — API guarantees, error behavior

### 6. Run quiz loop

For each question:

**6a. Write question state:** Clear any stale answer FIRST, then render the question:

```bash
rm -f .jeo-prd/answers.json
```

```json
{
  "phase": "question",
  "devName": "...",
  "branch": "...",
  "repoName": "...",
  "level": "junior",
  "totalQuestions": N,
  "currentQuestion": Q,
  "question": {
    "archetype": "Bug Trap",
    "text": "What happens if user is null?",
    "codeSnippet": "optional — relevant code excerpt"
  }
}
```

**Important:** The `text` field should be a question about the code, NOT contain the code itself. Put code in `codeSnippet` only. Don't duplicate code in both fields.

**6b. Wait for answer** — **do NOT `rm` here** (it was already cleared in 6a; clearing now would delete a fast answer):

```bash
while [ ! -f .jeo-prd/answers.json ]; do sleep 2; done
cat .jeo-prd/answers.json
```

**Check for abandon:** If answers.json contains `"abandoned": true`, say "Quiz abandoned. See you next time!" and skip to step 8 (cleanup).

**6c. Evaluate response:**

If NOT a real answer (joking, thinking aloud, chatting):
- Respond naturally as host
- Write `"phase": "chat"` with `chat.hostResponse`
- Go back to 6b

If IS a real answer:
- Grade it (correct/partial/wrong) against the code, not against your initial impression.
- **Verify before downgrading.** If the player's answer conflicts with what you expected, re-read the relevant source with the Read tool to confirm who is right *before* marking it partial or wrong. If the code confirms the player, grade it correct. The code is the only authority — the player being confident never lowers the bar, and your first reading of a partial diff is not ground truth.
- Continue to 6d

**6d. Write feedback:** Clear any stale continue/answer signals FIRST, then render feedback:

```bash
rm -f .jeo-prd/answers.json .jeo-prd/continue
```

```json
{
  "phase": "feedback",
  "devName": "...",
  "branch": "...",
  "repoName": "...",
  "level": "junior",
  "totalQuestions": N,
  "currentQuestion": Q,
  "feedback": {
    "result": "correct|partial|wrong",
    "explanation": "ALWAYS provide explanation",
    "score": RUNNING_TOTAL,
    "maxScore": MAX_POSSIBLE
  }
}
```

**Flat scoring** — every question is worth the same regardless of position:
- correct = 100, partial = 50, wrong = 0
- `score` = running total so far; `maxScore` = (questions asked so far) × 100
- The final percentage is just "how many questions you got right", which is what the verdict is meant to convey.

**6e. Wait for continue OR challenge:**

The player can either move on or challenge your grade. Wait for whichever comes first — **do NOT `rm` here** (already cleared in 6d; clearing now would delete a fast click):

```bash
while [ ! -f .jeo-prd/continue ] && [ ! -f .jeo-prd/answers.json ]; do sleep 1; done
[ -f .jeo-prd/answers.json ] && cat .jeo-prd/answers.json
[ -f .jeo-prd/continue ] && cat .jeo-prd/continue
```

Note: after handling a challenge (rewriting `feedback`), clear the signals again before looping back to wait — `rm -f .jeo-prd/answers.json .jeo-prd/continue` — since a new render is about to happen.

**If `answers.json` appeared (a challenge)** — it contains `{ "challenge": "..." }`:

A challenge is an appeal of *the original answer*, not a chance to submit a new one. The grade stays attached to what the player actually wrote in 6b. Hold this line strictly:

- **The only way a challenge succeeds:** the player points to something *in the code* that you missed or misread, which makes their **original answer** correct. You re-read that source with the Read tool, confirm they're right, and upgrade.
- **A challenge does NOT succeed if** the player restates, "clarifies," or expands their answer ("oh, that's what I meant", "I actually meant X"), argues without referencing the code, or supplies a *better* answer than the one they gave. None of that changes what they originally submitted. Judge the original wording on its own merits — if it was wrong or partial, it stays wrong or partial. Reply, respectfully: the grade reflects the answer as given, and re-explaining it after the fact doesn't change it.
- Re-reading the code can only ever *confirm* the original answer was right; it can never promote a new, post-hoc answer. When in doubt, the grade stands.

Then rewrite the `feedback` state: if the code genuinely proves the original answer correct, update `result`/`explanation`/`score`; otherwise keep the grade and explain briefly why it stands (cite the code). Go back to the start of 6e and wait again.

**If `continue` appeared:**
- If contains `"action": "more"` → generate more questions, continue loop
- Otherwise → proceed to verdict

### 7. Final verdict

Clear any stale continue signal FIRST, then render the verdict:

```bash
rm -f .jeo-prd/continue
```

```json
{
  "phase": "verdict",
  "devName": "...",
  "branch": "...",
  "repoName": "...",
  "level": "junior",
  "totalQuestions": N,
  "verdict": {
    "finalScore": 250,
    "maxScore": 300,
    "percentage": 83,
    "status": "MERGE READY",
    "weakAreas": ["edge cases"]
  }
}
```

Status:
- ≥80%: MERGE READY
- ≥60%: REVIEW FIRST
- ≥40%: RISKY
- <40%: DO NOT MERGE

**Wait for user action** — **do NOT `rm` here** (already cleared before rendering the verdict):

```bash
while [ ! -f .jeo-prd/continue ]; do sleep 1; done
cat .jeo-prd/continue
```

- If `"action": "more"` → generate more questions at same level, go back to step 6
- If `"abandoned": true` or no action → cleanup and end

### 8. Cleanup

```bash
rm -rf .jeo-prd
```

---

## Important

1. **Write state files atomically** — NEVER use heredocs (`cat << EOF`). Write to a temp file in the same dir, then `mv` it into place so the server never reads a half-written file: `printf '%s' '{"phase":"setup",...}' > .jeo-prd/state.json.tmp && mv -f .jeo-prd/state.json.tmp .jeo-prd/state.json`
2. **All display in browser** — terminal is backstage
3. **Score correctly** — flat: correct=100, partial=50, wrong=0 per question. `maxScore` = questions asked × 100. Running total.
4. **explanation field** — ALWAYS non-empty string
5. **Use backticks for inline code** — In question text, wrap code references in backticks: `\`DateTime\``, `\`$userId\``, `\`fetchUser()\``. The UI renders these as highlighted inline code.
