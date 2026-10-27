import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';
import { AccessibilityInfo, Image, StyleSheet, View } from 'react-native';
import { useCaptures } from '../src/capture/captures';
import { BigButton } from '../src/components/BigButton';
import { Body, Heading, Screen } from '../src/components/Screen';
import { useTheme } from '../src/theme/theme';

/** Preview: check each photo, retake or remove it, then send them to be read. */
export default function Preview() {
  const theme = useTheme();
  const router = useRouter();
  const { images, remaining, remove, clear } = useCaptures();
  // One upload per tap (final review Minor 22): a second tap before the analyzing
  // screen opens is ignored; coming back to this screen allows sending again.
  const sending = useRef(false);
  useFocusEffect(
    useCallback(() => {
      sending.current = false;
    }, []),
  );
  const send = () => {
    if (sending.current) return;
    sending.current = true;
    router.push('/analyzing');
  };

  const cancel = () => {
    clear();
    router.dismissTo('/');
  };

  if (images.length === 0) {
    return (
      <Screen title="Check photos">
        <Body>There are no photos yet.</Body>
        <BigButton label="Take a photo" onPress={() => router.replace('/scan')} />
        <BigButton label="Back to home" variant="secondary" onPress={cancel} />
      </Screen>
    );
  }

  return (
    <Screen title="Check photos">
      <Heading>Check your photos</Heading>
      <Body>
        Make sure the label text is sharp, well lit and free of glare. Retake any photo that is
        blurry.
      </Body>
      {images.map((image, i) => (
        <View key={image.uri} style={styles.photo}>
          <Image
            source={{ uri: image.uri }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={`Photo ${i + 1} of ${images.length}`}
            resizeMode="contain"
            style={[styles.thumbnail, { borderColor: theme.colors.border }]}
          />
          <BigButton
            label={`Retake photo ${i + 1}`}
            accessibilityHint="Opens the camera to replace this photo"
            variant="secondary"
            onPress={() => router.replace({ pathname: '/scan', params: { retake: String(i) } })}
          />
          <BigButton
            label={`Remove photo ${i + 1}`}
            accessibilityHint="Deletes this photo"
            variant="secondary"
            onPress={() => {
              remove(i);
              AccessibilityInfo.announceForAccessibility(`Photo ${i + 1} removed.`);
            }}
          />
        </View>
      ))}
      {remaining > 0 ? (
        <BigButton
          label="Add another photo"
          accessibilityHint="Photograph another side of the pack"
          variant="secondary"
          onPress={() => router.replace('/scan')}
        />
      ) : null}
      <BigButton
        label="Analyze"
        accessibilityHint="Sends the photos to the MediLens server to read the label"
        onPress={send}
      />
      <BigButton
        label="Cancel"
        accessibilityHint="Deletes these photos and goes back home"
        variant="secondary"
        onPress={cancel}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  photo: { gap: 8 },
  thumbnail: { width: '100%', aspectRatio: 4 / 3, borderWidth: 2, borderRadius: 8 },
});
