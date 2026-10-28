import { useLocalSearchParams, useRouter } from 'expo-router';
import { BigButton } from '../../../src/components/BigButton';
import { DemoBanner } from '../../../src/components/DemoBanner';
import { FieldRow } from '../../../src/components/FieldRow';
import { Body, Notice, Screen } from '../../../src/components/Screen';
import { useResult } from '../../../src/state/results';
import { noFieldsMessage } from '../../../src/ui/text';

/** Every field read from the label, with its legibility chip and printed evidence. */
export default function FieldsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { result, error } = useResult(id);
  const router = useRouter();
  const back = (
    <BigButton
      label="Back to result"
      variant="secondary"
      onPress={() =>
        router.canGoBack()
          ? router.back()
          : router.replace({ pathname: '/result/[id]', params: { id: id ?? '' } })
      }
    />
  );

  if (result === undefined) {
    return (
      <Screen title="Label fields">
        {error === null ? <Body>Loading result…</Body> : <Notice>{error}</Notice>}
        {back}
      </Screen>
    );
  }

  // A loose pill, a non-label photo or an unreadable label lists no fields (final review I2).
  const none = noFieldsMessage(result);
  return (
    <Screen title="Label fields">
      {result.isDemo ? <DemoBanner /> : null}
      {none !== null ? (
        <Body>{none}</Body>
      ) : (
        (result.label?.fields ?? []).map((field) => <FieldRow key={field.key} field={field} />)
      )}
      {back}
    </Screen>
  );
}
