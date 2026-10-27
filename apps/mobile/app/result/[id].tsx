import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { BigButton } from '../../src/components/BigButton';
import { ConflictRow } from '../../src/components/ConflictRow';
import { DemoBanner } from '../../src/components/DemoBanner';
import { Body, Heading, Notice, Screen } from '../../src/components/Screen';
import { SpeechControls } from '../../src/components/SpeechControls';
import { StatusBadge, statusAnnouncement } from '../../src/components/StatusBadge';
import { useResult } from '../../src/state/results';
import { useSettings } from '../../src/state/settings';
import { useTheme } from '../../src/theme/theme';
import { statusKeyFor } from '../../src/ui/text';

type ResultRoute = '/result/[id]/fields' | '/result/[id]/sources' | '/result/[id]/ask';

/** Results: status badge, the server's summary verbatim, conflicts, safety notices and speech. */
export default function ResultScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { result, error } = useResult(id);
  const settings = useSettings();
  const router = useRouter();
  const focused = useIsFocused();
  const theme = useTheme();

  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (result === undefined || announced.current === result.id) return;
    announced.current = result.id;
    AccessibilityInfo.announceForAccessibility(
      statusAnnouncement(statusKeyFor(result), result.match.advisories.length > 0),
    );
  }, [result]);

  if (result === undefined) {
    return (
      <Screen title="Result">
        {error === null ? <Body>Loading result…</Body> : <Notice>{error}</Notice>}
      </Screen>
    );
  }

  const go = (pathname: ResultRoute) => router.push({ pathname, params: { id: result.id } });
  const { explanation, match } = result;

  return (
    <Screen title="Result">
      {result.isDemo ? <DemoBanner /> : null}
      <StatusBadge status={statusKeyFor(result)} hasAdvisory={match.advisories.length > 0} />
      <Body>{explanation.displayText}</Body>

      {match.conflicting.length > 0 ? (
        <View style={styles.group}>
          <Heading>Differences from the registry</Heading>
          {match.conflicting.map((c) => (
            <ConflictRow key={`${c.key}:${c.labelValue}:${c.referenceValue}`} conflict={c} />
          ))}
        </View>
      ) : null}

      {explanation.safetyNotices.length > 0 ? (
        <View style={[styles.group, styles.notices, { borderColor: theme.colors.border }]}>
          <Heading>Safety notes</Heading>
          {explanation.safetyNotices.map((notice) => (
            <Body key={notice}>{notice}</Body>
          ))}
        </View>
      ) : null}

      <SpeechControls
        chunks={explanation.spokenChunks}
        autoPlay={settings.loaded && settings.autoSpeak}
        active={focused}
      />

      <BigButton
        label="Label fields"
        accessibilityHint="Shows each field read from the label and how clear it was"
        onPress={() => go('/result/[id]/fields')}
      />
      <BigButton
        label="Verification and sources"
        accessibilityHint="Shows the registry records this label was compared with"
        onPress={() => go('/result/[id]/sources')}
      />
      <BigButton
        label="Ask a question"
        accessibilityHint="Ask about what is printed on this label"
        onPress={() => go('/result/[id]/ask')}
      />
      <BigButton
        label="Safety and limitations"
        variant="secondary"
        onPress={() => router.push('/safety')}
      />
      <BigButton label="Back to home" variant="secondary" onPress={() => router.dismissTo('/')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  notices: { borderWidth: 2, borderRadius: 10, padding: 12 },
});
