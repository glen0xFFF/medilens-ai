import { useRouter } from 'expo-router';
import { BigButton } from '../src/components/BigButton';
import { Body, Heading, Screen } from '../src/components/Screen';

/** Safety and limitations: what the app does and does not do. */
export default function Safety() {
  const router = useRouter();
  return (
    <Screen title="Safety and limitations">
      <Heading>What MediLens AI does</Heading>
      <Body>
        It reads the printed text on a medicine label aloud and checks the name, strength and
        registration number against the Philippine FDA registry.
      </Body>
      <Body>Parts of a label it cannot read clearly are marked as unclear.</Body>

      <Heading>What it does not do</Heading>
      <Body>It is not a diagnostic tool and does not give medical advice.</Body>
      <Body>
        It does not tell you which medicine to take, how much to take, or whether a medicine is safe
        for you.
      </Body>
      <Body>It does not identify loose pills from how they look.</Body>
      <Body>Always confirm with a pharmacist or doctor.</Body>

      <Heading>About registry dates</Heading>
      <Body>
        The date shown with a registry record is when its registration certificate is valid until.
        It is not the expiry date of your medicine. Read the expiry date printed on the pack.
      </Body>

      <Heading>Privacy</Heading>
      <Body>
        Photos are sent to the MediLens server only to read the label and are not kept. Results are
        held in memory and are never saved on this phone.
      </Body>

      <BigButton label="Back to home" variant="secondary" onPress={() => router.dismissTo('/')} />
    </Screen>
  );
}
