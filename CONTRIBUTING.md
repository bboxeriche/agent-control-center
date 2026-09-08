# Contributing

Agent Control Center requires Node.js `>=22.5`.

```bash
git clone https://github.com/bboxeriche/agent-control-center.git
cd agent-control-center
npm install
npm run check
npm test
```

Pull requests must pass the check and test suite. Provider-specific changes must preserve explicit `unavailable` and `limited` capability reporting; they must not present an unsupported provider boundary as supported. Security-sensitive changes should remain fail-closed when a boundary cannot be verified.

Tests must use fixtures or disposable local resources. They must not require real provider credentials, private repositories, production data, or a developer's local auth token.

