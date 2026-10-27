import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApi } from '../src/api/ApiContext';
import { BigButton } from '../src/components/BigButton';
import { Body, Heading, Screen } from '../src/components/Screen';
import {
  MAX_SPEECH_RATE,
  MIN_SPEECH_RATE,
  useSettings,
  type TextScale,
} from '../src/state/settings';

const RATE_STEP = 0.25;

const TEXT_SIZES: { scale: TextScale; name: string }[] = [
  { scale: 1, name: 'Normal' },
  { scale: 1.25, name: 'Large' },
  { scale: 1.5, name: 'Extra large' },
];

function formatRate(rate: number): string {
  return String(Math.round(rate * 100) / 100);
}

const onOff = (on: boolean) => (on ? 'On' : 'Off');

export default function Settings() {
  const settings = useSettings();
  const client = useApi();
  const [mode, setMode] = useState<string>('checking…');

  useEffect(() => {
    let active = true;
    client.health().then(
      (h) => {
        if (active) setMode(h.providerMode);
      },
      () => {
        if (active) setMode('not reachable');
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <Screen title="Settings">
      <Heading>Speech</Heading>
      <Body accessibilityLiveRegion="polite">Speech rate: {formatRate(settings.speechRate)}</Body>
      <View style={styles.row}>
        <View style={styles.cell}>
          <BigButton
            label="Slower speech"
            variant="secondary"
            disabled={settings.speechRate <= MIN_SPEECH_RATE}
            onPress={() => settings.setSpeechRate(settings.speechRate - RATE_STEP)}
          />
        </View>
        <View style={styles.cell}>
          <BigButton
            label="Faster speech"
            variant="secondary"
            disabled={settings.speechRate >= MAX_SPEECH_RATE}
            onPress={() => settings.setSpeechRate(settings.speechRate + RATE_STEP)}
          />
        </View>
      </View>
      <BigButton
        label={`Read results aloud: ${onOff(settings.autoSpeak)}`}
        accessibilityHint="Turns automatic reading of results on or off"
        variant="secondary"
        selected={settings.autoSpeak}
        onPress={() => settings.setAutoSpeak(!settings.autoSpeak)}
      />

      <Heading>Display</Heading>
      <BigButton
        label={`High contrast: ${onOff(settings.highContrast)}`}
        variant="secondary"
        selected={settings.highContrast}
        onPress={() => settings.setHighContrast(!settings.highContrast)}
      />
      <Body>Text size</Body>
      {TEXT_SIZES.map(({ scale, name }) => (
        <BigButton
          key={name}
          label={name}
          accessibilityLabel={`Text size ${name}`}
          variant="secondary"
          selected={settings.textScale === scale}
          onPress={() => settings.setTextScale(scale)}
        />
      ))}

      <Heading>Privacy</Heading>
      <Body>
        Photos are not stored. They are sent to the MediLens server only to read the label. Results
        are kept in memory while the app is open and are never saved on this phone; the server
        deletes its copy after 15 minutes.
      </Body>
      <Body>Only these settings and whether you have read the welcome notice are saved.</Body>

      <Heading>Server</Heading>
      <Body>Server mode: {mode}</Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  cell: { flexGrow: 1, flexBasis: 140 },
});
