# Angular Build — `NG5002: Incomplete block "xxx"` in template

## Symptom

> Angular build fails with: `NG5002: Incomplete block "xxx"` — pointing to a line in an HTML template that contains the `@` character (e.g., an email address like `admin@dev.io`).

## Root Cause

Angular 19 introduced `@` control flow syntax (`@if`, `@for`, `@switch`, etc.). When Angular's template compiler encounters a bare `@` symbol in the template, it interprets it as the start of a control flow block. An email address such as `admin@dev.io` is parsed as an incomplete `@if` / `@for` block, triggering the `NG5002` error.

## Fix

Replace every bare `@` in HTML templates with the `&#64;` HTML entity.

### Before

```html
<p>Contact us at admin@dev.io</p>
```

### After

```html
<p>Contact us at admin&#64;dev.io</p>
```

### Search all templates for bare `@` occurrences

```bash
rg '@[a-zA-Z0-9]' --include='*.html' src/app/
```

> Look for `@` not followed by Angular control flow keywords (`if`, `for`, `switch`, `defer`, `else`). Also check `@` that is part of an email address.

## Verification

```bash
ng build
```

The build should complete without `NG5002` errors. Verify the rendered page displays the email correctly — the `&#64;` entity will appear as `@` in the browser.
