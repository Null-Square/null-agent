import { createRoot } from 'react-dom/client';
// The brand fonts, served by this app so opening a page calls no one else: Inter 300 to 800, and
// Space Mono 400 and 700 with their italics (the weights the Google Fonts link used to load).
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/400-italic.css';
import '@fontsource/space-mono/700.css';
import '@fontsource/space-mono/700-italic.css';
import App from './App.tsx';
import './index.css';
import { metrics } from '@shared/lib/metrics';
import { purgeLegacyChatStorage } from '@modules/chat/lib/legacyChatStorage';
import { claimOwnerKeyFromLink } from '@modules/auth/api/ownerLink';

// Reclaims the origin quota an earlier build's chat transcripts still hold.
purgeLegacyChatStorage();

// The printed link carries the owner key in its fragment: trade it for the cookie before the app asks
// the backend anything.
void claimOwnerKeyFromLink().finally(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});

// Mark time-to-interactive after initial render
metrics.trackTTI();
