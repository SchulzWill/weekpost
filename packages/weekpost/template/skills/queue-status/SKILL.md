---
name: queue-status
description: Shows the publishing queue and helps cancel, reschedule or restore a post. Use when asked for "queue status", "what is scheduled", "a post failed", "cancel post X", "move post X to Friday", "restore post X", or in Portuguese "status da fila", "cancela o post", "adia o post", "o post falhou".
---

# Queue status, cancel and reschedule

Reading the queue is yours. Changing it is the human's: the commands that change a post ask for confirmation in a terminal, and the agent must not run them with `--yes`.

## Read

Run `npx weekpost status --json` (add `--week=YYYY-Www` for one week, `--failed` for failures only; a failed row's `last_error` says why). Summarize it as a short table: post, account, time, state. Say plainly what is late or failed.

## Explain a failure

Read `last_error` and match it with the table "Reading the Worker logs" in the weekpost README. Then suggest, in this order:

1. Check Instagram first: if the post is already there, the human runs `resolve ... --published=<permalink>`.
2. If it really did not go out, the human runs `reschedule <id> --account=<id> --at="YYYY-MM-DD HH:MM" --rearm`.
3. For Stories, which are posted by hand, `npx weekpost package <week>` prepares the files.

A post stuck in `publishing` for over 30 minutes needs `resolve`. Do not rearm before looking at Instagram, or the post may be duplicated.

## Cancel, reschedule, restore

Find the post with `status` and confirm the id and account with the person.

- **Move more than 24 hours ahead:** change the `date` or `times` in `content/<week>/posts.yaml` and open a pull request, so the change stays in the history. Run `npx weekpost check <week>` first.
- **Move soon, cancel, or restore:** do not run it. Print the command for the person to run in their own terminal, and say what it will do:

```sh
npx weekpost cancel <post-id> --account=<id>
npx weekpost reschedule <post-id> --account=<id> --at="YYYY-MM-DD HH:MM"
npx weekpost restore <post-id> --account=<id>
```

The command shows the before and after and asks. The person confirms there. Deleting a post from the YAML does not cancel it.

## Never

- Run a command with `--yes`, or `token`, `first-post`, `enqueue`, `wrangler`.
- Write to the database or call the Graph API directly. Use the CLI only.
- Print a token or key.
