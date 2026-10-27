/**
 * Test plumbing for screens and components: a jest-mocked ApiClient injected
 * through the app's own providers (never a module-level fetch mock), the real
 * route files under expo-router's in-memory router, and an accessibility
 * sweep over every pressable in the rendered tree.
 */
import { render, type RenderResult } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';
import type { ApiClient } from '../../src/api/client';
import { AppProviders } from '../../src/AppProviders';
import { AppStack } from '../../src/AppStack';
import { PRESETS, SCENARIOS } from './fixtures';

export type MockClient = { [K in keyof ApiClient]: jest.Mock };

function notMocked(name: string) {
  return jest.fn(() => Promise.reject(new Error(`${name} not mocked in this test`)));
}

export function mockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    health: jest.fn(() =>
      Promise.resolve({ status: 'ok', version: '0.1.0', providerMode: 'demo' as const }),
    ),
    analyze: notMocked('analyze'),
    result: notMocked('result'),
    scenario: notMocked('scenario'),
    scenarios: jest.fn(() => Promise.resolve(SCENARIOS)),
    explain: notMocked('explain'),
    references: notMocked('references'),
    presets: jest.fn(() => Promise.resolve(PRESETS)),
    ...overrides,
  };
}

export function Providers({ client, children }: { client: MockClient; children: ReactNode }) {
  return <AppProviders client={client as unknown as ApiClient}>{children}</AppProviders>;
}

/** Renders one component inside the app providers. */
export function renderWithProviders(ui: ReactElement, client: MockClient = mockClient()) {
  return render(<Providers client={client}>{ui}</Providers>);
}

/** The real route files, laid out as expo-router's in-memory context expects. */
export function appRoutes(client: MockClient) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return {
    _layout: () => (
      <Providers client={client}>
        <AppStack />
      </Providers>
    ),
    index: require('../../app/index').default,
    demo: require('../../app/demo').default,
    safety: require('../../app/safety').default,
    settings: require('../../app/settings').default,
    scan: require('../../app/scan').default,
    preview: require('../../app/preview').default,
    analyzing: require('../../app/analyzing').default,
    'result/[id]': require('../../app/result/[id]').default,
    'result/[id]/fields': require('../../app/result/[id]/fields').default,
    'result/[id]/sources': require('../../app/result/[id]/sources').default,
    'result/[id]/ask': require('../../app/result/[id]/ask').default,
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

interface JsonNode {
  type: string;
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
}

function visit(node: JsonNode | JsonNode[] | string | null, out: JsonNode[]) {
  if (node === null || typeof node === 'string') return;
  if (Array.isArray(node)) {
    node.forEach((n) => visit(n, out));
    return;
  }
  const p = node.props;
  if (typeof p.onClick === 'function' || typeof p.onResponderRelease === 'function') out.push(node);
  node.children?.forEach((c) => visit(c, out));
}

/** Every host element that responds to presses, in the visible (not aria-hidden) screens. */
export function pressables(view: Pick<RenderResult, 'toJSON'>): JsonNode[] {
  const out: JsonNode[] = [];
  visit(view.toJSON() as JsonNode | JsonNode[] | null, out);
  return out;
}

export function expectPressablesLabelled(view: Pick<RenderResult, 'toJSON'>) {
  const found = pressables(view);
  expect(found.length).toBeGreaterThan(0);
  for (const node of found) {
    const label = node.props.accessibilityLabel;
    expect({
      role: node.props.accessibilityRole,
      labelled: typeof label === 'string' && label.trim().length > 0,
    }).toEqual({
      role: 'button',
      labelled: true,
    });
  }
}
