import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './index.css';
import './theme/spectrum.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
