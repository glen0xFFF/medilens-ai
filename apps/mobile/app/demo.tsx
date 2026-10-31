import type { AnalysisEvent, DemoScenarioSummary } from '@medilens/contracts';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useApi } from '../src/api/ApiContext';
import { ApiError } from '../src/api/client';
import { BigButton } from '../src/components/BigButton';
import { DemoBanner } from '../src/components/DemoBanner';
import { Body, Notice, Screen } from '../src/components/Screen';
import { useResults } from '../src/state/results';
import { isTerminalStage, messageFor } from '../src/ui/text';

/**
 * Demo scenario picker: the server's fixture scenarios, titles shown
 * verbatim. A scenario runs through the server pipeline, so its progress
 * stages are real; they are shown and announced as they arrive.
 */
export default function Demo() {
  const client = useApi();
  const router = useRouter();
  const { saveResult } = useResults();
  const [scenarios, setScenarios] = useState<DemoScenarioSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  // The scenario in flight; leaving this screen stops it.
  const running = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    client.scenarios().then(
      (list) => {
        if (active) setScenarios(list);
      },
      (e: unknown) => {
        if (active) setError(messageFor(e));
      },
    );
    return () => {
      active = false;
      running.current?.abort();
      running.current = null;
    };
  }, [client]);

  async function open(scenario: DemoScenarioSummary) {
    if (running.current !== null) return;
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    setError(null);
    setStage(null);
    AccessibilityInfo.announceForAccessibility('Loading demo scenario');
    const onStage = (event: AnalysisEvent) => {
      if (controller.signal.aborted || isTerminalStage(event.stage)) return;
      setStage(event.label);
      AccessibilityInfo.announceForAccessibility(event.label);
    };
    try {
      const result = await client.scenario(scenario.id, { signal: controller.signal, onStage });
      if (controller.signal.aborted) return;
      saveResult(result, scenario.presetQuestion);
      router.push({ pathname: '/result/[id]', params: { id: result.id } });
    } catch (e) {
      if (controller.signal.aborted || (e instanceof ApiError && e.code === 'CANCELLED')) return;
      const message = messageFor(e);
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      if (running.current === controller) {
        running.current = null;
        setBusy(false);
        setStage(null);
      }
    }
  }

  return (
    <Screen title="Demo mode">
      <DemoBanner />
      <Body>Pick an example to hear how MediLens AI reads a label.</Body>
      {error === null ? null : <Notice>{error}</Notice>}
      {stage === null ? null : <Body accessibilityLiveRegion="polite">{stage}</Body>}
      {scenarios === null && error === null ? <Body muted>Loading scenarios…</Body> : null}
      {scenarios?.map((s) => (
        <BigButton
          key={s.id}
          label={s.title}
          disabled={busy}
          variant="secondary"
          onPress={() => void open(s)}
        />
      ))}
    </Screen>
  );
}
