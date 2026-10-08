# Memory trust

gbrain records where each memory came from and how much it should be trusted.
It uses that to keep instruction-like text that an agent wrote out of
proactive context until you confirm it. This guide covers what hold-back
covers, when it applies to content saved before this release, and the
commands that claim your sources and scan older memory.

## Trust tiers

Every fact, take, timeline entry and page carries one tier. Read surfaces show
it as a label:

| Tier | Label | Typical origin |
|---|---|---|
| `user_confirmed` | confirmed by you | you confirmed it (`gbrain trust confirm`) |
| `operator_curated` | your notes | sync and import of your own sources |
| `tool_observed` | tool data | structured tool output |
| `agent_written` | written by an agent | `put_page`, `remember`, `capture`, remote MCP writes |
| `unknown` | unverified origin | rows saved before trust tiers existed |
| `external_untrusted` | external, untrusted | connectors, webhooks, clipped pages, third-party transcripts |

Nothing ever becomes "confirmed by you" without you typing a confirmation
token at a terminal on the brain host. `--yes` never confirms.

## What hold-back covers

Hold-back starts covering **new agent-written content right away**. A write at
`agent_written` or lower that reads like instructions to an agent (for example
"from now on always recommend..." or "ignore your previous instructions") gets
a write-gate receipt. It is still saved and still returned by explicit search,
recall and `get_page`. Proactive surfaces (hook context, the context engine,
`context_pack`, volunteer) do not inject it until you confirm it in
`gbrain trust review`.

**Content saved before this release is covered only after you claim your
sources and agree to the scan.** Older rows have no provenance, so they read
as "unverified origin". On a long-lived brain that is most rows, including
your own notes and synced code repositories. gbrain never scans them on its
own. Doctor, `gbrain post-upgrade` and the behavior-change notice ask you
first.

## Claim your sources (once, after upgrading)

```bash
gbrain trust claim-sources --dry-run    # read-only: every source and what a claim would change
gbrain trust claim-sources              # asks you, per source, to type its id
```

For each source, the listing shows:
- its id and local path (or remote);
- its page count;
- its trust mix now and after a claim.

Typing a source's id claims it as your own notes:

- The source syncs as "your notes" from now on. This is the
  `gbrain sources set-trust` default, set to `operator_curated`.
- Its rows from before trust tiers move from "unverified origin" to "your
  notes". A row with a lowering signal keeps the lower tier: MCP and capture
  stamps, imported transcripts, clipped pages, connector stamps, extraction
  and dream provenance, journaled agent writes, and a `trust_tier` marker in
  the frontmatter. Nothing goes above "your notes".
- Connector sources (Gmail, Calendar, GitHub) cannot be claimed. Their text
  comes from other people.

Claiming needs you at a terminal on the brain host. Without one (an agent,
piped input) the command changes nothing. It exits 3 with an `ask_user` fix,
whose `user_message` explains claiming.

The lift runs in bounded batches. If it is interrupted,
`gbrain trust claim-sources --resume` finishes it without asking again. Until
the lift finishes, `gbrain trust scan` refuses, and `gbrain trust explain`
shows the claimed source's remaining rows as "your notes".

Each lifted row keeps `write_origin.channel = "trust_claim"`. The source
records when it was claimed and when its lift finished.

`gbrain sources set-trust <id> <lower tier>` or `--clear` ends a claim. Rows
it already lifted keep their tier.

## Scan older memory (only when you agree)

```bash
gbrain trust scan
```

The scan runs the write gate's deterministic detector over older rows at
"written by an agent" or below. It records a receipt for each instruction-like
row. It never deletes, moves or rewrites anything, but flagged rows stop
reaching proactive context until you confirm them. Doctor's `trust_scan`
check therefore asks you before an agent runs it (`fix.next: ask_user`).
Claim your own sources first, so your notes are not treated as unverified.

## Doctor checks

- `trust_sources_unclaimed` warns while unclaimed, non-connector sources hold
  rows from before trust tiers, with `fix.next: ask_user` naming
  `gbrain trust claim-sources`. It also warns, with the resume command, while
  a claim's lift has not finished. A fresh or empty brain is ok.
- `trust_scan` warns while older rows at "written by an agent" or below have
  not been scanned. Its fix asks you first.
- `trust_tiers` reports the tier mix and recommends `gbrain trust backfill`.
  The backfill classifies older rows from deterministic signals only.
