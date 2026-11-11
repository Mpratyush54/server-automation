import { TestBed } from '@angular/core/testing';
import { ObsLineChartComponent } from './obs-line-chart.component';

describe('ObsLineChartComponent', () => {
  it('fits the plot width to the rendered width so axis labels keep their size', () => {
    TestBed.configureTestingModule({ imports: [ObsLineChartComponent] });
    const fixture = TestBed.createComponent(ObsLineChartComponent);
    const c = fixture.componentInstance;
    c.series = [{ name: 'rps', points: [[1, 1], [2, 3]] }];
    c.ngOnChanges();
    fixture.detectChanges();
    c.fitWidth(352);
    expect(c.width).toBe(300);
    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('-44 -6 352 164');
    c.fitWidth(100);
    expect(c.width).toBe(160); // floor
    fixture.destroy();
  });
});
