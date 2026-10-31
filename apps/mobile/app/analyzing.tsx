import type { AnalysisEvent } from '@medilens/contracts';
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
import { LIVE_MODE_PHOTOS, analyzeErrorMessage, isTerminalStage } from '../src/ui/text';

/** How long without a new stage before the screen re-announces that it is still working. */
export const STILL_WORKING_MS = 15_000;
const STILL_WORKING = 'Still reading the label. Please wait.';

/** The reminder once the server has reported a stage: it names that stage (final review M12). */
function stillWorkingOn(stageLabel: string) {
  return `Still working. ${stageLabel}`;
}

function startMessage(count: number) {
  return `Sending ${count} ${count === 1 ? 'photo' : 'photos'} and reading the label. This can take up to a minute.`;
}

function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message);
}

/**
 * Analysis progress: uploads the held photos once per attempt, then shows and
 * announces each stage the server reports until the result opens.
 */
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The analysis in flight. Leaving this screen (Back, Home) aborts it (final
  // review Minor 22): an upload still sending its photos stops there; once
  // the server has accepted it, polling stops and the client asks the server
  // to delete it (best effort), which cancels the server's work on it.
  const upload = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (upload.current !== null) {
        upload.current.abort();
        upload.current = null;
        // A remount (React StrictMode) sends this attempt again; a real unmount never remounts.
        started.current = -1;
      }
    };
  }, []);

  useEffect(() => {
    const photos: readonly PreparedImage[] = latest.current.images;
    // One upload at a time: a second Try again tap during an upload is ignored.
    if (started.current === attempt || photos.length === 0 || upload.current !== null) return;
    started.current = attempt;
    const controller = new AbortController();
    upload.current = controller;

    const first = startMessage(photos.length);
    setFailure(null);
    setStatus(first);
    announce(first);
    // The reminder comes STILL_WORKING_MS after the start or after the last
    // stage the server reported (final review M12). Before any stage it
    // replaces the start message; after one, the real stage stays on screen
    // and the reminder names it, so no step that is not running is claimed.
    // Only this attempt's own timer is ever cleared: under StrictMode an
    // aborted first attempt ends after the second one has started.
    let stage: string | null = null;
    let ended = false;
    let reminder: ReturnType<typeof setTimeout> | null = null;
    const remind = () => {
      if (reminder !== null) clearTimeout(reminder);
      reminder = setTimeout(() => {
        if (!mounted.current || ended) return;
        if (stage === null) {
          setStatus(STILL_WORKING);
          announce(STILL_WORKING);
        } else {
          announce(stillWorkingOn(stage));
        }
        remind();
      }, STILL_WORKING_MS);
      timer.current = reminder;
    };
    remind();
    /** Ends this attempt; false when it was aborted or the screen has gone. */
    const finish = () => {
      ended = true;
      if (reminder !== null) clearTimeout(reminder);
      if (timer.current === reminder) timer.current = null;
      if (upload.current === controller) upload.current = null;
      return mounted.current && !controller.signal.aborted;
    };

    // Go port spec §7: the server's own stage labels, shown and announced as
    // they arrive. The end of the analysis is announced by its outcome below.
    const onStage = (event: AnalysisEvent) => {
      if (!mounted.current || controller.signal.aborted || isTerminalStage(event.stage)) return;
      stage = event.label;
      setStatus(event.label);
      announce(event.label);
      remind();
    };

    client.analyze([...photos], { signal: controller.signal, onStage }).then(
      (result) => {
        if (!finish()) return;
        latest.current.saveResult(result);
        // Upload finished: the photos are no longer needed on the phone.
        latest.current.clear();
        announce('Label read. Opening the result.');
        router.dismissTo('/');
        router.push({ pathname: '/result/[id]', params: { id: result.id } });
      },
      (error: unknown) => {
        if (!finish()) return;
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
