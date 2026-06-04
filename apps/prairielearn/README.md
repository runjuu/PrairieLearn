# PrairieLearn frontend and backend

More information about developing and contributing to PrairieLearn can be found on the docs in the [developer guide](https://docs.prairielearn.com/dev-guide/).

Key directories:

- [`elements`](./elements/): Contains the custom `pl-*` elements used in PrairieLearn ([element documentation](https://docs.prairielearn.com/elements/)). Information on creating custom elements can be found on the [element developer guide](https://docs.prairielearn.com/devElements/).
- [`src/pages`](./src/pages/): Contains the individual pages of the PrairieLearn application. The mapping of URLs to pages is defined in [`server.ts`](./src/server.ts).

## Local preview server

The supported local Question-Panel Preview workflow is the PrairieLearn-owned HTTP server:

```sh
yarn workspace @prairielearn/prairielearn build
yarn workspace @prairielearn/prairielearn preview:server -- --course-dir /absolute/path/to/course
```

Open direct preview URLs such as `http://127.0.0.1:4310/questions/<qid>?variant=1`,
where `<qid>` is relative to the course `questions/` directory. Edit local course files and refresh
the browser to render the current files.

The standalone local server is unsandboxed in v1. Rendering may execute question `server.py` under
the developer account, and question code has the developer account's normal outbound network access.
This is distinct from production Quesal preview: the local server does not implement Quesal
authorization, Source Course Reference resolution, Temporary Preview Course materialization,
Sandboxed Preview Worker policy, or Preview Shell policy.
