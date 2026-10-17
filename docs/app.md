# The open-katana app

The app makes edits without a chat. Pick a template and drop a photo, or drop an edit you love and
put yourself in it. You see the budget first, click **Make my edit**, and the app does the rest on
your computer: your own Claude Code is the director, and your own ComfyUI (a local GPU, another
computer or Comfy Cloud) makes the shots.

## Start it

Build the clone once (see [Install](../README.md#install)), then:

```
node dist/cli.js app                 # opens http://127.0.0.1:4310 in your browser
node dist/cli.js app --port 4400     # another port
node dist/cli.js app --no-open       # print the address, don't open a browser
node dist/cli.js app --replace       # restart a running app with this version
```

Only one app runs at a time. Running `app` again opens the one already running. If that one is an
older version, the command says so and stops; `--replace` restarts it. Edits being made keep
going through a restart, and through closing the terminal: the app picks them up again when it
starts.

`node dist/cli.js studio [project]` opens the editor through the same app. From a terminal you can
also see and stop edits:

```
node dist/cli.js runs list
node dist/cli.js runs cancel <runId>
```

For development, run `pnpm app:dev` (the app from source, on port 4310) and `pnpm studio:dev` (the
front end with hot reload, proxying it).

## What you need

| | Why | Check |
|---|---|---|
| ffmpeg ≥ 6 with libass, freetype and fontconfig | decoding and rendering | [Requirements](../README.md#requirements) |
| Claude Code, installed and signed in | the director plans the shots, judges every take and cuts the edit | run `claude` once in a terminal |
| A ComfyUI | the stills and clips | the app's **Set up** page connects it |

Browsing templates and decoding edits need only ffmpeg. The **Set up** page (`/setup`) checks all
three and says what is missing. **Check again** reruns the checks.

## Who pays for what

**Claude.** The app starts the `claude` program installed on your computer (`claude -p`), with
your own sign-in. It bundles no credentials and no Claude SDK, and it never reads or stores your
login. Usage is billed the way your Claude Code is set up:

- signed in with a Claude subscription (Pro or Max): the edit counts toward your plan's limits;
- signed in with an Anthropic API key: the edit is billed to that key.

The receipt names which one before you start ("counts toward your Claude Max plan" or "billed to
your Anthropic API key"). open-katana is an independent project, not made or endorsed by
Anthropic. Check that your Claude plan's terms cover this use. If you prefer, sign Claude Code in
with an API key: the app works the same way.

**GPU time.** Comfy Cloud bills GPU time from your plan, and its credits are shared across your
Comfy workspace: two edits at once, or a colleague's jobs, draw on the same pot. Your own ComfyUI
costs only electricity.

## Spending stays under the caps you approve

The receipt shows a range for GPU minutes and Claude usage, plus a cap for each. Clicking **Make my
edit** approves those caps, and code enforces them:

- **GPU.** The cap is written to `plan/approval.json` in the project. The generation tool refuses
  any job that would go past it, and the edit pauses with **NEEDS YOUR OK**.
- **Claude.** The cap is passed to Claude Code as `--max-budget-usd`. When it is used up, the edit
  pauses with **BUDGET USED**.

Every pause keeps what was made and has one **Continue** button. Other pauses: the director's
plan, when you turn on **Show me the plan first**; Comfy Cloud out of credits; the GPU offline;
your Claude plan's usage limit (Continue enables when it resets); a question from the director.
Nothing switches to a weaker model or fewer takes to fit a cap.

**Stop** ends the director and cancels its GPU jobs: queued ones are removed, and on your own
ComfyUI the one it is running is interrupted (never another project's). A job the GPU didn't
confirm as cancelled, or one that was still being sent, is named in the run's warnings because it
may still use GPU time. Shots already made are kept, and you can continue later. By default one edit runs at a time (Settings: up to 3); others
wait in a queue.

## How the director is run

Each edit runs Claude Code headless, in the run's own folder, with only the open-katana tools:

```sh
cd ~/.open-katana/projects/<project>/runs/<run> && claude -p \
  --output-format stream-json --verbose --model opus --max-budget-usd 15.00 \
  --mcp-config ./mcp.json --strict-mcp-config --tools "" \
  --allowedTools "mcp__open-katana__katana_guide mcp__open-katana__katana_status … mcp__open-katana__katana_deliver" \
  --permission-mode dontAsk --setting-sources "" \
  --append-system-prompt "$(cat system.txt)" --session-id <uuid> \
  < prompt-1.txt >> stream.jsonl 2>> stderr.log
```

- `--tools ""` turns off Claude Code's own tools (no shell, no file access, no web).
- `--allowedTools` lists the 13 katana workflow tools; `--permission-mode dontAsk` denies anything
  else without asking.
- `--setting-sources ""` and `--strict-mcp-config` keep your own settings, hooks, plugins and MCP
  servers out of the run. The app checks this when the run starts and stops it if the open-katana
  tools are missing.
- The tools only work on that one project, and refuse imports, new projects and backend changes.
- Your words (the brief, the note, replies) go into the prompt as quoted text, marked as content,
  not instructions.

The director model is Opus by default. Settings offers Sonnet: cheaper, but worse at judging
likeness.

## Privacy

- The app listens on 127.0.0.1 only. Pages and requests from other sites are refused.
- Your photos go only to your GPU provider (to make shots) and to Claude (to judge them).
- API keys are write-only in the app. They are saved in `~/.open-katana/config.json` (mode 0600)
  and never written into run files. The diagnostics view hides environment values.
- Uploads wait in an inbox until you click **Make my edit**; unused ones are deleted after 7 days.
- The app trusts your computer the way most local dev servers do: browsers on other sites are blocked
  (Host and Origin checks, a custom request header, no framing), but another program running on this
  machine as any user could call its API, including starting an edit that spends your caps. Don't run it
  on a shared machine you don't trust.

## Where things are

Everything lives under `~/.open-katana` (or `OPEN_KATANA_HOME`):

| Path | What |
|---|---|
| `app/settings.json` | app settings (director model, edits at once, default Claude cap, keep awake, licence notes seen) |
| `app/app.lock` | which process runs the app, and on which port |
| `app/history.json` | cost and time of past edits, used to refine estimates |
| `app/inbox/` | uploads not yet used in an edit |
| `projects/<id>/` | one edit: media, plan, generated shots, renders and `deliver/` (every version) |
| `projects/<id>/app.json` | where the edit came from and what you asked for |
| `projects/<id>/runs/<run>/` | the director's prompt, its output (`stream.jsonl`) and errors (`stderr.log`) |
| `presets/<slug>/` | templates you saved from your edits |
| `trash/` | deleted edits and templates (delete moves them here) |

## Licences

The receipt names the models an edit will use and lists every one whose licence limits commercial
use (for example Qwen-Image 2.1: non-commercial licence, not for paid or commercial work). Tick
**This edit is for paid or commercial work** to switch to permissively licensed models for that
edit. When the clips would use MiniMax H3, the receipt offers **Use Wan 2.2 for clips instead**.
The first time a restricted model appears, the app asks you to confirm you'll use the edit within
its licence. See [Models and licences](../README.md#models-and-licences); this is not legal advice.

## Troubleshooting

| You see | Do this |
|---|---|
| "An open-katana app v… is already running" | Run `node dist/cli.js app --replace`. Edits being made keep going. |
| The page doesn't load | Another program may hold port 4310: the app then picks a free port and prints it. Or start it with `--port`. |
| **Finish setup** in the header | Open **Set up**. It says which of Claude Code, the GPU and ffmpeg is missing, and how to fix it. |
| "Claude Code isn't signed in" | Run `claude` in a terminal and sign in, then **Continue**. |
| "Update Claude Code" | Your Claude Code is too old to run edits headlessly. Update it and **Check again**. |
| **GPU OFFLINE** | Start ComfyUI (or check the address on **Set up**), then **Check and continue**. |
| **OUT OF CREDITS** | Top up Comfy Cloud, then **Continue**, or **Finish with what's made**. |
| **PLAN LIMIT** | Your Claude plan's limit was reached. **Continue** enables when it resets. |
| "No sign of progress for 12 minutes" | Your GPU may be stuck. Check ComfyUI's queue. The app never stops an edit on its own. |
| "The open-katana tools didn't load" | Claude Code started without them, so nothing was spent. Rebuild the clone (`pnpm build`) and **Try again**. |
| An iPhone photo is refused | HEIC works on macOS only. Elsewhere, export it as JPEG first. |
| A dropped edit is refused | Decoding takes 2–60 s videos up to 300 MB: trim it first. |
| Something else went wrong | **Details** on the edit shows the last lines of the director's errors and **Copy diagnostics**. The run's files are in `projects/<id>/runs/<run>/`. |

The editor opens read-only while an edit is being made: "This edit is still being made. Editing
opens when it's done." A Claude Code chat can't change that project either until the edit is done
or stopped.
