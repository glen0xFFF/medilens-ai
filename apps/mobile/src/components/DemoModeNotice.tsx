import { useServerMode } from '../api/useServerMode';
import { DEMO_MODE_NOTICE } from '../ui/text';
import { Notice } from './Screen';

/**
 * Final review Minor 17: a server in demo mode answers every scan with a
 * made-up example, so the screens that start a scan say so before the user
 * photographs a real pack.
 */
export function DemoModeNotice() {
  return useServerMode() === 'demo' ? <Notice>{DEMO_MODE_NOTICE}</Notice> : null;
}
