import type { ReferenceRecord } from '@medilens/contracts';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useApi } from '../../../src/api/ApiContext';
import type { References } from '../../../src/api/client';
import { BigButton } from '../../../src/components/BigButton';
import { ConflictRow } from '../../../src/components/ConflictRow';
import { DemoBanner } from '../../../src/components/DemoBanner';
import { Body, Heading, Notice, Screen } from '../../../src/components/Screen';
import { StatusBadge } from '../../../src/components/StatusBadge';
import { useResult } from '../../../src/state/results';
import { useTheme } from '../../../src/theme/theme';
import { fieldList, formatCheckedAt, messageFor, statusKeyFor } from '../../../src/ui/text';

function openUrl(url: string) {
  Linking.openURL(url).catch(() => {
    // Nothing to open it with; the URL is shown as text beside the button.
  });
}

/**
 * Verification and sources: registry candidates, matched and conflicting
 * fields, advisories, limitations and when the registry was checked. The
 * registry's registrationExpiry is the registration certificate's, never the
 * product's, and is labelled that way.
 */
export default function SourcesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { result, error } = useResult(id);
  const client = useApi();
  const [refs, setRefs] = useState<References | null>(null);
  const [refsError, setRefsError] = useState<string | null>(null);

  useEffect(() => {
    if (id === undefined) return;
    let active = true;
    client.references(id).then(
      (r) => {
        if (active) setRefs(r);
      },
      (e: unknown) => {
        if (active) setRefsError(messageFor(e));
      },
    );
    return () => {
      active = false;
    };
  }, [client, id]);

  if (result === undefined) {
    return (
      <Screen title="Verification and sources">
        {error === null ? <Body>Loading result…</Body> : <Notice>{error}</Notice>}
      </Screen>
    );
  }

  const { match } = result;
  // Without the references call, the stored result carries the same registry data minus the check time.
  const candidates = refs?.candidates ?? match.candidates;
  const advisories = refs?.advisories ?? match.advisories;
  const limitations = refs?.limitations ?? match.limitations;
  const checkedAt = refs?.checkedAt ?? null;

  return (
    <Screen title="Verification and sources">
      {result.isDemo ? <DemoBanner /> : null}
      <StatusBadge status={statusKeyFor(result)} hasAdvisory={advisories.length > 0} />
      {refsError === null ? null : <Notice>{refsError}</Notice>}
      {refs === null && refsError === null ? <Body muted>Loading registry details…</Body> : null}
      {refs === null ? null : (
        <Body>
          {checkedAt === null ? 'Checked: not checked' : `Checked: ${formatCheckedAt(checkedAt)}`}
        </Body>
      )}

      {match.matched.length > 0 ? <Body>Matched: {fieldList(match.matched)}</Body> : null}
      {match.missing.length > 0 ? <Body>Not compared: {fieldList(match.missing)}</Body> : null}
      {match.conflicting.map((c) => (
        <ConflictRow key={`${c.key}:${c.labelValue}:${c.referenceValue}`} conflict={c} />
      ))}

      {advisories.length > 0 ? <Heading>FDA advisories</Heading> : null}
      {advisories.map((a) => (
        <View key={a.url} style={styles.group}>
          <Body>{a.title}</Body>
          <Body muted>{a.url}</Body>
          <BigButton
            label={`Open advisory: ${a.title}`}
            variant="secondary"
            onPress={() => openUrl(a.url)}
          />
        </View>
      ))}

      <Heading>Registry records ({candidates.length})</Heading>
      {candidates.length === 0 ? <Body>No registry records to show.</Body> : null}
      {candidates.map((c) => (
        <Candidate key={`${c.provider}:${c.registrationNumber}`} record={c} />
      ))}

      {limitations.length > 0 ? <Heading>Limitations</Heading> : null}
      {limitations.map((l) => (
        <Body key={l}>{l}</Body>
      ))}
    </Screen>
  );
}

function Candidate({ record }: { record: ReferenceRecord }) {
  const theme = useTheme();
  const rows: [string, string | null][] = [
    ['Brand name', record.brandName],
    ['Generic name', record.genericName],
    ['Strength and form', record.strengthForm],
    ['Manufacturer', record.manufacturer],
    ['Classification', record.classification],
    ['Registration certificate valid until', record.registrationExpiry],
    ['Source', record.provider],
  ];
  return (
    <View
      style={[
        styles.card,
        { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
      ]}
    >
      <Body>Registration number: {record.registrationNumber}</Body>
      {rows.map(([name, value]) =>
        value === null ? null : <Body key={name}>{`${name}: ${value}`}</Body>,
      )}
      <Body muted>{record.sourceUrl}</Body>
      <BigButton
        label={`Open source page for ${record.registrationNumber}`}
        variant="secondary"
        onPress={() => openUrl(record.sourceUrl)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 6 },
  card: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 6 },
});
