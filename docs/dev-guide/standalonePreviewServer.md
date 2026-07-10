# Standalone Preview Server

The Standalone Preview Server is an experimental way to render PrairieLearn questions directly
from course files. It does not start PostgreSQL or the full PrairieLearn application. Authoring
tools can start one process with zero or more courses, create Local Preview Sessions at runtime,
and open session-scoped browser URLs.

The HTTP contract is versioned as `experimental-1`. It is a breaking replacement for the earlier
single-course proof of concept.

## Build and start

Build PrairieLearn before starting the compiled server:

```sh
pnpm --filter @prairielearn/prairielearn build
```

Start with no courses when an editor or integration will discover them later:

```sh
pnpm --filter @prairielearn/prairielearn preview:server
```

Start with one or more known courses by repeating `--course-dir`:

```sh
pnpm --filter @prairielearn/prairielearn preview:server -- \
  --course-dir /absolute/path/to/course-a \
  --course-dir /absolute/path/to/course-b
```

Each startup course creates a separate Local Preview Session. Two arguments that resolve to the
same canonical course directory still create two isolated sessions. Startup is atomic: if any
course is invalid, the process closes sessions it already created and fails instead of reporting
partial readiness.

The launch defaults are:

| Setting                     | Default         |
| --------------------------- | --------------- |
| Host                        | `127.0.0.1`     |
| Port                        | `4310`          |
| Render mode                 | `question-only` |
| Question timeout            | `5000` ms       |
| Worker execution mode       | `container`     |
| Worker count                | `1`             |
| Preview Workspaces          | disabled        |
| Workspace idle timeout      | `1800000` ms    |
| Running workspace maximum   | `3` server-wide |
| Workspace image pull policy | `missing`       |
| Workspace start timeout     | `60000` ms      |

Readiness output includes the listening origin and every startup Local Preview Session ID and
canonical course directory.

## Discover capabilities

`GET /health` is public and intentionally small:

```sh
curl http://127.0.0.1:4310/health
```

```json
{ "status": "ok" }
```

Use `GET /metadata` before assuming capabilities:

```sh
curl http://127.0.0.1:4310/metadata
```

Metadata reports `apiVersion: "experimental-1"`, the PrairieLearn package version, the session
endpoint, available and default render modes, grading, Preview Workspace availability and
controls, the question timeout, worker count, and enabled workspace limits.

## Optional control-plane authentication

Set `PRAIRIELEARN_PREVIEW_AUTH_TOKEN` in the server environment to protect metadata and Local
Preview Session management:

```sh
PRAIRIELEARN_PREVIEW_AUTH_TOKEN='replace-with-a-secret' \
  pnpm --filter @prairielearn/prairielearn preview:server
```

Then send the token as a bearer credential to `/metadata` and `/preview-sessions` operations:

```sh
curl -H 'Authorization: Bearer replace-with-a-secret' \
  http://127.0.0.1:4310/metadata
```

`GET /health` remains public. Browser routes below a Local Preview Session do not receive or
require the bearer token. The opaque Local Preview Session ID is the capability for that
session's browser content and resources, so do not expose it more broadly than the preview itself.
The bearer token is a control-plane credential; it must never be embedded in rendered HTML or
browser requests.

A Local Preview Session is not a hosted Quesal Preview Session and carries no Quesal user
authorization semantics.

## Create, list, reuse, and delete sessions

Create a session for an absolute course directory:

```sh
curl -X POST http://127.0.0.1:4310/preview-sessions \
  -H 'Content-Type: application/json' \
  -d '{"courseDir":"/absolute/path/to/course"}'
```

A successful response has status `201` and includes an opaque session ID plus the canonical course
directory:

```json
{
  "previewSessionId": "pvs_0123456789abcdefghijkl",
  "courseDir": "/canonical/path/to/course"
}
```

List sessions before deliberately reusing one:

```sh
curl http://127.0.0.1:4310/preview-sessions
```

Compare the returned canonical `courseDir` with the course your integration wants. The server does
not merge duplicate course sessions automatically and does not expire idle sessions.

Delete a session when its owner is finished:

```sh
curl -X DELETE \
  http://127.0.0.1:4310/preview-sessions/pvs_0123456789abcdefghijkl
```

The server removes the session from new routing immediately, drains accepted requests, closes its
Preview Workspace connections, and releases owned state before returning `204`.

Control-plane errors use a small JSON envelope with stable codes including `invalid_request`,
`unauthorized`, `invalid_course_dir`, `preview_session_not_found`, and
`capability_unavailable`. They do not include stack traces or PrairieLearn internals.

## Open a question

Question routes are scoped by Local Preview Session:

```text
GET /preview-sessions/<preview-session-id>/questions/<qid>?variant=<seed>&render-mode=<mode>
```

Encode each nested qid segment separately. For example, `topic/nested question` becomes:

```text
/preview-sessions/pvs_0123456789abcdefghijkl/questions/topic/nested%20question?variant=1
```

The variant defaults to seed `1`. Supplying the same seed regenerates the same deterministic
variant. Refresh reads current `info.json`, question templates, and executable question files, so
normal source edits do not require a server restart.

The server supports every Source Question Type:

- `v3` through PrairieLearn's Freeform pipeline.
- `Calculation`, `MultipleChoice`, `Checkbox`, `File`, and `MultipleTrueFalse` through the native
  legacy Calculation pipeline.

Course-specific legacy browser files and type-default files are supported through bounded,
traversal-safe resolution.

## Render modes and Preview Answer Check

`question-only` is the default. It renders the question body for embedding and does not show the
PrairieLearn card, title, grading button, answer panel, or submission panel. `POST` is unavailable
in this mode.

Start with full mode when the authoring experience needs Preview Answer Check:

```sh
pnpm --filter @prairielearn/prairielearn preview:server -- --render-mode full
```

A full server can narrow one request with `?render-mode=question-only`. A question-only server
cannot be upgraded by requesting `?render-mode=full`; the launch mode is a hard capability cap.

Preview Answer Check uses each Source Question Type's native browser contract:

- Freeform questions submit the ordinary form fields emitted by the page.
- Legacy questions submit the `postData` envelope emitted by the native legacy client. The server
  consumes only the submitted answer and regenerates authoritative variant state from the URL
  seed.

Answer checking is available only for internally graded questions in effective full mode.
External and Manual grading are unavailable. Checking is stateless: the server creates no saved
answers, submission history, assessment state, or gradebook state. Generated and submitted files
remain available only in bounded memory under the owning Local Preview Session.

## Resource URLs

PrairieLearn-owned immutable public assets remain global at their normal paths, including
`/assets/...` and required legacy Calculation modules under `/localscripts/calculationQuestion/...`.

Course assets, question assets, declared legacy browser files, generated files, submission files,
and Preview Workspace resources are emitted below the owning session:

```text
/preview-sessions/<id>/preview-render/clientFilesCourse/...
/preview-sessions/<id>/preview-render/questions/<qid>/files/...
/preview-sessions/<id>/preview-render/generatedFilesQuestion/variant/...
/preview-sessions/<id>/preview-render/question/.../submission/.../file/...
/preview-sessions/<id>/workspace/...
```

Rendered HTML already contains the correct scoped URLs. Integrations should proxy them unchanged
instead of rewriting completed HTML. Malformed encodings, encoded separators, dot segments, NULs,
backslashes, traversal, and symlink escapes are rejected before file lookup.

## Optional Preview Workspaces

Preview Workspaces are disabled by default, so ordinary preview does not require Docker. Enable
them explicitly:

```sh
pnpm --filter @prairielearn/prairielearn preview:server -- --workspaces
```

A workspace question emits its session-scoped workspace ID and URLs. Integrations do not create
workspace IDs themselves. A workspace belongs to one Local Preview Session and question/variant
pair; reopening the same pair reuses its files. Reboot and idle stop preserve files, while reset
regenerates them.

The running-container maximum is shared across all sessions. When capacity is needed, the globally
least recently active running workspace is stopped while its files remain. HTTP traffic and
heartbeats update the same activity clock.

Available workspace flags are:

- `--workspace-idle-timeout-ms <milliseconds>`
- `--workspace-max-containers <count>`
- `--workspace-pull-policy missing|always|never`
- `--workspace-start-timeout-ms <milliseconds>`
- `--workspace-home-dir <absolute-or-relative-path>`
- `--workspace-home-volume <named-volume>`
- `--workspace-network <docker-network>`

When the server itself runs in a container, use `--workspace-home-volume` so worker containers can
mount session-namespaced home subpaths, and attach the server and workspaces to the same
`--workspace-network`. Docker failure affects only a requested Preview Workspace; ordinary
question rendering remains available.

## Question-code workers and trust

The server owns one process-wide PrairieLearn engine and worker pool. `--workers-count` sets the
server-wide question-code concurrency limit.

The default `--workers-execution-mode container` runs executable question code in question-worker
containers and requires Docker. Use `--workers-execution-mode native` for local convenience when
Docker isolation is not wanted or available.

Both modes execute course and question code. Only preview courses you trust. Native mode runs that
code directly as your operating-system user. Container mode provides stronger filesystem and
process isolation, but it is not a trust boundary for unrestricted network access.

## Removed proof-of-concept behavior

The following unscoped routes are unavailable and return `404`:

- `/questions/*`
- `/preview-render/*`
- `/workspace/*`
- `/api/questions`

Use only routes below `/preview-sessions/<id>` for session-owned browser content.

The removed `--cache-type`, `--dev-mode`, and `--no-workspaces` options are rejected, as are unknown
flags, positional arguments, missing values, and invalid option values. Preview Workspaces now use
the positive, explicit `--workspaces` flag.
