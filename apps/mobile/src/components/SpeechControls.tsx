import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSpeech } from '../speech/useSpeech';
import { useSettings } from '../state/settings';
import { useTheme } from '../theme/theme';
import { BigButton } from './BigButton';

export interface SpeechControlsProps {
  chunks: string[];
  /** Start speaking once, as soon as this is true (e.g. settings loaded and auto speak on). */
  autoPlay?: boolean;
  /**
   * False while the owning screen is not focused (another screen is on top
   * of it): speech stops, so two screens never talk over each other.
   */
  active?: boolean;
}

/** Play, pause/resume, repeat and stop over spoken chunks, at the user's speech rate. */
export function SpeechControls({ chunks, autoPlay = false, active = true }: SpeechControlsProps) {
  const theme = useTheme();
  const { speechRate } = useSettings();
  const speech = useSpeech({ rate: speechRate });
  const { load, play, stop } = speech;

  useEffect(() => {
    if (!active) stop();
  }, [active, stop]);
  // A value key, so a new array holding the same chunks does not reload and stop playback.
  const key = JSON.stringify(chunks);

  // Effects run in order: load the chunks, then (once) auto-play them.
  useEffect(() => {
    load(JSON.parse(key) as string[]);
  }, [load, key]);

  const autoPlayed = useRef(false);
  useEffect(() => {
    if (!autoPlay || autoPlayed.current || key === '[]') return;
    autoPlayed.current = true;
    play();
  }, [autoPlay, play, key]);

  const playing = speech.state === 'playing';
  const paused = speech.state === 'paused';
  const progress = playing
    ? `Reading part ${speech.index + 1} of ${speech.length}`
    : paused
      ? `Paused at part ${speech.index + 1} of ${speech.length}`
      : 'Not reading';

  return (
    <View style={styles.box}>
      <Text
        accessibilityLiveRegion="polite"
        style={{ color: theme.colors.textMuted, fontSize: theme.font(15) }}
      >
        {progress}
      </Text>
      <View style={styles.row}>
        <View style={styles.cell}>
          {paused ? (
            <BigButton label="Resume" onPress={speech.resume} />
          ) : (
            <BigButton label="Play" onPress={play} disabled={playing} />
          )}
        </View>
        <View style={styles.cell}>
          <BigButton label="Pause" onPress={speech.pause} disabled={!playing} variant="secondary" />
        </View>
        <View style={styles.cell}>
          <BigButton label="Repeat" onPress={speech.repeat} variant="secondary" />
        </View>
        <View style={styles.cell}>
          <BigButton label="Stop" onPress={speech.stop} variant="secondary" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { flexGrow: 1, flexBasis: 120 },
});
