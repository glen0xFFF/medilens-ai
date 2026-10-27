import type { DemoScenarioSummary } from '@medilens/contracts';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useApi } from '../src/api/ApiContext';
import { BigButton } from '../src/components/BigButton';
import { DemoBanner } from '../src/components/DemoBanner';
import { Body, Notice, Screen } from '../src/components/Screen';
import { useResults } from '../src/state/results';
import { messageFor } from '../src/ui/text';

/** Demo scenario picker: the server's fixture scenarios, titles shown verbatim. */
export default function Demo() {
  const client = useApi();
  const router = useRouter();
  const { saveResult } = useResults();
  const [scenarios, setScenarios] = useState<DemoScenarioSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    };
  }, [client]);

  async function open(scenario: DemoScenarioSummary) {
    setBusy(true);
    setError(null);
    AccessibilityInfo.announceForAccessibility('Loading demo scenario');
    try {
      const result = await client.scenario(scenario.id);
      saveResult(result, scenario.presetQuestion);
      router.push({ pathname: '/result/[id]', params: { id: result.id } });
    } catch (e) {
      const message = messageFor(e);
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Demo mode">
      <DemoBanner />
      <Body>Pick an example to hear how MediLens AI reads a label.</Body>
      {error === null ? null : <Notice>{error}</Notice>}
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
