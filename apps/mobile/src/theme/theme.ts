/**
 * Colours and type scale (spec §4.4, §5.4 rule 11). Status is always carried
 * by an icon and a text label as well as colour. The high-contrast palette
 * keeps every foreground/background pair at 7:1 or better (WCAG AAA); the
 * light and dark palettes keep 4.5:1 (AA). theme.test.ts computes each ratio.
 */
import type { MatchStatus } from '@medilens/contracts';
import { useColorScheme } from 'react-native';
import { useSettings, type TextScale } from '../state/settings';

export type StatusKey = MatchStatus | 'unreadable';

export const STATUS_KEYS: readonly StatusKey[] = [
  'verified',
  'partial',
  'conflicting',
  'ambiguous',
  'no_match',
  'unavailable',
  'not_attempted',
  'unreadable',
];

export interface StatusStyle {
  bg: string;
  fg: string;
  /** Ionicons glyph name. */
  icon: string;
  /** Short status label shown and announced with the badge. */
  label: string;
}

export interface Palette {
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
  primary: string;
  onPrimary: string;
  link: string;
  danger: string;
  demoBanner: string;
  onDemoBanner: string;
}

export interface Theme {
  scheme: 'light' | 'dark';
  highContrast: boolean;
  colors: Palette;
  statusColors: Record<StatusKey, StatusStyle>;
  /** The amber "FDA advisory" marker shown beside any status when advisories exist. */
  advisory: StatusStyle;
  textScale: TextScale;
  /** A base font size scaled by the user's text size setting. */
  font(size: number): number;
}

const STATUS_TEXT: Record<StatusKey, { icon: string; label: string }> = {
  verified: { icon: 'checkmark-circle', label: 'Matches registry' },
  partial: { icon: 'remove-circle', label: 'Partial match' },
  conflicting: { icon: 'warning', label: 'Details conflict' },
  ambiguous: { icon: 'help-circle', label: 'Several possible matches' },
  no_match: { icon: 'search', label: 'No match found' },
  unavailable: { icon: 'cloud-offline', label: 'Registry unavailable' },
  not_attempted: { icon: 'ellipse-outline', label: 'Not checked' },
  unreadable: { icon: 'eye-off', label: 'Label unreadable' },
};

const ADVISORY_TEXT = { icon: 'alert-circle', label: 'FDA advisory' };

type StatusColours = Record<StatusKey, { bg: string; fg: string }>;

interface PaletteSet {
  colors: Palette;
  status: StatusColours;
  advisory: { bg: string; fg: string };
}

const LIGHT: PaletteSet = {
  colors: {
    background: '#FFFFFF',
    surface: '#F4F6F8',
    text: '#111418',
    textMuted: '#4A5560',
    border: '#6B7680',
    primary: '#0B57D0',
    onPrimary: '#FFFFFF',
    link: '#0B57D0',
    danger: '#B3261E',
    demoBanner: '#FFE08A',
    onDemoBanner: '#3D2B00',
  },
  status: {
    verified: { bg: '#E3F4E8', fg: '#0B5D1E' },
    partial: { bg: '#FFF3CD', fg: '#5C4300' },
    conflicting: { bg: '#FDE2E1', fg: '#8E1B14' },
    ambiguous: { bg: '#ECE6F7', fg: '#4A2C82' },
    no_match: { bg: '#ECEFF1', fg: '#37424A' },
    unavailable: { bg: '#E3ECF7', fg: '#1F3A5F' },
    not_attempted: { bg: '#F1F1F1', fg: '#3F3F3F' },
    unreadable: { bg: '#FFE9D6', fg: '#7A3500' },
  },
  advisory: { bg: '#FFD54F', fg: '#3D2B00' },
};

const DARK: PaletteSet = {
  colors: {
    background: '#101418',
    surface: '#1B2127',
    text: '#F1F3F5',
    textMuted: '#B8C2CC',
    border: '#8A949E',
    primary: '#8AB4F8',
    onPrimary: '#0B1B33',
    link: '#8AB4F8',
    danger: '#F2B8B5',
    demoBanner: '#5C4300',
    onDemoBanner: '#FFF3CD',
  },
  status: {
    verified: { bg: '#12341C', fg: '#A8E6B5' },
    partial: { bg: '#3B3000', fg: '#FFE08A' },
    conflicting: { bg: '#4A1210', fg: '#FFB4AB' },
    ambiguous: { bg: '#2E2147', fg: '#D7C8F5' },
    no_match: { bg: '#263038', fg: '#D5DDE3' },
    unavailable: { bg: '#16283F', fg: '#B6D0F2' },
    not_attempted: { bg: '#262626', fg: '#DADADA' },
    unreadable: { bg: '#3F2208', fg: '#FFC896' },
  },
  advisory: { bg: '#FFB300', fg: '#1A1200' },
};

/** Black page, white text, bright status fills with black text. */
const HIGH_CONTRAST: PaletteSet = {
  colors: {
    background: '#000000',
    surface: '#121212',
    text: '#FFFFFF',
    textMuted: '#E6E6E6',
    border: '#FFFFFF',
    primary: '#FFE14D',
    onPrimary: '#000000',
    link: '#8FD3FF',
    danger: '#FF8A80',
    demoBanner: '#FFE14D',
    onDemoBanner: '#000000',
  },
  status: {
    verified: { bg: '#7CF29A', fg: '#000000' },
    partial: { bg: '#FFE14D', fg: '#000000' },
    conflicting: { bg: '#FF9E9E', fg: '#000000' },
    ambiguous: { bg: '#D9C2FF', fg: '#000000' },
    no_match: { bg: '#E0E0E0', fg: '#000000' },
    unavailable: { bg: '#9ED0FF', fg: '#000000' },
    not_attempted: { bg: '#CFCFCF', fg: '#000000' },
    unreadable: { bg: '#FFC08A', fg: '#000000' },
  },
  advisory: { bg: '#FFB300', fg: '#000000' },
};

export function getTheme(
  highContrast: boolean,
  scheme: 'light' | 'dark' = 'light',
  textScale: TextScale = 1,
): Theme {
  const set = highContrast ? HIGH_CONTRAST : scheme === 'dark' ? DARK : LIGHT;
  const statusColors = Object.fromEntries(
    STATUS_KEYS.map((k) => [k, { ...set.status[k], ...STATUS_TEXT[k] }]),
  ) as Record<StatusKey, StatusStyle>;
  return {
    scheme: highContrast ? 'dark' : scheme,
    highContrast,
    colors: set.colors,
    statusColors,
    advisory: { ...set.advisory, ...ADVISORY_TEXT },
    textScale,
    font: (size) => Math.round(size * textScale),
  };
}

export function useTheme(): Theme {
  const { highContrast, textScale } = useSettings();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return getTheme(highContrast, scheme, textScale);
}

function channel(hex: string): number {
  const c = parseInt(hex, 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of #RGB or #RRGGBB. */
export function relativeLuminance(colour: string): number {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour);
  if (!m?.[1]) throw new Error(`Not a hex colour: ${colour}`);
  const hex = m[1].length === 3 ? [...m[1]].map((d) => d + d).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => channel(hex.slice(i, i + 2))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}
