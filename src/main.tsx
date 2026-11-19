/** Entry point. The lab implementation comes from src/ui/dev/createLab.ts (mock today, real engine later). */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import { App } from './ui/App.tsx';
import { createLab } from './ui/dev/createLab.ts';

const lab = createLab();
const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App lab={lab} />
    </StrictMode>,
  );
}
