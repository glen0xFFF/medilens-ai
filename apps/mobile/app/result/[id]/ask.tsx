import type { Answer } from '@medilens/contracts';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, TextInput, View } from 'react-native';
import { useApi } from '../../../src/api/ApiContext';
import { BigButton } from '../../../src/components/BigButton';
import { DemoBanner } from '../../../src/components/DemoBanner';
import { Body, Heading, Notice, Screen } from '../../../src/components/Screen';
import { SpeechControls } from '../../../src/components/SpeechControls';
import { useResult, useResults } from '../../../src/state/results';
import { useSettings } from '../../../src/state/settings';
import { useTheme } from '../../../src/theme/theme';
import { messageFor } from '../../../src/ui/text';

/** The server's ExplainRequest limit. */
const MAX_QUESTION_LENGTH = 300;

/**
 * Ask about this label. The server's safety gate answers only label
 * questions it recognises, so its preset questions come first as buttons;
 * typing is the secondary path. Answers (including refusals) are shown and
 * spoken verbatim.
 */
export default function AskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { result } = useResult(id);
  const { getScenarioQuestion } = useResults();
  // The demo scenario's own question (s7), first, unless the server presets already have it.
  const scenarioQuestion = id === undefined ? undefined : getScenarioQuestion(id);
  const client = useApi();
  const settings = useSettings();
  const theme = useTheme();
  const focused = useIsFocused();

  const [presets, setPresets] = useState<string[] | null>(null);
  const [presetsError, setPresetsError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<{ n: number; value: Answer } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    client.presets().then(
      (list) => {
        if (active) setPresets(list);
      },
      (e: unknown) => {
        if (active) setPresetsError(messageFor(e));
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  async function ask(text: string) {
    const q = text.trim();
    if (id === undefined || q === '' || pending) return;
    setPending(true);
    setError(null);
    AccessibilityInfo.announceForAccessibility('Asking');
    try {
      const value = await client.explain(id, q);
      setAnswer((prev) => ({ n: (prev?.n ?? 0) + 1, value }));
      AccessibilityInfo.announceForAccessibility(value.text);
    } catch (e) {
      const message = messageFor(e);
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setPending(false);
    }
  }

  const c = theme.colors;
  const notice = answer?.value.safetyNotice ?? null;

  return (
    <Screen title="Ask a question">
      {result?.isDemo ? <DemoBanner /> : null}
      <Body>I can answer questions about what is printed on this label. Choose a question:</Body>

      {scenarioQuestion === undefined || presets?.includes(scenarioQuestion) ? null : (
        <BigButton
          label={scenarioQuestion}
          accessibilityHint="The question this demo example is built to show"
          variant="secondary"
          disabled={pending}
          onPress={() => void ask(scenarioQuestion)}
        />
      )}
      {presetsError === null ? null : <Notice>{presetsError}</Notice>}
      {presets === null && presetsError === null ? <Body muted>Loading questions…</Body> : null}
      {presets?.map((p) => (
        <BigButton
          key={p}
          label={p}
          variant="secondary"
          disabled={pending}
          onPress={() => void ask(p)}
        />
      ))}

      <Heading>Or type a question</Heading>
      <TextInput
        accessibilityLabel="Type a question about this label"
        value={question}
        onChangeText={setQuestion}
        maxLength={MAX_QUESTION_LENGTH}
        multiline
        placeholder="Type a question"
        placeholderTextColor={c.textMuted}
        style={[
          styles.input,
          {
            color: c.text,
            borderColor: c.border,
            backgroundColor: c.surface,
            fontSize: theme.font(18),
          },
        ]}
      />
      <BigButton
        label="Ask"
        disabled={pending || question.trim() === ''}
        onPress={() => void ask(question)}
      />

      {pending ? <Body muted>Asking…</Body> : null}
      {error === null ? null : <Notice>{error}</Notice>}
      {answer === null ? null : (
        <View style={[styles.answer, { borderColor: c.border }]}>
          <Heading>Answer</Heading>
          <Body>{answer.value.text}</Body>
          {notice !== null && notice !== answer.value.text ? <Body>{notice}</Body> : null}
          <SpeechControls
            key={answer.n}
            chunks={answer.value.spokenChunks}
            autoPlay={settings.loaded && settings.autoSpeak}
            active={focused}
          />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 56, borderWidth: 2, borderRadius: 10, padding: 12 },
  answer: { gap: 8, borderWidth: 2, borderRadius: 10, padding: 12 },
});
