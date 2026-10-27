import { MatchStatusSchema } from '@medilens/contracts';
import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { SettingsProvider } from '../../src/state/settings';
import { STATUS_KEYS, contrastRatio, getTheme, useTheme, type Theme } from '../../src/theme/theme';

/** Every foreground/background pair a screen may draw, named for failure messages. */
function pairs(theme: Theme): [string, string, string][] {
  const c = theme.colors;
  const out: [string, string, string][] = [
    ['text on background', c.text, c.background],
    ['text on surface', c.text, c.surface],
    ['muted text on background', c.textMuted, c.background],
    ['muted text on surface', c.textMuted, c.surface],
    ['primary button text', c.onPrimary, c.primary],
    ['link on background', c.link, c.background],
    ['danger on background', c.danger, c.background],
    ['demo banner', c.onDemoBanner, c.demoBanner],
    ['advisory marker', theme.advisory.fg, theme.advisory.bg],
  ];
  for (const key of STATUS_KEYS) {
    const s = theme.statusColors[key];
    out.push([`status ${key}`, s.fg, s.bg]);
  }
  return out;
}

describe('contrastRatio', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1 AA threshold grey.
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
  });

  it('rejects colours it cannot parse', () => {
    expect(() => contrastRatio('red', '#000000')).toThrow();
  });
});

describe('palettes', () => {
  it('styles every match status plus unreadable', () => {
    expect([...STATUS_KEYS].sort()).toEqual([...MatchStatusSchema.options, 'unreadable'].sort());
  });

  it.each(STATUS_KEYS)('gives %s a text label and an icon, not colour alone', (key) => {
    for (const theme of [getTheme(false, 'light'), getTheme(false, 'dark'), getTheme(true)]) {
      const s = theme.statusColors[key];
      expect(s.label.trim().length).toBeGreaterThan(0);
      expect(s.icon.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses distinct labels per status', () => {
    const labels = STATUS_KEYS.map((k) => getTheme(false, 'light').statusColors[k].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('never says fake or counterfeit in a status label', () => {
    for (const k of STATUS_KEYS) {
      expect(getTheme(true).statusColors[k].label).not.toMatch(/fake|counterfeit/i);
    }
  });

  it.each(pairs(getTheme(true)))('high contrast: %s is at least 7:1', (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ...pairs(getTheme(false, 'light')).map(([n, f, b]) => [`light ${n}`, f, b] as const),
    ...pairs(getTheme(false, 'dark')).map(([n, f, b]) => [`dark ${n}`, f, b] as const),
  ])('normal: %s is at least 4.5:1', (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('labels the FDA advisory marker', () => {
    expect(getTheme(false, 'light').advisory.label).toBe('FDA advisory');
  });
});

describe('useTheme', () => {
  it('follows the high-contrast setting and text scale', async () => {
    const { result } = await renderHook(() => useTheme(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SettingsProvider>{children}</SettingsProvider>
      ),
    });
    expect(result.current.highContrast).toBe(false);
    expect(result.current.textScale).toBe(1);
    expect(result.current.font(16)).toBe(16);
  });

  it('scales type by the text scale', () => {
    expect(getTheme(true, 'light', 1.5).font(16)).toBe(24);
    expect(getTheme(false, 'light', 1.25).font(16)).toBe(20);
  });
});
