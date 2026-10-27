import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { BigButton } from '../src/components/BigButton';
import { Body, Heading, Screen } from '../src/components/Screen';
import { SpeechControls } from '../src/components/SpeechControls';
import { acknowledgeDisclaimer, isDisclaimerAcknowledged } from '../src/state/disclaimer';
import { useSettings } from '../src/state/settings';
import { DISCLAIMER_SENTENCES } from '../src/ui/text';

/** Welcome: the first-run disclaimer until acknowledged, then the home menu. */
export default function Index() {
  const [acknowledged, setAcknowledged] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void isDisclaimerAcknowledged().then((value) => {
      if (active) setAcknowledged(value);
    });
    return () => {
      active = false;
    };
  }, []);

  if (acknowledged === null) {
    return (
      <Screen title="MediLens AI">
        <Body>Loading…</Body>
      </Screen>
    );
  }
  if (!acknowledged) {
    return (
      <Welcome
        onAcknowledge={() => {
          setAcknowledged(true);
          void acknowledgeDisclaimer();
          AccessibilityInfo.announceForAccessibility('Home');
        }}
      />
    );
  }
  return <Home />;
}

function Welcome({ onAcknowledge }: { onAcknowledge(): void }) {
  const settings = useSettings();
  return (
    <Screen title="Welcome">
      <Heading>Welcome to MediLens AI</Heading>
      {DISCLAIMER_SENTENCES.map((sentence) => (
        <Body key={sentence}>{sentence}</Body>
      ))}
      <SpeechControls
        chunks={[...DISCLAIMER_SENTENCES]}
        autoPlay={settings.loaded && settings.autoSpeak}
      />
      <BigButton
        label="I understand"
        accessibilityHint="Confirms you have read this notice and opens the home screen"
        onPress={onAcknowledge}
      />
    </Screen>
  );
}

function Home() {
  const router = useRouter();
  return (
    <Screen title="MediLens AI">
      <Heading>MediLens AI</Heading>
      <Body>Reads medicine labels aloud. Always confirm with a pharmacist or doctor.</Body>
      <BigButton
        label="Scan medicine"
        accessibilityHint="Opens the camera to photograph a medicine label"
        onPress={() => router.push('/scan')}
      />
      <BigButton
        label="Demo mode"
        accessibilityHint="Opens example scenarios with made-up data"
        onPress={() => router.push('/demo')}
      />
      <BigButton
        label="Safety and limitations"
        variant="secondary"
        onPress={() => router.push('/safety')}
      />
      <BigButton label="Settings" variant="secondary" onPress={() => router.push('/settings')} />
    </Screen>
  );
}
