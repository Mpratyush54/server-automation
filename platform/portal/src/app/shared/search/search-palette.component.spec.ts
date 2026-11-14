import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SearchPaletteComponent } from './search-palette.component';
import { SearchGroup, SearchItem, SearchService } from '../../services/search.service';

describe('SearchPaletteComponent', () => {
  const a: SearchItem = { id: 'a', group: 'projects', label: 'Shop', route: '/projects/1' };
  const b: SearchItem = { id: 'b', group: 'pages', label: 'Alerts', hint: 'Monitor', route: '/alerting' };
  const c: SearchItem = { id: 'c', group: 'actions', label: 'Sign out', action: 'sign-out' };
  let groups: SearchGroup[];
  let search: { isOpen: ReturnType<typeof signal<boolean>>; search: jasmine.Spy; select: jasmine.Spy; close: jasmine.Spy };

  beforeEach(() => {
    groups = [
      { id: 'projects', label: 'Projects', items: [a] },
      { id: 'pages', label: 'Pages', items: [b] },
      { id: 'actions', label: 'Actions', items: [c] },
    ];
    search = {
      isOpen: signal(true),
      search: jasmine.createSpy('search').and.callFake((q: string) => (q === 'none' ? [] : groups)),
      select: jasmine.createSpy('select'),
      close: jasmine.createSpy('close'),
    };
    TestBed.configureTestingModule({
      imports: [SearchPaletteComponent],
      providers: [{ provide: SearchService, useValue: search }],
    });
  });

  function create() {
    const fixture = TestBed.createComponent(SearchPaletteComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('[data-testid="search-input"]') as HTMLInputElement;
    const key = (k: string) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      fixture.detectChanges();
    };
    return { fixture, el, input, key };
  }

  it('is an accessible modal combobox with grouped options', () => {
    const { el, input } = create();
    const dialog = el.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe('sp-listbox');
    expect(el.querySelector('#sp-listbox')!.getAttribute('role')).toBe('listbox');
    expect(Array.from(el.querySelectorAll('.sp-group-label')).map((g) => g.textContent?.trim())).toEqual(['Projects', 'Pages', 'Actions']);
    expect(el.querySelectorAll('[role="option"]').length).toBe(3);
    expect(input.getAttribute('aria-activedescendant')).toBe('sp-opt-0');
    expect(document.activeElement).toBe(input);
  });

  it('moves with arrow keys across groups, wraps, and opens with Enter', () => {
    const { el, input, key } = create();
    key('ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('sp-opt-1');
    expect(el.querySelector('#sp-opt-1')!.getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    key('ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('sp-opt-0');
    key('ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe('sp-opt-2');
    key('Enter');
    expect(search.select).toHaveBeenCalledWith(c);
  });

  it('closes on Escape and keeps Tab inside the dialog', () => {
    const { key, input } = create();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBeTrue();
    key('Escape');
    expect(search.close).toHaveBeenCalled();
  });

  it('opens an entry on click and closes on backdrop click', () => {
    const { el } = create();
    (el.querySelectorAll('[role="option"]')[1] as HTMLElement).click();
    expect(search.select).toHaveBeenCalledWith(b);
    (el.querySelector('[data-testid="search-backdrop"]') as HTMLElement).click();
    expect(search.close).toHaveBeenCalled();
  });

  it('re-searches on input, resets the active entry, and explains an empty result', () => {
    const { el, input, key, fixture } = create();
    key('ArrowDown');
    input.value = 'none';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(search.search).toHaveBeenCalledWith('none');
    expect(el.querySelectorAll('[role="option"]').length).toBe(0);
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    expect(el.querySelector('.sp-empty')!.textContent).toContain('Nothing matches');
    key('Enter');
    expect(search.select).not.toHaveBeenCalled();
  });

  it('returns focus to the element that opened it', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { fixture } = create();
    fixture.destroy();
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
