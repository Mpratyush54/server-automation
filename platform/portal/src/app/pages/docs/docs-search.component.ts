import { CommonModule, DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  OnDestroy,
  Output,
  ViewChild,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  DocsSearchIndex,
  DocsSearchResult,
  PreparedSearchEntries,
  highlightSearchText,
  prepareSearchEntries,
  searchDocs,
} from './docs-search';

@Component({
  selector: 'app-docs-search',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './docs-search.component.html',
  styleUrl: './docs-search.component.css',
})
export class DocsSearchComponent implements OnDestroy {
  @Output() resultSelected = new EventEmitter<void>();
  @ViewChild('searchInput') private input?: ElementRef<HTMLInputElement>;
  @ViewChild('dialog') private dialog?: ElementRef<HTMLElement>;
  private document = inject(DOCUMENT);
  private http = inject(HttpClient);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private entries?: PreparedSearchEntries;
  private request?: Subscription;
  private previousFocus?: HTMLElement;
  private previousOverflow = '';
  isOpen = false;
  loading = false;
  error = false;
  query = '';
  results: DocsSearchResult[] = [];
  activeIndex = 0;
  documentCount = 0;
  readonly suggestions = [
    'Installation',
    'Deploy an app',
    'Secrets',
    'MCP',
    'WRONGPASS',
  ];
  readonly highlight = highlightSearchText;

  openSearch(): void {
    if (!this.isOpen) {
      this.previousFocus = this.document.activeElement as HTMLElement;
      this.previousOverflow = this.document.body.style.overflow;
      this.document.body.style.overflow = 'hidden';
      this.isOpen = true;
    }
    this.cdr.detectChanges();
    this.input?.nativeElement.focus();
    this.input?.nativeElement.select();
    if (!this.entries && !this.loading) this.loadIndex();
  }
  closeSearch(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.document.body.style.overflow = this.previousOverflow;
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
  loadIndex(): void {
    this.loading = true;
    this.error = false;
    this.request = this.http
      .get<DocsSearchIndex>('/docs-search.json')
      .subscribe({
        next: (index) => {
          if (index.version !== 1 || !Array.isArray(index.entries)) {
            this.loading = false;
            this.error = true;
            return;
          }
          this.entries = prepareSearchEntries(index.entries);
          this.documentCount = index.documents;
          this.loading = false;
          this.updateQuery(this.query);
        },
        error: () => {
          this.loading = false;
          this.error = true;
        },
      });
  }
  updateQuery(query: string): void {
    this.query = query;
    this.activeIndex = 0;
    this.results = this.entries ? searchDocs(this.entries, query) : [];
  }
  chooseSuggestion(query: string): void {
    this.updateQuery(query);
    this.input?.nativeElement.focus();
  }
  openResult(event: MouseEvent, result: DocsSearchResult): void {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    this.navigate(result);
  }
  private navigate(result: DocsSearchResult): void {
    this.closeSearch();
    this.resultSelected.emit();
    this.router.navigateByUrl(result.url);
  }
  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    const editing = target?.closest(
      'input, textarea, select, [contenteditable="true"]',
    );
    if (
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') ||
      (!this.isOpen &&
        event.key === '/' &&
        !editing &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey)
    ) {
      event.preventDefault();
      this.openSearch();
      return;
    }
    if (!this.isOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeSearch();
      return;
    }
    if (
      (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
      this.results.length
    ) {
      event.preventDefault();
      this.activeIndex =
        (this.activeIndex +
          (event.key === 'ArrowDown' ? 1 : -1) +
          this.results.length) %
        this.results.length;
      this.document
        .getElementById('docs-search-result-' + this.activeIndex)
        ?.scrollIntoView({ block: 'nearest' });
    }
    if (
      event.key === 'Enter' &&
      target === this.input?.nativeElement &&
      this.results[this.activeIndex]
    ) {
      event.preventDefault();
      this.navigate(this.results[this.activeIndex]);
    }
    if (event.key === 'Tab') {
      const focusable =
        this.dialog?.nativeElement.querySelectorAll<HTMLElement>(
          'input, button, a[href]',
        );
      if (!focusable?.length) return;
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && target === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && target === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  ngOnDestroy(): void {
    this.request?.unsubscribe();
    this.closeSearch();
  }
}
