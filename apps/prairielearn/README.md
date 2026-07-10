# PrairieLearn frontend and backend

More information about developing and contributing to PrairieLearn can be found in the
[developer guide](https://docs.prairielearn.com/dev-guide/).

Key directories:

- [`elements`](./elements/): PrairieLearn's custom `pl-*` elements. See the
  [element documentation](https://docs.prairielearn.com/elements/) and
  [element developer guide](https://docs.prairielearn.com/devElements/).
- [`src/pages`](./src/pages/): Pages in the full PrairieLearn application. URL mappings are defined
  in [`server.ts`](./src/server.ts).

## Standalone Preview Server

The experimental Standalone Preview Server renders PrairieLearn questions directly from course
files without PostgreSQL or the full PrairieLearn application. It starts with zero or more courses
and exposes the `experimental-1` Local Preview Session HTTP contract.

Build it and start with no initial courses:

```sh
pnpm --filter @prairielearn/prairielearn build
pnpm --filter @prairielearn/prairielearn preview:server
```

To create sessions at startup, repeat `--course-dir`:

```sh
pnpm --filter @prairielearn/prairielearn preview:server -- \
  --course-dir /absolute/path/to/course-a \
  --course-dir /absolute/path/to/course-b
```

The server defaults to question-only rendering, containerized question workers, and disabled
Preview Workspaces. See the
[Standalone Preview Server guide](../../docs/dev-guide/standalonePreviewServer.md) for discovery,
runtime session management, scoped question URLs, Preview Answer Check, security, worker modes,
and optional Preview Workspaces.
