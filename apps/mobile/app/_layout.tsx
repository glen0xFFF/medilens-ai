import { createApiClient } from '../src/api/client';
import { API_BASE_URL } from '../src/api/config';
import { AppProviders } from '../src/AppProviders';
import { AppStack } from '../src/AppStack';

// One client for the app's lifetime; it talks only to the MediLens server.
const client = createApiClient(API_BASE_URL);

export default function RootLayout() {
  return (
    <AppProviders client={client}>
      <AppStack />
    </AppProviders>
  );
}
