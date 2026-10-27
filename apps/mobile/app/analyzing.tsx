import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Text } from 'react-native';
import { ApiError, type ApiErrorCode } from '../src/api/client';
import { useApi } from '../src/api/ApiContext';
import { useCaptures } from '../src/capture/captures';
import type { PreparedImage } from '../src/capture/prepare';
import { BigButton } from '../src/components/BigButton';
import { Body, Heading, Notice, Screen } from '../src/components/Screen';
import { useResults } from '../src/state/results';
import { useTheme } from '../src/theme/theme';
import { LIVE_MODE_PHOTOS, analyzeErrorMessage } from '../src/ui/text';

/** How often a long upload re-announces that it is still working. */
export const STILL_WORKING_MS = 15_000;
const STILL_WORKING = 'Still reading the label. Please wait.';

function startMessage(count: number) {
  return `Sending ${count} ${count === 1 ? 'photo' : 'photos'} and reading the label. This can take up to a minute.`;
}

function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message);
}

/** Analysis progress: uploads the held photos once per attempt and announces progress. */
export default function Analyzing() {
  const theme = useTheme();
  const router = useRouter();
  const client = useApi();
  const { saveResult } = useResults();
  const { images, clear } = useCaptures();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ code: ApiErrorCode | null; message: string } | null>(
    null,
  );

  // Latest values for the upload effect, which runs once per attempt only.
  const latest = useRef({ images, clear, saveResult });
  latest.current = { images, clear, saveResult };
  const mounted = useRef(true);
  const started = useRef(-1);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, []);

  useEffect(() => {
    const photos: readonly PreparedImage[] = latest.current.images;
    if (started.current === attempt || photos.length === 0) return;
    started.current = attempt;

    const first = startMessage(photos.length);
    setFailure(null);
    setStatus(first);
    announce(first);
    timer.current = setInterval(() => {
      if (!mounted.current) return;
      setStatus(STILL_WORKING);
      announce(STILL_WORKING);
    }, STILL_WORKING_MS);
    const stopTimer = () => {
      if (timer.current !== null) clearInterval(timer.current);
      timer.current = null;
    };

    client.analyze([...photos]).then(
      (result) => {
        stopTimer();
        if (!mounted.current) return;
        latest.current.saveResult(result);
        // Upload finished: the photos are no longer needed on the phone.
        latest.current.clear();
        announce('Label read. Opening the result.');
        router.dismissTo('/');
        router.push({ pathname: '/result/[id]', params: { id: result.id } });
      },
      (error: unknown) => {
        stopTimer();
        if (!mounted.current) return;
        const message = analyzeErrorMessage(error);
        setStatus(null);
        setFailure({ code: error instanceof ApiError ? error.code : null, message });
        announce(message);
      },
    );
  }, [attempt, client, router]);

  const home = () => {
    clear();
    router.dismissTo('/');
  };

  if (images.length === 0 && failure === null && status === null) {
    return (
      <Screen title="Reading the label">
        <Body>There are no photos to read.</Body>
        <BigButton label="Take a photo" onPress={() => router.replace('/scan')} />
        <BigButton label="Back to home" variant="secondary" onPress={home} />
      </Screen>
    );
  }

  if (failure !== null) {
    return (
      <Screen title="Reading the label">
        <Heading>The label was not read</Heading>
        <Notice>{failure.message}</Notice>
        <BigButton
          label="Try again"
          accessibilityHint="Sends the same photos again"
          onPress={() => setAttempt((a) => a + 1)}
        />
        <BigButton
          label="Back to photos"
          accessibilityHint="Retake, remove or add photos"
          variant="secondary"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/preview'))}
        />
        {failure.code === 'LIVE_BUDGET_EXHAUSTED' ? (
          <BigButton
            label="Open demo mode"
            accessibilityHint="Opens example scenarios with made-up data"
            variant="secondary"
            onPress={() => router.push('/demo')}
          />
        ) : null}
        <BigButton label="Back to home" variant="secondary" onPress={home} />
      </Screen>
    );
  }

  return (
    <Screen title="Reading the label">
      <Heading>Reading the label</Heading>
      <ActivityIndicator size="large" color={theme.colors.primary} accessibilityLabel="Working" />
      <Text
        accessibilityLiveRegion="polite"
        style={{ color: theme.colors.text, fontSize: theme.font(18) }}
      >
        {status}
      </Text>
      <Body muted>The photos are sent to the MediLens server and are not stored.</Body>
      <Body muted>{LIVE_MODE_PHOTOS}</Body>
    </Screen>
  );
}
