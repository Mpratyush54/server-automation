import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject } from '@angular/core';
import { SearchGroup, SearchItem, SearchService } from '../../services/search.service';

/**
 * Centred command palette (combobox + grouped listbox). Rendered only while open;
 * focus goes to the input on open and back to whatever had it on close.
 */
@Component({
  selector: 'app-search-palette',
  standalone: true,
  templateUrl: './search-palette.component.html',
  styleUrl: './search-palette.component.css',
})
export class SearchPaletteComponent implements AfterViewInit, OnDestroy {
  readonly search = inject(SearchService);
  @ViewChild('input') inputRef?: ElementRef<HTMLInputElement>;

  query = '';
  groups: SearchGroup[] = [];
  /** Flat list of visible items in display order; activeIndex points into it. */
  flat: SearchItem[] = [];
  activeIndex = 0;
  private returnFocus: HTMLElement | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    this.update();
    // Projects and docs load in the background; show them once they arrive.
    this.refreshTimer = setTimeout(() => this.update(false), 400);
  }

  ngAfterViewInit(): void {
    this.inputRef?.nativeElement.focus();
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const el = this.returnFocus;
    if (el && el.isConnected) setTimeout(() => el.focus());
  }

  optionId(item: SearchItem): string {
    return 'sp-opt-' + this.flat.indexOf(item);
  }

  get activeId(): string | null {
    return this.flat.length ? 'sp-opt-' + this.activeIndex : null;
  }

  onInput(value: string): void {
    this.query = value;
    this.update();
  }

  /** Recompute results; resetActive=false keeps the highlighted entry where possible. */
  update(resetActive = true): void {
    const activeId = this.flat[this.activeIndex]?.id;
    this.groups = this.search.search(this.query);
    this.flat = this.groups.flatMap((g) => g.items);
    const kept = resetActive ? -1 : this.flat.findIndex((i) => i.id === activeId);
    this.activeIndex = kept >= 0 ? kept : 0;
  }

  onKeydown(event: KeyboardEvent): void {
    const n = this.flat.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (n) this.activeIndex = (this.activeIndex + 1) % n;
        this.scrollActive();
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (n) this.activeIndex = (this.activeIndex - 1 + n) % n;
        this.scrollActive();
        break;
      case 'Home':
        if (n && !this.query) { event.preventDefault(); this.activeIndex = 0; this.scrollActive(); }
        break;
      case 'End':
        if (n && !this.query) { event.preventDefault(); this.activeIndex = n - 1; this.scrollActive(); }
        break;
      case 'Enter':
        event.preventDefault();
        if (n) this.choose(this.flat[this.activeIndex]);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.search.close();
        break;
      case 'Tab':
        // The input is the only stop inside the dialog; keep focus here.
        event.preventDefault();
        break;
    }
  }

  choose(item: SearchItem): void {
    this.search.select(item);
  }

  private scrollActive(): void {
    const id = this.activeId;
    if (!id || typeof document === 'undefined') return;
    document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' });
  }
}
