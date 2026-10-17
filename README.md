# omp-session-prs

A [pi](https://github.com/badlogic/pi-mono) extension that lists the GitHub PRs of the current session in the footer, grouped by state: `● open`, `✔ merged`, `✕ closed`. Numbers are clickable. A url only counts once `gh pr view` confirms the PR exists, so pasted or hypothetical numbers never show up.

PRs are picked up from the session transcript, from tool results, and from `gh pr list` for the current branch. States refresh while the session runs.

## Install

```bash
pi install git+https://github.com/soraliu/omp-session-prs
```

Works under [omp](https://github.com/can1357/oh-my-pi) as well — its pi-compat
layer loads the same extension entry:

```bash
omp plugin install git+https://github.com/soraliu/omp-session-prs
```

Or add a local checkout to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/omp-session-prs/index.ts"]
}
```

## Usage

- The footer shows `PR ● #604 #612 ✔ #598 ✕ #590`, up to 5 entries plus a `+n` overflow count.
- `/prs` — pick a PR from this session and open it in the browser.
- `/prs list` — print the session's PRs as a markdown list in the transcript. The TUI renders each row as a clickable OSC 8 hyperlink, so the list stays clickable inside terminal multiplexers (herdr, tmux).
- `/pr-checks` — list the latest workflow runs of a PR (outcome, workflow, duration, failure reason; failures first) and open one in the browser. The PR dialog is skipped when the session has only one PR.

## Requirements

The [`gh` CLI](https://cli.github.com), authenticated.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).
