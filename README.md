# @sigrun/ext-gateway

The gateway engine for [sigrun](https://github.com/sigrun-ai/sigrun):
chat-platform supervision, access-controlled inbound conversations,
live responses, and durable outbound delivery. Platform adapters are
separate extensions; this package owns their shared lifecycle and chat
semantics.

## Install and operation

Sigrun includes the gateway as its fourth built-in extension, enabled by
default. Install or enable channel adapters through sigrun's normal
extension configuration, then configure the gateway in
`<config-dir>/settings/gateway.json`.

To disable only the engine, set this in sigrun's `settings.json` and
restart. Contributed adapters then remain inert and do not receive chat
traffic.

```json
{
  "builtinExtensions": { "gateway": false }
}
```

To disable one channel while leaving the engine and other channels
running, set `"enabled": false` in its gateway channel block. A channel
without a block is also disabled. Channel enablement is restart-required;
other gateway settings are live reads.

`GET /v1/ext/gateway/status` is the admin status surface. It reports
adapter state, failures, retry/backoff state, and pending pairing
requests (with sender ids hashed, never raw).

## Configuration reference (spec §8.1)

The top-level object has three keys:

| Key | Meaning |
| --- | --- |
| `channels` | Map of adapter channel id to channel settings. |
| `media` | `{ "maxBytes": number }`; per-attachment cap, default 16 MiB. |
| `notify` | `{ "home": boolean }`; home-DM notifications, default `true`. |

A channel block supports:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Start this channel at boot. Changes require restart. |
| `dm` | `"pairing"` | Unknown-DM policy: `"pairing"`, `"allowlist"`, or `"disabled"`. |
| `selfLink` | `true` for pairing, otherwise `false` | Permit `/link` self-linking in DMs. |
| `allow` | `[]` | Static sender mappings: `[{ "sender": "100000001", "user": "alice" }]`. These take precedence over paired/self-linked identities. |
| `groups` | `[]` | Explicit group-chat policy rows; unlisted groups are ignored. |
| `busy` | `"followUp"` | Input while a run is live: `"followUp"` or `"steer"`. |
| `stream` | `true` | Stream live responses when the adapter supports editing. |
| `allowBots` | `false` | Admit bot senders (the loop guard still applies). |

Group rows have `chat` (platform chat id) and `owner` (sigrun user)
required, plus:

- `mention`: `"required"` (default) or `"always"`.
- `members`: `"linked"` (default) or `"anyone"`. The open `"anyone"`
  mode requires a non-empty `tools` array; `extensions` optionally pins
  the extension selection as well. Unknown senders still cannot use
  control commands or answer interactions.
- `tools` and `extensions`: optional arrays for the group's fixed agent
  selection. The gateway prompt is included in open-group selections.

Malformed channel or group blocks fail only that channel or group and
are visible in status; they do not disable siblings.

Example (synthetic ids):

```json
{
  "channels": {
    "telegram": {
      "dm": "pairing",
      "selfLink": true,
      "groups": [
        {
          "chat": "-100000000002",
          "owner": "alice",
          "members": "linked",
          "mention": "required"
        }
      ],
      "busy": "followUp",
      "stream": true,
      "allowBots": false
    }
  },
  "media": { "maxBytes": 16777216 },
  "notify": { "home": true }
}
```

## Pairing and self-linking

With `dm: "pairing"`, an unknown DM sender gets a single-use pairing
code. Their message is not submitted. An effective admin approves or
denies it in any webui/TUI conversation:

```text
/pair
/pair approve <code> <user>
/pair deny <code>
```

Admins' home DMs also receive pairing notices, with approve/deny buttons
where supported. Pairing requests expire after one hour, with at most
one pending request per sender, three per channel, and a ten-minute
request cooldown per sender. Deleting a user removes their links and
home chats but does not reset an existing request cooldown.

Self-linking requires no admin and is how the first operator can link:

1. In webui/TUI, run `/link <channel>`.
2. Send the returned `/link <code>` to the bot in a direct message on
   that channel.
3. The chat account is linked to the invoking sigrun user.

Codes are single-use and expire after one hour. A code posted in a
group is invalidated; redeem only in a DM. An existing link to another
user is never silently re-pointed. Static `allow` mappings take
precedence over stored links and are useful for a closed allowlist.
Use `/home` in a DM to move a user's notification home chat there.

## Chat commands and jobs

Bound chats support `/new`, `/stop`, `/model`, `/thinking`, `/compact`,
`/attach`, `/status`, `/home`, `/link`, `/pair`, and `/help`. Except for
the identity commands, control requires write access to the bound
conversation; `/attach` additionally requires write access to its target.
Native command menus merge non-colliding extension commands.

A prompt job with `conversation: "new"` can deliver its first settled
answer to gateway targets using `deliver`:

```json
{
  "name": "morning-note",
  "schedule": { "cron": "0 9 * * *", "timezone": "UTC" },
  "action": {
    "kind": "prompt",
    "prompt": "Write the morning note.",
    "conversation": "new",
    "deliver": ["loop", "telegram:-100000000002"]
  }
}
```

Use a channel id for a user's home DM or `<channel>:<chatId>` for an
explicit chat (thread suffixes belong to the opaque platform chat id).
An explicit target must be that home chat or a chat bound to a
conversation the job owner can write. Delivery also re-checks access.
Job answers are one-shot and durable: retries or later submissions do
not duplicate the delivered answer. A job targeting an existing bound
conversation uses that conversation's ordinary gateway fan-out instead.

## Delivery, state, and shutdown

Responses stream through adapter edit support where available. Final
outbound messages enter a durable ledger; transient sends retry with
backoff, chat-gone errors disable the dead binding, and delivered
entries prune after seven days. State files live under
`<state-dir>/ext-gateway/gateway/` with atomic 0600 writes.

On shutdown, intake closes and open album windows flush. The event bus
finishes the last run-settle window, delivery workers drain for up to
10 seconds, adapter stops are bounded at 5 seconds, and preview watches
are released. Undelivered `pending` or `attempting` entries remain in
the ledger for restart recovery; attempting entries are marked as
recovered before resend.

## Development

```sh
npm install
npm test            # vitest + manifest check
npm run typecheck
npm run build       # tsc -> dist/ (COMMIT the result)
```

Tests use `test/fake-host.ts` and synthetic users/channels only. Adapter
authors should read sigrun's `docs/extending.md`; this README is the
operator guide for the built-in engine.
