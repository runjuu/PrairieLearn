# PrairieLearn frontend and backend

More information about developing and contributing to PrairieLearn can be found on the docs in the [developer guide](https://docs.prairielearn.com/dev-guide/).

Key directories:

- [`elements`](./elements/): Contains the custom `pl-*` elements used in PrairieLearn ([element documentation](https://docs.prairielearn.com/elements/)). Information on creating custom elements can be found on the [element developer guide](https://docs.prairielearn.com/devElements/).
- [`src/pages`](./src/pages/): Contains the individual pages of the PrairieLearn application. The mapping of URLs to pages is defined in [`server.ts`](./src/server.ts).

## Local preview server

To preview question panels locally, start the preview server:

```sh
yarn workspace @prairielearn/prairielearn build
yarn workspace @prairielearn/prairielearn preview:server -- --course-dir /absolute/path/to/course
```

Open direct preview URLs such as `http://127.0.0.1:4310/questions/<qid>`, where `<qid>` is a
relative path under the course `questions/` directory. Edit local course files and refresh the
browser to render the current files.

To preview a specific variant, add a `variant` query parameter, for example
`http://127.0.0.1:4310/questions/<qid>?variant=2`. Use a seed that parses as a base-36 integer
from `0` through `2^32 - 1` (`4294967295`, or `1z141z3` in base 36). If `variant` is omitted, the
preview uses variant seed `1`.

Optional flags:

- `--host`: Bind address. Defaults to `127.0.0.1`.
- `--port`: Bind port. Defaults to `4310`.
- `--cache-type`: Cache backend for render results, one of `none`, `memory`, or `redis`. Defaults
  to `none`. To use `redis`, start Redis and configure `redisUrl`.
- `--dev-mode`: Enables development-mode asset handling, skips eager worker readiness checks, and
  disables some render caching. Defaults to `false`.
- `--render-mode`: Page style for rendered questions, either `full` or `question-only`. Defaults
  to `full`. See [Render modes](#render-modes).
- `--question-timeout-ms`: Question-code worker timeout in milliseconds. Defaults to `5000`.
- `--workers-count`: Maximum number of question-code workers. Defaults to `1`.
- `--workers-execution-mode`: Worker execution mode, either `native` or `container`. Defaults to
  `container`.
- `--no-workspaces`: Disables workspace support. Workspace questions then render with a
  placeholder `#` workspace link instead of a working workspace button.
- `--workspace-home-dir`: Directory for workspace home directories. Defaults to a per-run
  temporary directory that is deleted on shutdown; an explicit directory is kept.
- `--workspace-idle-timeout-ms`: Idle time before a workspace container is stopped. Defaults to
  `1800000` (30 minutes).
- `--workspace-start-timeout-ms`: Maximum time to wait for a workspace container to respond after
  starting. Defaults to `60000`.
- `--workspace-max-containers`: Maximum number of concurrently running workspace containers; the
  least recently used workspace is stopped to make room. Defaults to `3`.
- `--workspace-pull-policy`: When to pull workspace images, one of `missing`, `always`, or
  `never`. Defaults to `missing`.

With the default `container` mode, the local server runs question code inside a Docker container, so
Docker must be installed and running. The container isolates question code from your machine's
filesystem and processes, but does not currently restrict its outbound network access. Pass
`--workers-execution-mode native` to run question code directly on your machine instead, where
question `server.py` runs under your user account with its normal outbound network access.

### Render modes

The server renders one of two page styles, selected at launch with `--render-mode`:

- `full` (default): mirrors the real PrairieLearn question preview page: a question card with the
  question title in the header, a "Save & Grade" button, a "Correct answer" panel (shown after a
  graded submission when the question's `showCorrectAnswer` setting allows it), and a
  submitted-answer panel with score badges and feedback. Grading runs synchronously through the
  production parse/grade pipeline; nothing is persisted, so refreshing the page discards the
  submission.
- `question-only`: just the rendered question body with the assets it needs (element CSS/JS,
  MathJax). No card, no title, no buttons, and grading is disabled: `POST /questions/<qid>`
  responds with `405`. Intended for embedding the question in another UI.

An individual page can be narrowed with the `render-mode` query parameter, for example
`http://127.0.0.1:4310/questions/<qid>?render-mode=question-only`. The launch flag is a hard cap: a
`full` server can serve individual pages as `question-only`, but on a `--render-mode question-only`
server, `?render-mode=full` is rejected with `400` because grading is disabled server-wide. Invalid
values are also rejected with `400`, and a `POST` whose effective mode is `question-only` responds
with `405`.

### Workspaces

Questions with `workspaceOptions` get a working workspace button: the preview server launches the
workspace image as a local Docker container, generates the workspace files (static `workspace/`
files, rendered `workspaceTemplates/`, and dynamic `_workspace_files`), and proxies the workspace
page at `/workspace/<id>` to the container, including websocket traffic. The workspace page shows
launch progress (including image pull progress) and has Reboot (keep files) and Reset (regenerate
files) controls. Workspaces are keyed by question and variant seed, so refreshing the question or
reopening the workspace reuses the same container and files.

When checking answers on an internally graded workspace question, the question's `gradedFiles` are
collected from the local workspace home directory into `_files`, mirroring the full server.

Workspaces require Docker to be reachable; when it is not, the question still renders and the
workspace page reports the failure. Containers are stopped when idle, capped in number, removed on
shutdown (including Ctrl-C), and labeled so that containers orphaned by a crashed server are
removed on the next startup. Note that `enableNetworking: false` is not enforced locally: the
container keeps its normal bridge networking, and only the `WORKSPACE_NETWORKING_DISABLED`
environment variable is set, matching workspace hosts without no-internet network support.

This is distinct from production Quesal preview: the local server does not implement Quesal
authorization, Source Course Reference resolution, Temporary Preview Course materialization,
Sandboxed Preview Worker policy, or Preview Shell policy.
