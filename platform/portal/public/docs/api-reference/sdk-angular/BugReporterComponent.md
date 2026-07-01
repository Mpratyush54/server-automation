# BugReporterComponent

A standalone Angular component (`<platform-bug-reporter>`) that renders a floating bug-report button and drawer. Captures console logs and browser information on submission.

---

## Import

```typescript
import { BugReporterComponent } from '@mpratyush54/sdk-angular';
```

The component is **standalone** and already included in `PlatformModule` — no additional imports are needed.

---

## Usage

```html
<!-- In any template -->
<platform-bug-reporter></platform-bug-reporter>
```

---

## Behaviour

- Renders a red 🐛 **floating action button** (fixed, `z-index: 99999`, bottom-right).
- Clicking toggles a dark-themed drawer:
  - **Textarea** for the user's description.
  - **Cancel** and **Submit Report** buttons.
- On `ngOnInit`: patches `console.log`, `console.warn`, `console.error` to capture the last **100 console entries**.
- On `ngOnDestroy`: restores the original console methods.
- On submit:
  - POSTs to `POST /api/sdk/bug-report` with:
    - `projectId`, `environment`
    - `description` — user's text
    - `category: 'user-report'`
    - `consoleLogs` — captured console entries with level, message, and timestamp
    - `browserInfo` — `userAgent`, `url`, `viewport`
  - Shows "Bug report submitted. Thank you!" for 2 s on success.
  - Shows `alert('Failed to submit bug report.')` on failure.

---

## Full Example

```typescript
// app.module.ts
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { PlatformModule } from '@mpratyush54/sdk-angular';
import { AppComponent } from './app.component';

@NgModule({
  declarations: [AppComponent],
  imports: [
    BrowserModule,
    HttpClientModule,
    PlatformModule.forRoot({
      apiBase: 'https://platform.example.com',
      token: 'sk-xxxx',
      projectId: 'my-app',
    }),
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
```

```typescript
// app.component.ts
import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    <h1>My Angular App</h1>
    <router-outlet></router-outlet>
    <platform-bug-reporter></platform-bug-reporter>
  `,
})
export class AppComponent {}
```

---

## Error Handling

- Console capturing wraps the original methods; if the capture itself throws, the original console method is still called.
- The submission POST uses fire-and-forget `.subscribe()` with `error:` callback that shows an `alert()`.
