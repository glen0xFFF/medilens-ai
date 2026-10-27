import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { AccessibilityInfo, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MAX_IMAGES } from '../src/api/client';
import { useCaptures } from '../src/capture/captures';
import { discardFiles } from '../src/capture/files';
import { usePickPhotos } from '../src/capture/pick';
import { prepareImage } from '../src/capture/prepare';
import { BigButton } from '../src/components/BigButton';
import { DemoModeNotice } from '../src/components/DemoModeNotice';
import { Body, Heading, Notice, Screen } from '../src/components/Screen';
import { useTheme } from '../src/theme/theme';

const UNAVAILABLE =
  'The camera could not be started on this phone. You can read an existing photo instead.';
const CAPTURE_FAILED = 'The photo could not be taken. Please try again.';

function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message);
}

/**
 * Camera: up to 3 photos of different sides of the pack, with a torch.
 * `?retake=<index>` replaces one photo and returns to the preview.
 */
export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  const [unavailable, setUnavailable] = useState(false);

  if (permission === null) {
    return (
      <Screen title="Camera">
        <DemoModeNotice />
        <Body>Checking camera access…</Body>
      </Screen>
    );
  }
  if (!permission.granted && permission.canAskAgain) {
    return (
      <Screen title="Camera">
        <DemoModeNotice />
        <Heading>Camera access</Heading>
        <Body>MediLens AI needs the camera to photograph the medicine label.</Body>
        <BigButton
          label="Allow camera access"
          accessibilityHint="Shows the system request for camera access"
          onPress={() => void requestPermission()}
        />
        <GalleryAndCancel />
      </Screen>
    );
  }
  if (!permission.granted) {
    return (
      <Screen title="Camera">
        <DemoModeNotice />
        <Heading>Camera access is off</Heading>
        <Body>
          Turn on camera access for MediLens AI in your phone settings, or read an existing photo
          instead.
        </Body>
        <BigButton
          label="Open settings"
          accessibilityHint="Opens this app's settings so you can allow the camera"
          onPress={() => void Linking.openSettings()}
        />
        <GalleryAndCancel />
      </Screen>
    );
  }
  if (unavailable) {
    return (
      <Screen title="Camera">
        <DemoModeNotice />
        <Heading>Camera not available</Heading>
        <Body>{UNAVAILABLE}</Body>
        <GalleryAndCancel />
      </Screen>
    );
  }
  return (
    <Capture
      onUnavailable={() => {
        setUnavailable(true);
        announce(UNAVAILABLE);
      }}
    />
  );
}

/** The gallery fallback and a way out, shared by every state of this screen. */
function GalleryAndCancel() {
  const router = useRouter();
  const { remaining, clear } = useCaptures();
  const pickPhotos = usePickPhotos();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function pick() {
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await pickPhotos();
      if (outcome.message !== null) {
        setMessage(outcome.message);
        announce(outcome.message);
      }
      if (outcome.added > 0) router.replace('/preview');
    } catch {
      const text = 'The photo gallery could not be opened. Please try again.';
      setMessage(text);
      announce(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {message === null ? null : <Notice>{message}</Notice>}
      <BigButton
        label="Read existing photo"
        accessibilityHint="Choose a photo of the label from your gallery"
        variant="secondary"
        disabled={busy || remaining === 0}
        onPress={() => void pick()}
      />
      <BigButton
        label="Cancel"
        accessibilityHint="Deletes the photos taken so far and goes back home"
        variant="secondary"
        onPress={() => {
          clear();
          router.dismissTo('/');
        }}
      />
    </>
  );
}

function Capture({ onUnavailable }: { onUnavailable(): void }) {
  const theme = useTheme();
  const router = useRouter();
  const { retake } = useLocalSearchParams<{ retake?: string }>();
  const { images, remaining, add, replace } = useCaptures();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retakeIndex = retake === undefined ? NaN : Number(retake);
  const retaking = Number.isInteger(retakeIndex) && retakeIndex >= 0 && retakeIndex < images.length;
  const canTake = ready && !busy && (retaking || remaining > 0);

  async function take() {
    if (!canTake || camera.current === null) return;
    setBusy(true);
    setError(null);
    try {
      const picture = await camera.current.takePictureAsync({ quality: 0.9 });
      let prepared;
      try {
        prepared = await prepareImage(picture.uri);
      } finally {
        discardFiles([picture.uri]);
      }
      if (retaking) {
        replace(retakeIndex, prepared);
        announce(`Photo ${retakeIndex + 1} retaken.`);
        router.replace('/preview');
        return;
      }
      add(prepared);
      const count = images.length + 1;
      announce(
        count >= MAX_IMAGES
          ? `Photo ${count} of ${MAX_IMAGES} taken. Review photos to continue.`
          : `Photo ${count} of ${MAX_IMAGES} taken.`,
      );
    } catch {
      setError(CAPTURE_FAILED);
      announce(CAPTURE_FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <CameraView
        ref={camera}
        style={styles.camera}
        facing="back"
        enableTorch={torch}
        accessible
        accessibilityLabel="Camera viewfinder"
        onCameraReady={() => setReady(true)}
        onMountError={onUnavailable}
      />
      <ScrollView style={styles.controls} contentContainerStyle={styles.controlsContent}>
        <DemoModeNotice />
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.text, fontSize: theme.font(18), fontWeight: '700' }}
        >
          {retaking
            ? `Retaking photo ${retakeIndex + 1} of ${images.length}`
            : `${images.length} of ${MAX_IMAGES} photos taken`}
        </Text>
        <Body muted>Hold the pack steady and fill the frame with the label.</Body>
        {error === null ? null : <Notice>{error}</Notice>}
        <BigButton
          label="Take photo"
          accessibilityHint={
            retaking ? 'Replaces this photo' : 'Photographs one side of the medicine pack'
          }
          disabled={!canTake}
          onPress={() => void take()}
        />
        <BigButton
          label={torch ? 'Torch: On' : 'Torch: Off'}
          accessibilityHint="Turns the phone light on or off"
          variant="secondary"
          selected={torch}
          onPress={() => setTorch((on) => !on)}
        />
        {images.length > 0 ? (
          <BigButton
            label="Review photos"
            accessibilityHint="Check the photos before the label is read"
            variant={remaining === 0 ? 'primary' : 'secondary'}
            onPress={() => router.replace('/preview')}
          />
        ) : null}
        <GalleryAndCancel />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  camera: { flex: 1, minHeight: 240 },
  controls: { flexGrow: 0, maxHeight: '60%' },
  controlsContent: { padding: 16, gap: 12 },
});
