import { isViewerOnlyMode } from '../viewer-only-mode';

describe('viewer-only mode cutoff', () => {
  it('is inactive before the old June 6, 2026 cutoff', () => {
    expect(isViewerOnlyMode(new Date(2026, 5, 5, 23, 59, 59, 999))).toBe(false);
  });

  it('stays inactive at the old June 6, 2026 cutoff', () => {
    expect(isViewerOnlyMode(new Date(2026, 5, 6, 0, 0, 0, 0))).toBe(false);
  });

  it('stays inactive after the old cutoff', () => {
    expect(isViewerOnlyMode(new Date(2026, 5, 7, 12, 0, 0, 0))).toBe(false);
  });
});
