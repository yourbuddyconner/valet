# Thread entrypoints

Threads are the public conversation address. A thread resolves to its existing runtime through `GET /api/threads/:id`.
The runtime still owns the sandbox, upload endpoint, and WebSocket connection. Thread addressing does not change authorization or execution scope.

## CLI

- `valet threads list [--workspace user|TEAM_ID]` lists workspace threads.
- `valet threads new [--workspace user|TEAM_ID] [--title TITLE]` creates a thread.
- `valet threads show ID` reads a thread.
- `valet send --thread ID TEXT` sends to that thread and follows its turn.
- `valet handoff DOC --thread ID` delivers a handoff document to that thread and returns its canonical URL.
- `valet chat --thread ID` opens an interactive conversation.
- `valet gates list --thread ID` lists that thread's decision gates.
- `valet status --thread ID` shows the thread address and its runtime status.
- `valet upload --thread ID PATH... [--message TEXT]` uploads into the thread's runtime sandbox.

An upload with `--message` sends the attachment references into the selected thread. The CLI follows the reply through the runtime WebSocket.
Files remain runtime resources. Uploading a file does not create a separate sandbox for the thread.
Status reads existing work and never creates a runtime.

`valet status` without a target still reports instance health and version skew.
`valet status --session ID` reports an existing runtime.
`valet upload --session ID PATH...` and `valet upload SESSION_ID PATH...` retain runtime addressing for existing scripts.
For send, chat, status, upload, and handoff, if both target flags are present, their runtime IDs must match. The CLI rejects a mismatch before uploading or sending. Gates accept only one target flag.
The legacy `sessions` command remains available for runtime operations.

## Web links

Dashboard thread rows, outcome links, briefing links, and thread sources use `/threads/:threadId` when a thread ID exists.
The thread route resolves the existing runtime and retains the runtime's security or workflow view.
Links with only a runtime ID retain `/sessions/:sessionId`. This includes work rows and security review entrypoints.
Runtime operations, permissions, usage attribution, and sandbox controls retain their runtime meaning.

## Validation

CLI tests cover target parsing, legacy runtime flags, mismatch rejection, upload routing, attachment submission, and runtime status reads.
Dashboard tests assert canonical thread URLs. API and web TypeScript checks cover the affected interfaces.

## Terminology audit

Conversation views and notifications use thread labels. Runtime-wide controls explicitly say runtime, including pause, delete, move, rename, browser access, and grants.
The legacy creation dialog creates a runtime and names that operation accurately. Usage remains runtime-based and labels its existing aggregation as runtimes.
Credential disclosures and sandbox defaults keep their runtime scope. The isolated workflow node is labeled Runtime; its wire type remains `session`.
Checkpoint links distinguish a known thread from a runtime-only address.

Security reviews retain their existing fix-session and child-session terms. These name isolated security execution units, not workspace conversations.
Legacy routes, wire types, internal identifiers, and raw debug transcript keys such as `session.id` remain compatible.
