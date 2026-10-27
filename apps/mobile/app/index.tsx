import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

/** Placeholder home route; the real welcome and home screens arrive with the screens task. */
export default function Index() {
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        MediLens AI
      </Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  title: { fontSize: 24, color: '#111111' },
});
