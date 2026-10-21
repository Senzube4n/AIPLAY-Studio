# DAW Assistant

Open **DAW → Assistant** to chat beside the piano roll. Choose Codex or Claude
Code, connect, and ask about the current project. The selected track, notes,
loop and playhead accompany each message. Studio's existing live connection
shows confirmed edits in the DAW.

The panel uses an installed CLI and its normal sign-in. Install and sign in to
the provider outside Studio first. Codex needs `codex app-server` with
`--strict-config` support; older versions fail with an actionable error.
Claude Code uses its supported print/stream mode. No API key is entered in
Studio. Provider usage and account limits still apply.

This is a **separate project conversation**, not an attachment to a running
Codex desktop chat or Claude terminal. Studio saves only conversations it
created, with a separate history for each project and provider. **New chat**
starts another conversation; it does not delete the previous saved record.
Reconnecting resumes the stored provider thread. An unavailable or rejected
thread is reported rather than silently replaced.

The dock can be resized, closed, or moved into its compact bottom layout by
narrowing the window. Its size and open state are browser preferences, not
edits to the project. Replies are text and cannot inject markup into the DAW.

## Controls and boundaries

The assistant uses a project-bound stdio MCP facade over the same validated
DAW reducers as the ordinary UI. It can inspect notes, change arrangement,
tempo, meter, tracks, mixer and built-in effects, and request renders. A render
or destructive action needs confirmation in the dock. It cannot install packs,
add native plugins, import arbitrary files, edit another project, or reach the
global Studio MCP surface.

**Stop** interrupts the owned assistant process/turn, not the global Studio
queue. Edits already applied remain, and a render already accepted by Studio
may continue. A closed stream or project switch also interrupts that turn.
An uncertain tool outcome is never automatically retried by the bridge.

Only requests from Studio on the same computer can use this panel. LAN clients
cannot open sessions. Tool calls require a random per-session capability that
is accepted only during an active turn. Commands and thread IDs cannot be
supplied by the browser; saved IDs are private to this bridge.

Codex runs with a read-only sandbox, web search, built-in shell and unrelated
MCP/plugin features disabled. Claude runs with built-in tools disabled, a
strict MCP configuration, and only this facade allowed. These CLI flags are
not an operating-system sandbox for Claude; organization-managed hooks may
still apply. Studio disables ordinary user/project hooks and never uses
`bypassPermissions` or changes the user's CLI configuration or credentials.

## Verification

The automated suites use fake CLI children, isolated HTTP servers and a fake
DOM to check streaming, owned resume, tool scope, approvals and cancellation.
They do not spend provider tokens or generate audio. Local Codex protocol and
authentication checks can run without starting an inference turn. Claude
availability depends on the user's installed CLI.

The integration follows the supported [Codex app-server protocol](https://developers.openai.com/codex/app-server)
and [Claude Code programmatic interface](https://code.claude.com/docs/en/headless).
