# Multiplayer E2E Testing

This project includes a 2-user online multiplayer regression test using Playwright.

## 1) Capture auth state once per user

Use two different Google accounts.

```bash
npm run e2e:auth:host
npm run e2e:auth:joiner
```

Each command opens a browser. Sign in on the Online screen, wait for the script to save:

- `tests/.auth/host.json`
- `tests/.auth/joiner.json`

## 2) Run multiplayer regression test

```bash
npm run test:e2e:online
```

The test flow:

1. Host creates a 2-player room
2. Joiner joins via room code
3. Both clients enter game screen
4. Host takes a turn
5. Joiner takes the next turn

If either client cannot act, test fails with logs/artifacts.

## Optional

Run headed for visual troubleshooting:

```bash
npm run test:e2e:headed -- tests/e2e/online-multiplayer.spec.js
```
