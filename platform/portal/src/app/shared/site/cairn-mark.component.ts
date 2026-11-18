import { Component } from '@angular/core';

/**
 * The Cairn mark ("Capstone"): three stacked stones, the top one in the
 * accent. The stones use currentColor, so the mark takes the text colour of
 * wherever it sits. This is the one copy of the shape for the public site;
 * size it with font-size or width on the host element.
 */
@Component({
  selector: 'app-cairn-mark',
  standalone: true,
  template: `<svg class="cm" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path class="cm-stone" d="M5.4 28H26.6A2.4 2.4 0 0 0 29 25.6V24.4A9 4.4 0 0 0 20 20H12A9 4.4 0 0 0 3 24.4V25.6A2.4 2.4 0 0 0 5.4 28Z"/><path class="cm-stone cm-mid" d="M8.8 18H22.2A1.8 1.8 0 0 0 24 16.2V15.4A6.5 3.4 0 0 0 17.5 12H13.5A6.5 3.4 0 0 0 7 15.4V16.2A1.8 1.8 0 0 0 8.8 18Z"/><path class="cm-cap" d="M14.4 10H21.6A1.4 1.4 0 0 0 23 8.6V8A4.2 3 0 0 0 18.8 5H17.2A4.2 3 0 0 0 13 8V8.6A1.4 1.4 0 0 0 14.4 10Z"/></svg>`,
  styles: [`
    :host { display: inline-block; width: 1em; height: 1em; line-height: 0; }
    .cm { display: block; width: 100%; height: 100%; overflow: visible; }
    .cm-stone { fill: currentColor; }
    .cm-cap { fill: rgb(var(--accent)); }
  `],
})
export class CairnMarkComponent {}
