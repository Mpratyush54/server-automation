# captureConsole

Patches the global `console.log`, `console.warn`, `console.error`, and `console.debug` functions so every call is also forwarded to the Platform logger.

---

## Import

```typescript
import { captureConsole } from '@mpratyush54/sdk-node';
```

Or via the client instance:

```typescript
client.captureConsole();
```

---

## Signature

```typescript
captureConsole(logger: LoggerClient): void

// Client method (returns this for chaining):
client.captureConsole(): this
```

---

## Behaviour

| Console method | Platform log level |
|---|---|
| `console.log` | `INFO` |
| `console.warn` | `WARN` |
| `console.error` | `ERROR` |
| `console.debug` | `DEBUG` |

Arguments are serialised:

- **Strings** are passed as-is.
- **Objects** are JSON-stringified.
- **Error instances** are formatted as `message\nstack`.

The original console functions are preserved and called first, so terminal output is unaffected.

---

## Full Example

```typescript
import { PlatformClient } from '@mpratyush54/sdk-node';

const client = new PlatformClient();

async function main() {
  await client.init({
    projectName: 'my-service',
    platformUrl: 'https://platform.example.com',
  });

  // After this point all console output is also sent to Platform
  client.captureConsole();

  console.log('Application started');        // → Platform log (INFO)
  console.warn('Deprecated API called');     // → Platform log (WARN)
  console.error(new Error('DB timeout'));    // → Platform log (ERROR)

  // Later — optional cleanup (stops logger flush too)
  await client.shutdown();
}

main();
```

---

## Notes

- There is no built-in `restore()` at the module level. To restore original behaviour, call `client.shutdown()` which stops the logger flush, or re-assign the original functions from a saved reference.
- The patching is global — it affects the entire Node.js process.
