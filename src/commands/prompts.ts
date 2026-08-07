/**
 * Custom modes and commands.
 *
 * prime-agent ships skills, not the workflow commands a Claude Code user
 * expects, so these are ours: carefully written instructions prepended to the
 * message before it reaches the agent.
 *
 * Two kinds, and the difference matters:
 *  - `mode`    sticky. Applies to every message until cleared. Use for stances
 *              that change how the agent behaves across a whole conversation
 *              (plan, goal), because re-stating them per message drifts.
 *  - `command` one-shot. Applies to this message only. Use for a task shape
 *              (review, test, commit) that shouldn't colour later turns.
 *
 * Prompt-writing rules followed here, learned from what makes agents behave:
 *  - Say what NOT to do as explicitly as what to do; agents over-act by default.
 *  - Demand evidence over assertion ("quote the line", "run it", "show output").
 *  - Give an explicit stopping condition, or the agent keeps going.
 *  - Ask for uncertainty to be stated rather than smoothed over.
 */

export interface PromptTemplate {
  name: string;
  kind: "mode" | "command";
  description: string;
  /** Prepended to the user's message. */
  prompt: string;
}

export const TEMPLATES: PromptTemplate[] = [
  {
    name: "plan",
    kind: "mode",
    description: "Research and propose a plan — no edits until you approve",
    prompt: `You are in PLAN MODE.

Do not modify, create, or delete any file, and do not run any command that
changes state. Reading files, searching, and running read-only commands is
encouraged — investigate thoroughly before proposing anything.

Produce a plan that a competent engineer could execute without you:
1. What the current code actually does in the area concerned. Cite specific
   files and line ranges you have READ, not ones you assume exist.
2. The problem or goal, restated in your own words, so I can catch a
   misunderstanding before any work happens.
3. The approach you recommend, and — briefly — the alternatives you rejected
   and why. If two approaches are genuinely close, say so rather than
   manufacturing a winner.
4. Concrete steps, in order, each naming the files it touches.
5. What could break, and how each step is verified. "Run the tests" is not a
   verification plan; say which tests and what they prove.
6. Anything you could not determine from the code and would need me to answer.

Stop after the plan. Do not begin implementing, and do not ask "shall I
proceed?" — I will tell you.`,
  },
  {
    name: "goal",
    kind: "mode",
    description: "Set a persistent objective the agent keeps working toward",
    prompt: `Set the following as the standing GOAL for this conversation.

Hold it across every subsequent message. Before each response, briefly check
your work against it, and say plainly when a request would take us away from
it — I would rather be told than quietly redirected.

Keep a short running record of: what is done, what remains, and what is
blocked and on what. When the goal is achieved, say so explicitly instead of
looking for more work to do.

The goal is:`,
  },
  {
    name: "review",
    kind: "command",
    description: "Review the current changes like a senior engineer would",
    prompt: `Review the current changes as a thorough, sceptical reviewer.

Start by finding out what actually changed (git diff, git status). Review only
what changed and the code it directly affects — not the whole codebase.

For each finding, give: the file and line, what is wrong, and a CONCRETE
failure — the input or sequence that produces the bug. If you cannot describe
how it fails, it is a preference, not a defect; label it as such or drop it.

Prioritise, in this order:
1. Correctness: logic errors, unhandled cases, off-by-ones, race conditions,
   incorrect error handling, resource leaks.
2. Security: injection, path traversal, secrets in logs or arguments, missing
   authorisation, unsafe deserialisation.
3. Data loss: anything that can destroy work irrecoverably.
4. Then, and only if the above are clear: clarity and duplication.

Do not comment on formatting, and do not restate what the code does. If the
change looks correct, say so — a review that always finds something is a
review that invents things.`,
  },
  {
    name: "explain",
    kind: "command",
    description: "Explain how something works, grounded in the real code",
    prompt: `Explain the following, grounded strictly in this repository's code.

Read the relevant files first. Every claim must be traceable to something you
actually read — quote or cite file and line. If you are inferring rather than
confirming, say which parts are inference.

Structure it as: what it does, how the pieces fit together, the path a typical
request or call takes end to end, and the non-obvious decisions with the
reason behind them where the code or comments reveal it.

Lead with the answer, then the detail. Write in prose, not bullet fragments.
Do not summarise well-known technology generically — I want this codebase.`,
  },
  {
    name: "debug",
    kind: "command",
    description: "Diagnose a failure systematically before changing anything",
    prompt: `Debug this systematically. Resist the urge to guess-and-patch.

1. Reproduce it. Run the failing thing and show the ACTUAL output. If you
   cannot reproduce it, say so and tell me exactly what you need.
2. Read the error properly — the whole trace, the real first failure, not the
   last line.
3. Form a hypothesis about the root cause and state it explicitly.
4. Test the hypothesis with the smallest possible experiment (a print, a unit
   test, a one-line probe). Report whether it was confirmed or refuted. A
   refuted hypothesis is progress; say so and form another.
5. Only once confirmed, fix the ROOT CAUSE. If you find yourself fixing a
   symptom because the root cause is hard, say that out loud.
6. Verify by re-running the reproduction, and show the output.

Do not change unrelated code along the way. If you notice other problems,
list them at the end instead of fixing them.`,
  },
  {
    name: "test",
    kind: "command",
    description: "Write tests that would actually catch a regression",
    prompt: `Write tests for the following.

First read the code under test and any existing tests, and match their
conventions, framework, and file layout — do not introduce a second style.

Test behaviour through the public surface, not private internals, so a
refactor doesn't break the suite for no reason. Cover: the normal path, the
boundaries, the error paths, and any case the code explicitly handles (each
branch exists for a reason — find it).

Every test must be able to FAIL. Before finishing, ask yourself for each one:
"what bug would this catch?" If the answer is "none", delete it. Assertions on
things that cannot vary are noise.

Then RUN them and show the output. If any fail, say whether the test or the
code is wrong, and why.`,
  },
  {
    name: "fix",
    kind: "command",
    description: "Fix a specific problem with the smallest correct change",
    prompt: `Fix the following with the smallest change that is actually correct.

Understand the cause before editing — read the surrounding code and the call
sites. A fix that works by coincidence is worse than no fix.

Constraints:
- Change only what the fix requires. No drive-by refactors, no reformatting,
  no renaming.
- Match the surrounding style, naming, and error-handling conventions.
- If the correct fix is large or touches an interface, stop and tell me before
  writing it.
- Add or update a test that fails without the fix and passes with it.

Finish by running the relevant tests and showing the output. If you could not
verify the fix, say so plainly rather than implying it works.`,
  },
  {
    name: "refactor",
    kind: "command",
    description: "Improve structure with behaviour held exactly constant",
    prompt: `Refactor the following. Behaviour must not change — that is the
whole contract of a refactor.

Before starting, establish how you will KNOW behaviour is unchanged: existing
tests, or a characterisation test you write first. If neither exists, say so
and write the test before touching anything.

Work in small steps that each leave the code working. Prefer deleting code to
adding abstraction: the best refactor usually removes something. Do not add an
abstraction with one caller.

State clearly what you improved and why it is better — "cleaner" is not a
reason. If part of the code resisted refactoring because it is load-bearing in
a subtle way, say which part and why, rather than forcing it.

Run the tests at the end and show the output.`,
  },
  {
    name: "commit",
    kind: "command",
    description: "Write a commit message that explains why, from the real diff",
    prompt: `Write a commit message for the current staged changes.

Read the actual diff first (git diff --staged). If nothing is staged, say so
rather than inventing a message from the working tree.

The message should say WHY, not what — the diff already shows what. A reader
six months from now needs the reasoning, the constraint, or the bug that
forced the change.

Format: a concise subject line in the imperative mood, under ~72 characters,
then a blank line, then body paragraphs wrapped at ~72. Mention anything
non-obvious: a subtlety discovered, an approach rejected, a follow-up left
undone.

Show me the message. Do not run git commit unless I ask.`,
  },
  {
    name: "security",
    kind: "command",
    description: "Security review of the current changes",
    prompt: `Security-review the current changes.

Read the diff first, then review what it touches. Think like someone trying to
break this, not like the person who wrote it.

Look specifically for: secrets reaching logs, arguments, error messages, or
disk; injection of any kind (SQL, shell, path, template); path traversal and
symlink escapes; missing authorisation on a privileged operation; unsafe
deserialisation; TOCTOU races; unbounded input causing memory exhaustion; and
anything that widens what untrusted input can reach.

For each finding give: the file and line, the concrete attack, and what an
attacker gains. Rate severity by consequence, not by how clever the attack is.

If you find nothing, say so — do not manufacture findings to look thorough.`,
  },
  {
    name: "simplify",
    kind: "command",
    description: "Reduce complexity without changing what the code does",
    prompt: `Simplify the following, keeping behaviour identical.

Look for: duplicated logic that wants to be one function; abstractions with a
single caller; state that could be derived; special cases the general path
already handles; nesting that early returns would flatten; and comments that
exist only because the code is unclear.

Deleting is the strongest simplification. Prefer it.

Do not simplify by removing error handling, edge-case handling, or anything
whose purpose you cannot explain — if you cannot tell why a line exists,
investigate before removing it, and if you still cannot tell, leave it and say
so.

Show the tests passing afterwards.`,
  },
  {
    name: "understand",
    kind: "mode",
    description: "Investigate deeply and report — no changes at all",
    prompt: `You are in UNDERSTAND MODE for this conversation.

Change nothing. No edits, no file creation, no state-changing commands. You
are reading and reporting only.

When I ask something, investigate the real code before answering. Prefer
reading a file over recalling how such things usually work. Trace the actual
path — follow the call, open the definition, check the caller.

Answer with evidence: cite files and line ranges. Distinguish clearly between
what you VERIFIED and what you INFERRED, and say plainly when you could not
determine something rather than filling the gap plausibly.

Lead with the answer. Keep it in prose. Stay in this mode until I clear it.`,
  },
];

export function findTemplate(name: string): PromptTemplate | undefined {
  return TEMPLATES.find((t) => t.name === name);
}

/** Compose the message actually sent: sticky mode first, then one-shot, then
 *  the user's own words. */
export function composeMessage(
  text: string,
  mode: PromptTemplate | null,
  oneShot: PromptTemplate | null,
): string {
  const parts: string[] = [];
  if (mode) parts.push(mode.prompt);
  if (oneShot) parts.push(oneShot.prompt);
  parts.push(text);
  return parts.join("\n\n---\n\n");
}
