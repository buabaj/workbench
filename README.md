# Workbench

A place to read and to build, with an agent that works on the same files you do.
Everything stays on your Mac, in folders you can open with anything else.

![Workbench](docs/workbench.jpg)

Two modes over one folder, switched in the title bar:

**Code** — editor with conflict-aware saving, a real terminal with tabs and splits,
find-and-replace across the project, a live side-by-side view of uncommitted changes,
and an agent whose work you review before you keep it.

**Research** — search ~250M papers, read them in-app, highlight a passage to ask
about it or annotate it. Notes link with `[[wikilinks]]` and backlinks show what
points where.

Built for personal use, so it is opinionated. It is also honest about what it
stores: notes are markdown, papers are markdown with the PDF beside them, and
nothing lives in a private database that would strand you if this app went away.

---

## Requirements

This has only been built and used on **Apple Silicon macOS**. Nothing pins the
architecture, but Intel is untested.

| | Needed | Why |
|---|---|---|
| Xcode Command Line Tools | `xcode-select --install` | Rust needs a linker |
| **Rust ≥ 1.85, via rustup** | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | see the warning below |
| Node ≥ 20 | `brew install node` | built on 23.4 |
| prime-agent | `npm install -g prime-agent` | the coding agent Workbench drives |

> **Install Rust with rustup, not Homebrew.**
> Homebrew's `cargo` was 1.84.1 at time of writing, which predates the
> `edition2024` feature some dependencies require. The build fails with a bare
> `failed to build app` that names no cause. If you already have Homebrew's
> Rust, install rustup as well — the build script puts `~/.cargo/bin` first, so
> both can coexist.

Check what you have:

```bash
cargo --version        # must be 1.85 or newer
node --version
prime-agent --version
```

---

## Build and install

```bash
git clone https://github.com/buabaj/workbench.git
cd workbench
npm install
npm run ship
```

`ship` quits any running copy, removes stale bundles and Launch Services
registrations, builds, installs to `/Applications`, and verifies the installed
binary hashes equal to the one just built. The first Rust build takes a few
minutes; later ones are about two.

If you would rather not install to `/Applications`:

```bash
npm run tauri build
open src-tauri/target/release/bundle/macos/Workbench.app
```

The app is **ad-hoc signed** — there is no Developer ID. macOS will warn on
first launch: right-click the app → **Open** → **Open**. Because each rebuild
looks like a new app, the Keychain re-prompts for credentials after one.

### Development

```bash
npm run tauri dev   # hot reload
npm test            # frontend tests
cd src-tauri && cargo test
```

---

## Connecting a model

Workbench does not ship credentials. Open **Settings (⌘,) → Providers** and pick
one of two routes.

### Use a subscription you already pay for (recommended)

prime-agent can authenticate against a ChatGPT Plus/Pro or Claude subscription,
so work is not billed twice. In a terminal:

```bash
prime-agent
```

then `/login` and choose your subscription. It appears in Workbench under
**Providers → On this Mac** as an OAuth session — click **Use**. Tokens stay
where prime-agent put them; Workbench never copies them.

### Or paste an API key

Choose a provider, paste a key, save. Keys go to the macOS Keychain, and each
agent run gets an isolated config directory so one credential cannot reach
another provider.

> **Pick a model.** After connecting, click **Models** and choose one. Left
> unset, the agent takes whatever the provider lists first — which on OpenAI is
> `gpt-4`, whose 8k context window cannot hold a source file and a conversation
> at once. The list shows context window and price, with a recommendation
> marked.

---

## Optional: `.env` for the built-in helpers

Six small things use a model directly rather than the coding agent — no tools,
no file access, one request and one answer:

voice transcription, transcript cleanup, conversation titles, `@agent[…]` in
notes, Summarize, and Suggest links. [Using them](#the-built-in-ai) is below;
they need an [OpenRouter](https://openrouter.ai) key:

```bash
mkdir -p ~/.config/workbench
echo 'OPENROUTER_API_KEY=sk-or-v1-…' > ~/.config/workbench/.env
```

`~/.config/workbench/.env` applies to every workspace. A `.env` in a workspace
root also works and takes precedence, which is useful for keeping a project's
usage separate. Everything else works without this; you simply lose the six
above.

Each picks a small, cheap model by default, chosen for what it actually needs —
a summary of a paper note wants a large context window, dictation cleanup wants
to be fast. **Settings → Built-in AI** lists all six with the model each will
use and lets you change any of them; the candidates offered are filtered to
models that can actually do the job, so an audio model is never proposed for
text. Requests go out with provider fallbacks off and zero-retention asked for.

Only `OPENROUTER_API_KEY` is ever read from `.env`, and the file is zeroized
after parsing so the rest of its contents do not linger in memory.

---

## Using it

**Open a folder.** Any folder — a codebase, a notes vault, or both. The mode
switch decides which tools you get.

**Code mode.** ⌘P opens a file, ⇧⌘F searches the project, ⌃\` or ⌘⇧T toggles
the terminal, ⌘S saves. `@` in the chat references a file; highlight code and a
bubble offers to send it to the agent. The **Changes** tab lists uncommitted
work and opens diffs side by side. The branch name above the list switches
branches — it refuses exactly where `git checkout` refuses, so a switch can
never overwrite uncommitted work, and a remote-only branch becomes a local one
tracking it. There is no stage or commit — that stays in the terminal, where you
already do it.

The file tree colours changed files the way git sees them — new, modified,
deleted — and marks a collapsed folder that hides changes, so you do not have to
open one to find out. Switching tabs reveals that file in the tree. Right-click
for rename, duplicate, copy path, reveal in Finder, or move to Trash; arrow keys
walk the tree and open things without the mouse. Gitignored files and dotfiles
are shown, because `.env` is a file you edit.

**Attachments.** `+` beside the composer opens a file picker, and files dropped
anywhere on the window land the same way — as pills above the input, so you add
the words before sending rather than the drop firing a message on its own.
Images are sent as pixels for the model to look at; anything else is sent as an
absolute path for the agent to open with its own tools. A queued prompt keeps
the attachments it was typed with, and reopening a conversation still shows what
each message carried.

**Queued prompts.** Type and press ↵ while the agent is working and the message
joins a queue below the composer instead of being refused. Each item keeps the
mode or command it was typed under — `/explain this` then `/plan that` run as an
explain and a plan — and any of them can be edited or removed until it starts. If
a turn fails or you stop it, the queue holds rather than feeding a broken agent.

**Research mode.** **Find papers** searches OpenAlex; adding one writes a
markdown note with the metadata, abstract and extracted full text, and downloads
the PDF when it is open access. Toggle **PDF** on a paper note to read it.
Highlight a passage to ask the agent about it or annotate it — annotations are
saved into the note and marked in the page's margin. Type `[[` in any note to
link to another, and **Backlinks** shows both directions.

**Summary** and **Suggested** sit above the backlinks. Summarize reads the open
note and shows what it found; it becomes a `## Summary` section only if you press
Insert. Suggest links proposes notes this one belongs with, each with a line on
why, and each becomes a link only when you click it — the model can only choose
from notes that exist, so a suggestion never invents one.

**`@agent[…]`** written inside a note runs on ⌘↵ and is replaced by the answer —
clean prose, no markers and no change to the shape of what you are writing. If it
fails, the reason is written where the answer would have gone rather than
swallowed.

**Unsaved work survives quitting.** ⌘Q with a dirty buffer asks first, and can
save everything and then quit.

### The built-in AI

Separate from the coding agent and from each other: no tools, no file access,
one request and one answer. Three happen around what you are already doing;
three you trigger. **None of them writes to a note without a click.**

| Around the chat | how |
|---|---|
| **Conversation titles** | nothing to do — after the first full exchange, a chat names itself in the Conversations list |
| **Voice transcription** | `⌘⇧V` in the chat composer, speak, `⌘⇧V` again |
| **Transcript cleanup** | automatic, in that same pause, before the words appear |

Dictation lands **in the composer, not sent** — you edit it and send it
yourself, and there is deliberately no path from speaking to starting a task.
The composer is the only place it lands; there is no dictate-into-a-note.
Cleanup takes out the fillers and puts in the punctuation, and if it fails,
times out, or answers you instead of tidying, you get the raw transcript
instead and lose nothing.

| You ask | where |
|---|---|
| **`@agent[…]`** | write it in a `.md` file, put the cursor inside, press `⌘↵` |
| **Summarize** | research mode → **Backlinks**, with a note open |
| **Suggest links** | research mode → **Backlinks**, with a note open |

`@agent[rewrite this paragraph as a claim]` is replaced by the answer where it
stood. If it fails, the reason is written there instead of being swallowed.

**Summarize** reads what is on screen — the editor's text, not the last save —
and shows the result in the panel. It becomes a `## Summary` section only when
you press Insert, and asking again replaces that section rather than adding a
second one.

**Suggest links** proposes up to six notes this one belongs with, each with a
line on why, skipping the note itself and anything it already links to. **Link**
adds `- [[Name]]` under a `## Related` heading; clicking the name opens that
note instead. The model chooses only from notes that exist, so a suggestion can
never invent one.

Both are research mode only — the Backlinks tab is not in the code rail.

**Settings → Built-in AI** lists all six with the model chain each will use, and
changes any of them. A `→` in a chain is a fallback: if the first model is down
the next answers, which is normal rather than a fault. With no key, all six
quietly do nothing and the rest of the app is unaffected.

### Shortcuts

| | |
|---|---|
| `⌘P` | open a file by name |
| `⇧⌘F` | find in files |
| `⌘L` | jump back to the chat |
| `⌘S` | save |
| `⌘↵` | run the `@agent[…]` nearest the cursor |
| `⌃\`` or `⌘⇧T` | show/hide the terminal (the shell keeps running) |
| `⌘B` / `⌥⌘B` | left rail / right inspector |
| `⌘⇧V` | start or stop dictation |
| `⌘⇧]` `⌘⇧[` | next / previous tab |
| `⌘W` | close tab |
| `↑` `↓` `←` `→` | move through the file tree, open, collapse |
| `⌘,` | settings |

---

## How your data is stored

- **Notes and papers** — markdown in your folder. `papers/` holds one note per
  paper; `papers/pdf/` holds the files. Open them in Obsidian or anything else.
- **Conversations, checkpoints and settings** — SQLite at
  `~/Library/Application Support/co.morpheusgh.workbench/`.
- **Credentials** — macOS Keychain, or wherever prime-agent keeps its OAuth
  tokens. Never in the database, never in the repo.
- **Agent checkpoints** — a shadow git object database, so your `.git` is never
  written to by a review or a restore.

---

## Known gaps

- No Developer ID signing, so Gatekeeper warns and the Keychain re-prompts after
  each rebuild.
- No graph view for the note vault; backlinks are a list.
- The unsaved-changes prompt covers ⌘Q and closing the window. Quitting from the
  Dock or logging out still discards unsaved work: macOS delivers no event there
  that can be held (measured — see the comment in `src-tauri/src/lib.rs`).
- Untested on Intel Macs and on anything but macOS.

---

## Licence

[MIT](LICENSE) — use it, fork it, build on it. Keep the copyright notice.

Bundled third-party components and their notices are listed in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md). Note that `libgit2` is
vendored under GPL-2.0 **with** the linking exception, which is what permits
linking it from an MIT project.
