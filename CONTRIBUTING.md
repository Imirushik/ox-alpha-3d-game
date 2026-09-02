# Contributing

Thanks for taking the time to improve Sunrise Descent.

## Local setup

1. Install Node.js 20.19 or newer (or Node.js 22.12 or newer).
2. Install dependencies with `npm ci`.
3. Start the development server with `npm run dev`.

## Before opening a pull request

Run the full local validation command:

```bash
npm run check
```

Keep changes focused, explain player-visible behavior, and include screenshots or
a short recording for visual changes. Do not commit generated files from
`dist/`, `captures/`, or local environment files.

## Reporting bugs

Use the bug-report issue form and include:

- browser and operating system;
- steps to reproduce the problem;
- expected and actual behavior; and
- a screenshot or recording when it helps explain the issue.
